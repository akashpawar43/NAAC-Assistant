// Applies src/db/migrations/*.sql in name order, once each.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "./client.js";

const DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

function migrationFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function appliedMigrations(db: Db): Promise<Set<string>> {
  return new Set((await db.query<{ name: string }>("SELECT name FROM schema_migration")).rows.map((r) => r.name));
}

export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = await appliedMigrations(db);
  for (const f of migrationFiles()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(DIR, f), "utf8");
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query("INSERT INTO schema_migration (name) VALUES ($1)", [f]);
    });
    log(`migration applied: ${f}`);
  }
}

/** Migration files this build has that the database has not applied (none after a normal start-up). */
export async function pendingMigrations(db: Db): Promise<string[]> {
  const done = await appliedMigrations(db);
  return migrationFiles().filter((f) => !done.has(f));
}
