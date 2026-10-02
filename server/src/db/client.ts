// One small database interface over node-postgres (production) and PGlite (dev/tests).
// All SQL in the app goes through `query` with $1-style parameters; nothing is concatenated.
import pg from "pg";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly kind: "pg" | "pglite";
}

// Return numeric/bigint as JS numbers (values here are small: counts, lakhs, ids).
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export async function connectPg(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const wrap = (c: pg.Pool | pg.PoolClient): Omit<Db, "tx" | "close"> => ({
    kind: "pg",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await c.query(sql, params as unknown[])).rows as T[] }),
    exec: async (sql: string) => {
      await c.query(sql);
    },
  });
  const db: Db = {
    ...wrap(pool),
    kind: "pg",
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner: Db = { ...wrap(client), kind: "pg", tx: (f) => f(inner), close: async () => {} };
        const out = await fn(inner);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

export async function connectPglite(dir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const lite = await PGlite.create(dir ? { dataDir: dir, extensions: { pg_trgm } } : { extensions: { pg_trgm } });
  // PGlite runs one query at a time; serialise callers so transactions don't interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown> };
  const wrap = (c: Q): Omit<Db, "tx" | "close"> => ({
    kind: "pglite",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await c.query(sql, params)).rows as T[] }),
    exec: async (sql: string) => {
      await c.exec(sql);
    },
  });
  const direct = wrap(lite as unknown as Q);
  const db: Db = {
    kind: "pglite",
    query: (sql, params) => serial(() => direct.query(sql, params)),
    exec: (sql) => serial(() => direct.exec(sql)),
    tx: (fn) =>
      serial(() =>
        lite.transaction(async (t) => {
          const inner: Db = { ...wrap(t as unknown as Q), kind: "pglite", tx: (f) => f(inner), close: async () => {} };
          return fn(inner);
        }),
      ),
    close: () => lite.close(),
  };
  return db;
}
