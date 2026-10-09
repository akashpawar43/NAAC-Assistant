// Health checks, magic-link sign-in, sign-out and the signed-in user.
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { pendingMigrations } from "../db/migrate.js";
import { docs, tagRoutes } from "../http/docs.js";
import { LOGIN_COOKIE, SESSION_COOKIE, cookieName, parse, requireUser } from "../http/helpers.js";
import { deleteAccount } from "../services/account.js";
import {
  endAllSessions,
  endSession,
  hashSecret,
  memberships,
  newSecret,
  peekMagicLink,
  requestMagicLink,
  verifyMagicLink,
} from "../services/auth.js";
import { AppError, badRequest } from "../services/errors.js";
import type { RouteDeps } from "./shared.js";

const MagicLinkBody = z.object({ email: z.string().max(254) });
const Token = z.string().min(10).max(200);
const VerifyQuery = z.object({ token: Token });
const TokenBody = z.object({ token: Token });
const DeleteAccountBody = z.object({ confirm_email: z.string().max(254) });
/** What the login cookie holds: a value this server generated (base64url, 32 bytes). */
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const LINK_MINUTES = 15;
const invalidLink = () => new AppError(400, "invalid_link", "This sign-in link is invalid or has expired. Ask for a new one.");

export const authRoutes: FastifyPluginAsync<RouteDeps> = async (app, { cfg, db, mailer, files, appBase, frameworks }) => {
  tagRoutes(app, "Auth");
  const cookieBase = { path: "/", httpOnly: true, sameSite: cfg.cookieSameSite, secure: cfg.secureCookies } as const;
  const SESSION = cookieName(SESSION_COOKIE, cfg.secureCookies);
  const LOGIN = cookieName(LOGIN_COOKIE, cfg.secureCookies);

  const startSession = async (reply: FastifyReply, token: string) => {
    const s = await verifyMagicLink(db, token, cfg.sessionDays);
    reply.setCookie(SESSION, s.sessionId, { ...cookieBase, maxAge: cfg.sessionDays * 86400 });
    reply.clearCookie(LOGIN, cookieBase);
    return s;
  };

  // Liveness: the process answers. It never touches the database, so a database outage does not get
  // healthy app processes restarted.
  app.get("/health", docs({ summary: "Liveness: the server process is up", isPublic: true }), async () => ({ ok: true }));

  // Readiness: safe to send traffic. 503 names the check that failed. Frameworks are loaded once at
  // start-up, so "missing" means they were never imported (npm run import-frameworks, then restart).
  app.get(
    "/ready",
    docs({ summary: "Readiness: database reachable, every migration applied and frameworks loaded", isPublic: true }),
    async (req, reply) => {
      const fw = frameworks.list().length ? "ok" : "missing";
      try {
        const pending = await pendingMigrations(db);
        const body = { ok: !pending.length && fw === "ok", database: "ok", migrations: pending.length ? "pending" : "ok", frameworks: fw };
        if (body.ok) return body;
        return reply.status(503).send(pending.length ? { ...body, pending } : body);
      } catch (err) {
        req.log.warn({ err }, "readiness check: database unavailable");
        return reply.status(503).send({ ok: false, database: "unavailable", migrations: "unknown", frameworks: fw });
      }
    },
  );

  app.post(
    "/auth/magic-link",
    {
      ...docs({
        summary: "Email a sign-in link",
        description:
          "Always answers the same way, whether or not the email has an account. Also sets a short-lived login cookie: " +
          "opening the link in this browser signs in directly; anywhere else asks for confirmation first.",
        body: MagicLinkBody,
        isPublic: true,
      }),
      config: { rateLimit: { max: cfg.authRateLimitPerMin, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const body = parse(MagicLinkBody, req.body);
      // One nonce per browser, so several links requested from it all open directly.
      const existing = req.cookies[LOGIN];
      const nonce = existing && NONCE_RE.test(existing) ? existing : newSecret();
      reply.setCookie(LOGIN, nonce, { ...cookieBase, maxAge: LINK_MINUTES * 60 });
      const { sent } = await requestMagicLink(db, mailer, cfg.publicUrl, body.email, { maxOutstanding: cfg.magicLinksPerAddress, nonceHash: hashSecret(nonce) });
      req.log.info({ event: sent ? "auth.link_requested" : "auth.link_suppressed" }, "sign-in link requested");
      return { ok: true, message: "If this email is registered, a sign-in link has been sent." };
    },
  );

  app.get(
    "/auth/verify",
    {
      ...docs({
        summary: "Open a sign-in link",
        description:
          "In the browser that asked for the link: sets the session cookie and redirects to the app (APP_URL). " +
          "Anywhere else (another browser, a mail scanner) the link is not used: it redirects to the app's confirmation " +
          "page (`/login/confirm#token=…`), which completes sign-in with `POST /auth/verify`. On failure, redirects with `?login_error=<code>`.",
        querystring: VerifyQuery,
        isPublic: true,
      }),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const q = parse(VerifyQuery, req.query);
      const link = await peekMagicLink(db, q.token, req.cookies[LOGIN]);
      if (!link) {
        req.log.info({ event: "auth.login_failed", reason: "invalid_link" }, "sign-in link rejected");
        return reply.redirect(`${appBase}/?login_error=invalid_link`);
      }
      if (!link.sameBrowser) {
        // The token goes in the fragment, which browsers never send to a server or in a Referer.
        return reply.redirect(`${appBase}/login/confirm#token=${encodeURIComponent(q.token)}`);
      }
      try {
        const s = await startSession(reply, q.token);
        req.log.info({ event: "auth.login", userId: s.userId, via: "link" }, "signed in");
        return reply.redirect(`${appBase}/`);
      } catch (e) {
        if (e instanceof AppError) return reply.redirect(`${appBase}/?login_error=${encodeURIComponent(e.code)}`);
        throw e;
      }
    },
  );

  app.post(
    "/auth/link-info",
    {
      ...docs({ summary: "Which account a sign-in link is for (without using it)", body: TokenBody, isPublic: true }),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req) => {
      const b = parse(TokenBody, req.body);
      const link = await peekMagicLink(db, b.token, undefined);
      if (!link) throw invalidLink();
      return { email: link.email };
    },
  );

  app.post(
    "/auth/verify",
    {
      ...docs({ summary: "Confirm a sign-in link opened in another browser", body: TokenBody, isPublic: true }),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const b = parse(TokenBody, req.body);
      try {
        const s = await startSession(reply, b.token);
        req.log.info({ event: "auth.login", userId: s.userId, via: "confirm" }, "signed in");
        return { ok: true };
      } catch (e) {
        if (e instanceof AppError) req.log.info({ event: "auth.login_failed", reason: e.code }, "sign-in link rejected");
        throw e;
      }
    },
  );

  app.post("/auth/logout", docs({ summary: "Sign out" }), async (req, reply) => {
    await endSession(db, req.cookies[SESSION]);
    if (req.user) req.log.info({ event: "auth.logout", userId: req.user.id }, "signed out");
    // Same attributes as when set: a cross-site response may only change a SameSite=None cookie.
    reply.clearCookie(SESSION, cookieBase);
    return { ok: true };
  });

  app.post("/auth/logout-all", docs({ summary: "Sign out on every device" }), async (req, reply) => {
    const u = requireUser(req);
    const sessions = await endAllSessions(db, u.id);
    req.log.info({ event: "auth.logout_all", userId: u.id, sessions }, "signed out everywhere");
    reply.clearCookie(SESSION, cookieBase);
    return { ok: true, sessions };
  });

  app.get("/me", docs({ summary: "The signed-in user and their workspaces" }), async (req) => {
    const u = requireUser(req);
    return { user: u, memberships: await memberships(db, u.id) };
  });

  app.delete(
    "/me",
    docs({
      summary: "Delete my account",
      description:
        "Permanently deletes the account, its own workspace with every report and evidence file in it, and its access to " +
        "other workspaces and reports. Send the account's email as `confirm_email`.",
      body: DeleteAccountBody,
    }),
    async (req, reply) => {
      const u = requireUser(req);
      const b = parse(DeleteAccountBody, req.body);
      if (b.confirm_email.trim().toLowerCase() !== u.email) throw badRequest("confirm_email must be your account's email address");
      const r = await deleteAccount(db, files, u.id);
      req.log.info({ event: "account.deleted", userId: u.id, ...r }, "account deleted");
      reply.clearCookie(SESSION, cookieBase);
      return { ok: true };
    },
  );
};
