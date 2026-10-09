// Security headers (helmet) on the API and on the served client, over HTTPS and in plain-http dev.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import type { Db } from "./db/client.js";
import { LocalFileStore } from "./infra/file-store.js";
import { MemoryMailer } from "./infra/mailer.js";

process.env.NODE_ENV = "test";

let httpsApp: FastifyInstance;
let httpApp: FastifyInstance;
let db: Db;

function csp(headers: Record<string, unknown>): Map<string, string> {
  const raw = String(headers["content-security-policy"] ?? "");
  return new Map(raw.split(";").map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map(([k, ...v]) => [k, v.join(" ")]));
}

beforeAll(async () => {
  const boot = await bootstrap({ databaseUrl: "", pgliteDir: "" }, () => {});
  db = boot.db;
  const clientDist = mkdtempSync(join(tmpdir(), "naac-client-"));
  writeFileSync(join(clientDist, "index.html"), "<!doctype html><title>t</title>");
  const deps = { db, frameworks: boot.frameworks, logger: boot.logger, files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-files-"))), mailer: new MemoryMailer() };
  httpsApp = await buildApp({ ...deps, cfg: { ...boot.cfg, clientDist, publicUrl: "https://naac.example.in", appUrl: "https://naac.example.in" } });
  httpApp = await buildApp({ ...deps, cfg: { ...boot.cfg, clientDist, publicUrl: "http://localhost:8080", appUrl: "http://localhost:8080" } });
}, 120000);

afterAll(async () => {
  await httpsApp?.close();
  await httpApp?.close();
  await db?.close();
});

describe("security headers", () => {
  it("sends a same-origin CSP that forbids framing, plugins and inline script", async () => {
    for (const url of ["/", "/c/some-report", "/api/v1/health"]) {
      const p = csp((await httpsApp.inject({ url })).headers);
      expect(p.get("default-src"), url).toBe("'self'");
      expect(p.get("script-src"), url).toBe("'self'");
      expect(p.get("style-src"), url).toBe("'self'");
      expect(p.get("frame-ancestors"), url).toBe("'none'");
      expect(p.get("object-src"), url).toBe("'none'");
    }
  });

  it("sends HSTS, nosniff and no-referrer over HTTPS", async () => {
    const r = await httpsApp.inject({ url: "/api/v1/health" });
    expect(r.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(csp(r.headers).has("upgrade-insecure-requests")).toBe(true);
  });

  it("keeps error responses covered too", async () => {
    const r = await httpsApp.inject({ url: "/api/v1/no-such-endpoint" });
    expect(r.statusCode).toBe(404);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(csp(r.headers).get("frame-ancestors")).toBe("'none'");
  });

  it("leaves out HSTS and upgrade-insecure-requests on plain-http development", async () => {
    const r = await httpApp.inject({ url: "/" });
    expect(r.headers["strict-transport-security"]).toBeUndefined();
    expect(csp(r.headers).has("upgrade-insecure-requests")).toBe(false);
    expect(csp(r.headers).get("default-src")).toBe("'self'");
  });
});
