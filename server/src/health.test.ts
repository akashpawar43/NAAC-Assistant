// Liveness and readiness checks.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Db } from "./db/client.js";
import { LocalFileStore } from "./infra/file-store.js";
import { MemoryMailer } from "./infra/mailer.js";
import { FrameworkRegistry } from "./services/frameworks.js";
import { bootstrapWithFrameworks } from "./testing/bootstrap.js";

process.env.NODE_ENV = "test";

let db: Db;
let boot: Awaited<ReturnType<typeof bootstrapWithFrameworks>>;
const apps: FastifyInstance[] = [];

async function appWith(database: Db, frameworks: FrameworkRegistry = boot.frameworks): Promise<FastifyInstance> {
  const app = await buildApp({
    cfg: boot.cfg,
    db: database,
    frameworks,
    logger: boot.logger,
    files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-files-"))),
    mailer: new MemoryMailer(),
  });
  apps.push(app);
  return app;
}

/** A database whose every query fails, as when the server is unreachable. */
function downDb(real: Db): Db {
  const fail = async (): Promise<never> => {
    throw new Error("connect ECONNREFUSED");
  };
  return { ...real, query: fail, exec: fail, tx: fail };
}

beforeAll(async () => {
  boot = await bootstrapWithFrameworks();
  db = boot.db;
}, 120000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await db?.close();
});

describe("health checks", () => {
  it("is ready when the database answers and every migration is applied", async () => {
    const r = await (await appWith(db)).inject({ url: "/api/v1/ready" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, database: "ok", migrations: "ok", frameworks: "ok" });
  });

  it("is not ready until frameworks have been imported", async () => {
    const app = await appWith(db, new FrameworkRegistry());
    const r = await app.inject({ url: "/api/v1/ready" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ok: false, database: "ok", migrations: "ok", frameworks: "missing" });
  });

  it("stays live but not ready while the database is down", async () => {
    const app = await appWith(downDb(db));
    expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
    const r = await app.inject({ url: "/api/v1/ready" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ ok: false, database: "unavailable" });
  });

  it("is not ready when a migration of this build has not been applied", async () => {
    const app = await appWith(db);
    const last = (await db.query<{ name: string }>("SELECT name FROM schema_migration ORDER BY name DESC LIMIT 1")).rows[0].name;
    await db.query("DELETE FROM schema_migration WHERE name = $1", [last]);
    try {
      const r = await app.inject({ url: "/api/v1/ready" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ ok: false, database: "ok", migrations: "pending", frameworks: "ok", pending: [last] });
    } finally {
      await db.query("INSERT INTO schema_migration (name) VALUES ($1)", [last]);
    }
  });
});
