import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Repository root (holds .env and client/); same from src/ (dev) and dist/ (build).
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

// Load ./.env once (Node's built-in loader), so every entry point (dev server, scripts,
// compiled build) sees the same settings. Real environment variables win over the file.
const ENV_FILE = resolve(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export type CookieSameSite = "lax" | "strict" | "none";
const COOKIE_SAME_SITE: readonly CookieSameSite[] = ["lax", "strict", "none"];
export type LogFormat = "pretty" | "json";
const LOG_FORMATS: readonly LogFormat[] = ["pretty", "json"];
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export interface Config {
  port: number;
  /** Where this API is reached; sign-in links and links inside exported reports point here. */
  publicUrl: string;
  /** Where the client (web app) is served. Same as publicUrl unless the client is hosted elsewhere. */
  appUrl: string;
  databaseUrl: string;
  pgliteDir: string;
  filesDir: string;
  contentDir: string;
  clientDist: string;
  smtp: { host: string; port: number; user: string; pass: string; from: string };
  sessionDays: number;
  /** A session also ends after this many days without use (SESSION_IDLE_DAYS). */
  sessionIdleDays: number;
  secureCookies: boolean;
  /**
   * Which peers may set X-Forwarded-For (TRUST_PROXY): "true", "false", a hop count, or
   * comma-separated addresses / CIDRs / loopback, linklocal, uniquelocal.
   */
  trustProxy: boolean | number | string;
  /** "none" is only needed when the client and API are on different sites (not just subdomains). */
  cookieSameSite: CookieSameSite;
  maxUploadBytes: number;
  /** Total evidence bytes one workspace may store (EVIDENCE_QUOTA_MB). */
  evidenceQuotaBytes: number;
  authRateLimitPerMin: number;
  /** Sign-in links that may be outstanding (unused, unexpired) for one address at a time. */
  magicLinksPerAddress: number;
  /** Share notices one account may trigger per 24 hours. */
  shareEmailsPerDay: number;
  /** pino level; "silent" turns logging off. */
  logLevel: (typeof LOG_LEVELS)[number];
  /** "pretty" for people reading a terminal, "json" (one object per line) for log collectors. */
  logFormat: LogFormat;
  /** Serve the OpenAPI spec and Swagger UI at /api/docs (only when apiDocsPassword is set too). */
  apiDocs: boolean;
  /** HTTP Basic credentials for /api/docs (API_DOCS_USER, API_DOCS_PASSWORD). No password, no docs. */
  apiDocsUser: string;
  apiDocsPassword: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const fromRoot = (p: string) => resolve(ROOT, p);
  const publicUrl = overrides.publicUrl ?? env("PUBLIC_URL", "http://localhost:8080");
  const nodeEnv = process.env.NODE_ENV;
  const cfg: Config = {
    port: Number(env("PORT", "8080")),
    publicUrl,
    appUrl: env("APP_URL", publicUrl),
    databaseUrl: env("DATABASE_URL"),
    pgliteDir: fromRoot(env("PGLITE_DIR", "./data/pgdata")),
    filesDir: fromRoot(env("FILES_DIR", "./data/files")),
    contentDir: fromRoot("server/content"),
    clientDist: fromRoot("client/dist"),
    smtp: {
      host: env("SMTP_HOST"),
      port: Number(env("SMTP_PORT", "587")),
      user: env("SMTP_USER"),
      pass: env("SMTP_PASS"),
      from: env("MAIL_FROM", "NAAC Assistant <no-reply@localhost>"),
    },
    sessionDays: Number(env("SESSION_DAYS", "30")),
    sessionIdleDays: Math.floor(positiveNumber("SESSION_IDLE_DAYS", env("SESSION_IDLE_DAYS", "14"))),
    secureCookies: publicUrl.startsWith("https://"),
    // Private and loopback peers only (a reverse proxy on the same host or Docker network); a
    // client connecting directly cannot choose its own address for rate limiting.
    trustProxy: parseTrustProxy(env("TRUST_PROXY", "loopback,linklocal,uniquelocal")),
    cookieSameSite: oneOf("COOKIE_SAMESITE", env("COOKIE_SAMESITE", "lax"), COOKIE_SAME_SITE),
    maxUploadBytes: 10 * 1024 * 1024,
    evidenceQuotaBytes: positiveNumber("EVIDENCE_QUOTA_MB", env("EVIDENCE_QUOTA_MB", "2048")) * 1024 * 1024,
    authRateLimitPerMin: 5,
    magicLinksPerAddress: 3,
    shareEmailsPerDay: 50,
    logLevel: oneOf("LOG_LEVEL", env("LOG_LEVEL", nodeEnv === "test" ? "silent" : "info"), LOG_LEVELS),
    logFormat: oneOf("LOG_FORMAT", env("LOG_FORMAT", nodeEnv === "production" ? "json" : "pretty"), LOG_FORMATS),
    apiDocs: oneOf("API_DOCS", env("API_DOCS", nodeEnv === "production" ? "false" : "true"), ["true", "false"]) === "true",
    apiDocsUser: env("API_DOCS_USER", "docs"),
    // Read raw (not trimmed by env()): spaces may be part of a password.
    apiDocsPassword: process.env.API_DOCS_PASSWORD ?? "",
    ...overrides,
  };
  validate(cfg);
  return cfg;
}

function parseTrustProxy(v: string): boolean | number | string {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function positiveNumber(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number (got "${value}")`);
  return n;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const v = value.toLowerCase();
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
  return v as T;
}

export const MIN_DOCS_PASSWORD = 12;

/** The docs are served only when they are turned on and protected by a password. */
export const docsEnabled = (cfg: Pick<Config, "apiDocs" | "apiDocsPassword">) => cfg.apiDocs && !!cfg.apiDocsPassword;

function validate(cfg: Config): void {
  for (const [name, url] of [["PUBLIC_URL", cfg.publicUrl], ["APP_URL", cfg.appUrl]]) {
    if (!URL.canParse(url)) throw new Error(`${name} must be an absolute URL (got "${url}")`);
  }
  // Browsers drop SameSite=None cookies that are not also Secure, so sign-in would silently fail.
  if (cfg.cookieSameSite === "none" && !cfg.secureCookies) {
    throw new Error("COOKIE_SAMESITE=none needs an https:// PUBLIC_URL");
  }
  // The docs describe every endpoint; a guessable password would make them public.
  if (cfg.apiDocsPassword && cfg.apiDocsPassword.length < MIN_DOCS_PASSWORD) {
    throw new Error(`API_DOCS_PASSWORD must be at least ${MIN_DOCS_PASSWORD} characters`);
  }
  if (cfg.apiDocsPassword && !cfg.apiDocsUser) throw new Error("API_DOCS_USER must not be empty");
}

/**
 * Settings that work but are unsafe, as messages for the start-up log. Nothing here is fatal:
 * these are deployment decisions, so the server only says so loudly.
 */
export function securityWarnings(cfg: Config, nodeEnv = process.env.NODE_ENV): string[] {
  const out: string[] = [];
  if (cfg.databaseUrl && URL.canParse(cfg.databaseUrl)) {
    const u = new URL(cfg.databaseUrl);
    const mode = u.searchParams.get("sslmode");
    const libpq = u.searchParams.get("uselibpqcompat") === "true";
    const local = ["localhost", "127.0.0.1", "::1", "db"].includes(u.hostname);
    // With libpq semantics, require / prefer / allow (and verify-ca without a CA) encrypt but
    // never check who is on the other end, so a man in the middle sees every query and password.
    if (!local && libpq && (!mode || ["disable", "allow", "prefer", "require"].includes(mode))) {
      out.push(`DATABASE_URL uses sslmode=${mode ?? "(none)"} with uselibpqcompat=true: the database server's certificate is NOT verified. Use sslmode=verify-full&sslrootcert=<CA file>.`);
    }
    if (!local && !libpq && mode === "disable") out.push("DATABASE_URL disables TLS to a remote database.");
    if (["avnadmin", "postgres"].includes(decodeURIComponent(u.username))) {
      out.push(`DATABASE_URL signs in as the administrator "${decodeURIComponent(u.username)}". Use a role limited to this app's tables.`);
    }
    if (!local && nodeEnv !== "production") {
      out.push(`A remote database (${u.hostname}) is used outside production (NODE_ENV=${nodeEnv ?? "unset"}). If it holds real users' data, use a separate development database.`);
    }
  }
  if (nodeEnv === "production" && !cfg.secureCookies) out.push("PUBLIC_URL is not https in production: cookies are sent without Secure.");
  if (cfg.apiDocs && !cfg.apiDocsPassword) out.push("API_DOCS is on but API_DOCS_PASSWORD is not set: /api/docs is not served. Set a password to use the docs.");
  if (cfg.trustProxy === true) out.push("TRUST_PROXY=true trusts X-Forwarded-For from any client; per-IP rate limits can be bypassed. List your proxy instead.");
  return out;
}

/** The origin (scheme://host:port) of a configured URL. */
export const originOf = (url: string) => new URL(url).origin;
