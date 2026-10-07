// Passwordless sign-in with one-time magic links. Open sign-up: any email gets an account, and the
// first successful sign-in creates the user's private workspace.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.js";
import type { Mailer } from "../infra/mailer.js";
import { AppError, badRequest } from "./errors.js";

const TOKEN_MINUTES = 15;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export type Role = "iqac_admin" | "editor" | "dept_editor" | "viewer";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw badRequest("Enter a valid email address");
  return e;
}

/**
 * Sends a sign-in link to any email; a new email becomes an (unverified) account. The account is
 * only usable after the link is opened, which proves the person owns the address.
 */
export async function requestMagicLink(
  db: Db,
  mailer: Mailer,
  publicUrl: string,
  emailRaw: string,
  opts: { maxOutstanding?: number; nonceHash?: string | null } = {},
): Promise<{ sent: boolean }> {
  const email = normalizeEmail(emailRaw);
  const u = { id: await upsertUser(db, email) };
  // A few unused links per address at most: the caller's answer is the same either way, so this
  // stops one address being flooded with sign-in emails without revealing whether it exists.
  if (opts.maxOutstanding !== undefined) {
    const open = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM login_token WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()", [u.id]);
    if (open.rows[0].n >= opts.maxOutstanding) return { sent: false };
  }
  const t = token();
  await db.query("INSERT INTO login_token (token_hash, user_id, expires_at, nonce_hash) VALUES ($1, $2, now() + make_interval(mins => $3), $4)", [
    hash(t),
    u.id,
    TOKEN_MINUTES,
    opts.nonceHash ?? null,
  ]);
  const link = `${publicUrl.replace(/\/$/, "")}/api/v1/auth/verify?token=${encodeURIComponent(t)}`;

  await mailer.send(
    email,
    "Your sign-in link for NAAC Assistant",
    `Open this link to sign in (valid for ${TOKEN_MINUTES} minutes, works once):\n\n${link}\n\nIf you did not ask for it, ignore this email.`,
  );
  return { sent: true };
}

/** Exchanges a magic-link token for a new session id (returned in clear once, stored hashed). */
export async function verifyMagicLink(db: Db, t: string, sessionDays: number): Promise<{ sessionId: string; userId: string }> {
  return db.tx(async (tx) => {
    const row = (
      await tx.query<{ user_id: string }>(
        "UPDATE login_token SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
        [hash(t)],
      )
    ).rows[0];
    if (!row) throw new AppError(400, "invalid_link", "This sign-in link is invalid or has expired. Ask for a new one.");
    await tx.query("UPDATE app_user SET verified_at = COALESCE(verified_at, now()) WHERE id = $1", [row.user_id]);
    await ensurePersonalWorkspace(tx, row.user_id);
    const sessionId = token();
    await tx.query("INSERT INTO user_session (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [
      hash(sessionId),
      row.user_id,
      sessionDays,
    ]);
    return { sessionId, userId: row.user_id };
  });
}

/** A fresh random secret (login nonce) and the hash stored for it. */
export const newSecret = token;
export const hashSecret = hash;

/** Hashes are hex SHA-256: equal length, compared in constant time. */
function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Looks at a sign-in link without using it: who it is for, and whether `nonce` (the login cookie
 * of the browser opening it) is the one set when the link was requested. Null when the link is
 * unknown, used or expired.
 */
export async function peekMagicLink(db: Db, t: string, nonce: string | undefined): Promise<{ userId: string; email: string; sameBrowser: boolean } | null> {
  const row = (
    await db.query<{ user_id: string; email: string; nonce_hash: string | null }>(
      `SELECT t.user_id, u.email, t.nonce_hash FROM login_token t JOIN app_user u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [hash(t)],
    )
  ).rows[0];
  if (!row) return null;
  const sameBrowser = !!(nonce && row.nonce_hash && sameHash(hash(nonce), row.nonce_hash));
  return { userId: row.user_id, email: row.email, sameBrowser };
}

/**
 * The signed-in user for a session cookie. A session ends `idleDays` after it was last used, as
 * well as at its fixed expiry. last_seen_at is written at most hourly, not on every request.
 */
export async function userForSession(db: Db, sessionId: string | undefined, idleDays = 14): Promise<SessionUser | null> {
  if (!sessionId) return null;
  const h = hash(sessionId);
  const r = await db.query<SessionUser & { stale: boolean }>(
    `SELECT u.id, u.email, u.name, s.last_seen_at < now() - interval '1 hour' AS stale
     FROM user_session s JOIN app_user u ON u.id = s.user_id
     WHERE s.id_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(days => $2)`,
    [h, idleDays],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.stale) await db.query("UPDATE user_session SET last_seen_at = now() WHERE id_hash = $1", [h]);
  return { id: row.id, email: row.email, name: row.name };
}

export async function endSession(db: Db, sessionId: string | undefined): Promise<void> {
  if (sessionId) await db.query("DELETE FROM user_session WHERE id_hash = $1", [hash(sessionId)]);
}

/** Signs the user out on every device. */
export async function endAllSessions(db: Db, userId: string): Promise<number> {
  return (await db.query("DELETE FROM user_session WHERE user_id = $1 RETURNING id_hash", [userId])).rows.length;
}

/**
 * Deletes what is no longer needed: used or expired sign-in links, ended sessions, and accounts
 * that were only ever asked for (never signed in, never added to a workspace or report) after
 * `unverifiedDays`. Run periodically (main.ts).
 */
export async function purgeExpired(db: Db, opts: { idleDays: number; unverifiedDays: number }): Promise<{ tokens: number; sessions: number; users: number }> {
  const tokens = (await db.query("DELETE FROM login_token WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day' RETURNING token_hash")).rows.length;
  const sessions = (
    await db.query("DELETE FROM user_session WHERE expires_at < now() OR last_seen_at < now() - make_interval(days => $1) RETURNING id_hash", [opts.idleDays])
  ).rows.length;
  const users = (
    await db.query(
      `DELETE FROM app_user u WHERE u.verified_at IS NULL AND u.created_at < now() - make_interval(days => $1)
         AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM report_share s WHERE s.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM college c WHERE c.owner_id = u.id)
         -- verified_at only exists since migration 003: an older account with a session is in use.
         AND NOT EXISTS (SELECT 1 FROM user_session s WHERE s.user_id = u.id)
       RETURNING u.id`,
      [opts.unverifiedDays],
    )
  ).rows.length;
  return { tokens, sessions, users };
}

/**
 * The id of the account with this email, creating it if needed. `name` is only stored for a new
 * account: an existing person's name is theirs, and another workspace must not change it.
 */
export async function upsertUser(db: Db, emailRaw: string, name?: string): Promise<string> {
  const email = normalizeEmail(emailRaw);
  const r = await db.query<{ id: string }>(
    // The no-op update makes RETURNING give the existing row's id; it never touches other columns.
    "INSERT INTO app_user (id, email, name) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET email = app_user.email RETURNING id",
    [randomUUID(), email, name ?? null],
  );
  return r.rows[0].id;
}

/** Every user owns exactly one private workspace; created on first sign-in. */
export async function ensurePersonalWorkspace(db: Db, userId: string): Promise<string> {
  const existing = (await db.query<{ id: string }>("SELECT id FROM college WHERE owner_id = $1", [userId])).rows[0];
  if (existing) return existing.id;
  // Accounts from before open sign-up: adopt the college they administer, keeping its reports.
  const adopted = (
    await db.query<{ id: string }>(
      `UPDATE college SET owner_id = $1 WHERE id = (
         SELECT c.id FROM college c JOIN membership m ON m.college_id = c.id
         WHERE m.user_id = $1 AND m.role = 'iqac_admin' AND c.owner_id IS NULL ORDER BY c.created_at LIMIT 1)
       RETURNING id`,
      [userId],
    )
  ).rows[0];
  if (adopted) return adopted.id;
  const id = randomUUID();
  await db.query(
    "INSERT INTO college (id, name, owner_id) SELECT $1, 'My workspace', $2 ON CONFLICT (owner_id) WHERE owner_id IS NOT NULL DO NOTHING",
    [id, userId],
  );
  const ws = (await db.query<{ id: string }>("SELECT id FROM college WHERE owner_id = $1", [userId])).rows[0];
  await db.query("INSERT INTO membership (user_id, college_id, role) VALUES ($1, $2, 'iqac_admin') ON CONFLICT DO NOTHING", [userId, ws.id]);
  return ws.id;
}

export interface Membership {
  college_id: string;
  college_name: string;
  role: Role;
  department: string | null;
  /** The user's own private workspace (others are workspaces shared with them). */
  owned: boolean;
}

export async function memberships(db: Db, userId: string): Promise<Membership[]> {
  return (
    await db.query<Membership>(
      `SELECT m.college_id, c.name AS college_name, m.role, m.department, (c.owner_id = m.user_id) IS TRUE AS owned
       FROM membership m JOIN college c ON c.id = m.college_id WHERE m.user_id = $1 ORDER BY owned DESC, c.name`,
      [userId],
    )
  ).rows;
}
