import { buildApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { docsEnabled, loadConfig, securityWarnings } from "./config.js";
import { LocalFileStore } from "./infra/file-store.js";
import { createLogger } from "./infra/logger.js";
import { createMailer } from "./infra/mailer.js";
import { purgeExpired } from "./services/auth.js";

// Created before start-up so that a failed migration or database connection is logged too.
const logger = createLogger(loadConfig());

// Anything that escapes a request handler is a bug: record it, then let the process manager restart.
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});

const { cfg, db, frameworks } = await bootstrap({}, undefined, logger).catch((err: unknown) => {
  logger.fatal({ err }, "start-up failed");
  process.exit(1);
});

for (const w of securityWarnings(cfg)) logger.warn({ event: "config.insecure" }, w);

// Expired sign-in links and sessions, and accounts nobody ever signed in to, are deleted at
// start-up and then every few hours. A failure is logged and retried next time.
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const purge = () =>
  purgeExpired(db, { idleDays: cfg.sessionIdleDays, unverifiedDays: 30 })
    .then((r) => logger.info({ event: "maintenance.purge", ...r }, "expired auth data purged"))
    .catch((err: unknown) => logger.error({ err }, "purge of expired auth data failed"));
void purge();
setInterval(purge, PURGE_EVERY_MS).unref();

const app = await buildApp({
  cfg,
  db,
  frameworks,
  files: new LocalFileStore(cfg.filesDir),
  mailer: createMailer(cfg, logger),
  logger,
});

// Below Docker's 10 s stop timeout, so we log and exit ourselves instead of being killed mid-write.
const SHUTDOWN_TIMEOUT_MS = 8000;
let shuttingDown = false;

// app.close() stops accepting connections, answers 503 on kept-alive ones and waits for in-flight
// requests; only then is the database pool closed.
const close = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "requests still running at shutdown timeout; exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await app.close();
    await db.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "shutdown failed");
    process.exit(1);
  }
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: cfg.port, host: "0.0.0.0" });
const apiDocs = docsEnabled(cfg)
  ? `${cfg.publicUrl.replace(/\/$/, "")}/api/docs (password protected)`
  : cfg.apiDocs
    ? "off (set API_DOCS_PASSWORD)"
    : "off";
logger.info({ publicUrl: cfg.publicUrl, appUrl: cfg.appUrl, database: db.kind, apiDocs }, "NAAC Assistant started");
