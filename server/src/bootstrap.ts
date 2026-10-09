// Shared start-up: connect, migrate, load the imported frameworks and seed help content.
import { mkdirSync } from "node:fs";
import { loadConfig, type Config } from "./config.js";
import { connectPg, connectPglite, type Db } from "./db/client.js";
import { createLogger, type Logger } from "./infra/logger.js";
import { migrate } from "./db/migrate.js";
import { FrameworkRegistry, seedHelp } from "./services/frameworks.js";

export async function openDb(cfg: Config): Promise<Db> {
  if (cfg.databaseUrl) return connectPg(cfg.databaseUrl);
  // An empty pgliteDir means an in-memory database (tests).
  if (cfg.pgliteDir) mkdirSync(cfg.pgliteDir, { recursive: true });
  return connectPglite(cfg.pgliteDir || undefined);
}

// Any fixed number works; every server instance must use the same one.
const STARTUP_LOCK_ID = 4_217_663_001;

/**
 * Runs `fn` in one transaction that first takes a database-wide advisory lock and applies any new
 * migration, so server instances that start together, and framework imports, take turns instead
 * of changing the same rows at once. The lock is released when the transaction ends, even on error.
 */
export async function withStartupLock<T>(db: Db, log: (m: string) => void, fn: (t: Db) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await t.query("SELECT pg_advisory_xact_lock($1)", [STARTUP_LOCK_ID]);
    await migrate(t, log);
    return fn(t);
  });
}

async function prepareDatabase(db: Db, cfg: Config, log: (m: string) => void): Promise<FrameworkRegistry> {
  return withStartupLock(db, log, async (t) => {
    const frameworks = await FrameworkRegistry.fromDb(t, log);
    if (frameworks.list().length) {
      for (const fw of frameworks.list()) log(`framework ${fw.id} v${fw.version}: ${fw.metrics.length} metrics`);
    } else {
      log("no frameworks in the database: import them with npm run import-frameworks -- <dir>; /ready answers 503 until then");
    }
    await seedHelp(t, cfg.contentDir, log);
    return frameworks;
  });
}

/**
 * `log` overrides where start-up progress goes (tests pass a no-op); by default it is the logger.
 * Pass `logger` when it must exist before start-up, so a failure here can still be logged.
 */
export async function bootstrap(overrides: Partial<Config> = {}, log?: (m: string) => void, logger?: Logger) {
  const cfg = loadConfig(overrides);
  logger ??= createLogger(cfg);
  const startupLog = log ?? ((m: string) => logger.info(m));
  const db = await openDb(cfg);
  const frameworks = await prepareDatabase(db, cfg, startupLog);
  return { cfg, db, frameworks, logger };
}
