// Several server instances starting at once against one PostgreSQL database (e.g. two containers).
// PGlite runs one query at a time and cannot show this, so the test needs a real server:
//   TEST_DATABASE_URL=postgres://... npm test
// It works in a new temporary schema and drops it afterwards; other schemas are not touched.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { bootstrap } from "./bootstrap.js";

process.env.NODE_ENV = "test";

const url = process.env.TEST_DATABASE_URL;
const INSTANCES = 3;
const MIGRATIONS = readdirSync(fileURLToPath(new URL("./db/migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).length;

/** The same database, with unqualified table names resolving to `schema` (extensions stay in public). */
function inSchema(databaseUrl: string, schema: string): string {
  const u = new URL(databaseUrl);
  u.searchParams.set("options", `-c search_path=${schema},public`);
  return u.toString();
}

describe.skipIf(!url)("start-up against a shared PostgreSQL", () => {
  it(
    "lets several instances migrate and seed at the same time",
    async () => {
      const schema = `startup_race_${randomUUID().replaceAll("-", "")}`;
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      try {
        const databaseUrl = inSchema(url!, schema);
        const starts = await Promise.allSettled(Array.from({ length: INSTANCES }, () => bootstrap({ databaseUrl }, () => {})));
        await Promise.all(starts.map((s) => (s.status === "fulfilled" ? s.value.db.close() : undefined)));

        expect(starts.map((s) => (s.status === "rejected" ? String(s.reason) : "ok"))).toEqual(Array(INSTANCES).fill("ok"));
        const count = async (table: string) => Number((await admin.query(`SELECT count(*) AS n FROM ${schema}.${table}`)).rows[0].n);
        expect(await count("schema_migration")).toBe(MIGRATIONS);
        expect(await count("help_article")).toBeGreaterThan(0);
      } finally {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
    300_000,
  );
});
