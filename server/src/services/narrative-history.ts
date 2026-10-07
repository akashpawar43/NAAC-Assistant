// Version history for narratives. Autosave runs every few seconds, so saves by the same person
// within SESSION_MINUTES of their last version update that version instead of adding a new one:
// one version is roughly one editing session.
import type { Db } from "../db/client.js";
import { wordCount } from "../domain/narrative.js";

export const SESSION_MINUTES = 5;
export const MAX_VERSIONS = 50;

export interface VersionSummary {
  id: number;
  saved_at: string;
  saved_by: string | null;
  words: number;
  preview: string;
}

const sameFields = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? "") === (b[k] ?? ""));
};

/** Records the entry's current narrative fields. Call inside the same transaction as the save. */
export async function recordVersion(db: Db, entryId: string, collegeId: string, userId: string): Promise<void> {
  const current = Object.fromEntries(
    (await db.query<{ field_key: string; text: string }>("SELECT field_key, text FROM narrative_field WHERE entry_id = $1", [entryId])).rows.map(
      (r) => [r.field_key, r.text],
    ),
  );
  const latest = (
    await db.query<{ id: number; fields: Record<string, string>; saved_by: string | null; recent: boolean }>(
      `SELECT id, fields, saved_by, saved_at > now() - make_interval(mins => $2) AS recent
       FROM narrative_version WHERE entry_id = $1 ORDER BY saved_at DESC, id DESC LIMIT 1`,
      [entryId, SESSION_MINUTES],
    )
  ).rows[0];
  if (latest && sameFields(latest.fields, current)) return;
  if (latest && latest.recent && latest.saved_by === userId) {
    await db.query("UPDATE narrative_version SET fields = $1::jsonb, saved_at = now() WHERE id = $2", [JSON.stringify(current), latest.id]);
    return;
  }
  await db.query("INSERT INTO narrative_version (entry_id, college_id, fields, saved_by) VALUES ($1, $2, $3::jsonb, $4)", [
    entryId,
    collegeId,
    JSON.stringify(current),
    userId,
  ]);
  await db.query(
    `DELETE FROM narrative_version WHERE entry_id = $1 AND id NOT IN (
       SELECT id FROM narrative_version WHERE entry_id = $1 ORDER BY saved_at DESC, id DESC LIMIT $2)`,
    [entryId, MAX_VERSIONS],
  );
}

export async function listVersions(db: Db, entryId: string, collegeId: string): Promise<VersionSummary[]> {
  const rows = (
    await db.query<{ id: number; saved_at: string; email: string | null; fields: Record<string, string> }>(
      `SELECT v.id, v.saved_at, u.email, v.fields FROM narrative_version v LEFT JOIN app_user u ON u.id = v.saved_by
       WHERE v.entry_id = $1 AND v.college_id = $2 ORDER BY v.saved_at DESC, v.id DESC`,
      [entryId, collegeId],
    )
  ).rows;
  return rows.map((r) => {
    const text = Object.values(r.fields).join(" ");
    return { id: r.id, saved_at: r.saved_at, saved_by: r.email, words: wordCount(text), preview: text.trim().slice(0, 160) };
  });
}

export async function getVersion(db: Db, entryId: string, collegeId: string, versionId: number): Promise<Record<string, string> | null> {
  const r = await db.query<{ fields: Record<string, string> }>("SELECT fields FROM narrative_version WHERE id = $1 AND entry_id = $2 AND college_id = $3", [
    versionId,
    entryId,
    collegeId,
  ]);
  return r.rows[0]?.fields ?? null;
}
