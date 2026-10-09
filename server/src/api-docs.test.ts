// OpenAPI docs (Swagger) and request ids.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { loadConfig, securityWarnings } from "./config.js";
import { basicCredentials } from "./http/docs.js";
import type { Db } from "./db/client.js";
import { LocalFileStore } from "./infra/file-store.js";
import { MemoryMailer } from "./infra/mailer.js";

process.env.NODE_ENV = "test";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Operation = { tags?: string[]; summary?: string; security?: unknown[] };
type Spec = { openapi: string; paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>> };

let app: FastifyInstance;
let noDocsApp: FastifyInstance;
let db: Db;
let spec: Spec;

// The docs are behind HTTP Basic authentication (API_DOCS_USER / API_DOCS_PASSWORD).
const DOCS_USER = "docs";
const DOCS_PASSWORD = "correct horse battery staple";
const basic = (user: string, pass: string) => ({ authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });
const auth = basic(DOCS_USER, DOCS_PASSWORD);

beforeAll(async () => {
  const boot = await bootstrap(
    { databaseUrl: "", pgliteDir: "", publicUrl: "http://test.local", apiDocs: true, apiDocsUser: DOCS_USER, apiDocsPassword: DOCS_PASSWORD },
    () => {},
  );
  db = boot.db;
  const deps: AppDeps = {
    cfg: boot.cfg,
    db,
    frameworks: boot.frameworks,
    logger: boot.logger,
    files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-files-"))),
    mailer: new MemoryMailer(),
  };
  app = await buildApp(deps);
  noDocsApp = await buildApp({ ...deps, cfg: { ...boot.cfg, apiDocs: false } });
  spec = (await app.inject({ url: "/api/docs/json", headers: auth })).json();
}, 120000);

afterAll(async () => {
  await app?.close();
  await noDocsApp?.close();
  await db?.close();
});

const operations = () =>
  Object.entries(spec.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => ({ path, method: m, op: item[m]! })));

describe("API docs", () => {
  it("serves an OpenAPI 3.1 spec and the Swagger UI", async () => {
    expect(spec.openapi).toBe("3.1.0");
    const ui = await app.inject({ url: "/api/docs/", headers: auth });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
  });

  it("documents every API route, each with a tag and a summary", () => {
    const ops = operations();
    // 65 + the security remediation's DELETE members/{userId}, POST auth/link-info, POST auth/verify,
    // POST auth/logout-all and DELETE me.
    expect(ops).toHaveLength(70);
    for (const { path, method, op } of ops) {
      expect(path.startsWith("/api/v1/"), path).toBe(true);
      expect(op.tags?.length, `${method} ${path}`).toBe(1);
      expect(op.summary, `${method} ${path}`).toBeTruthy();
    }
  });

  it("marks only sign-in, health and public collection routes as needing no session", () => {
    const open = operations()
      .filter(({ op }) => Array.isArray(op.security) && op.security.length === 0)
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    expect(open).toEqual([
      "get /api/v1/auth/verify",
      "get /api/v1/collect/{token}",
      "get /api/v1/collect/{token}/template.xlsx",
      "get /api/v1/health",
      "get /api/v1/ready",
      "post /api/v1/auth/link-info",
      "post /api/v1/auth/magic-link",
      "post /api/v1/auth/verify",
      "post /api/v1/collect/{token}/submit",
      "post /api/v1/collect/{token}/upload",
    ]);
  });

  it("keeps the API's own validation errors (route schemas only document)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: 42 } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "bad_request", message: "Invalid request" });
  });

  it("can be turned off", async () => {
    expect((await noDocsApp.inject({ url: "/api/docs/json", headers: auth })).statusCode).toBe(404);
    const r = await noDocsApp.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: 42 } });
    expect(r.json()).toMatchObject({ error: "bad_request" });
  });
});

describe("API docs password protection", () => {
  // The UI page, its static assets and the JSON spec are all protected.
  const DOCS_URLS = ["/api/docs", "/api/docs/", "/api/docs/json", "/api/docs/yaml", "/api/docs/static/swagger-ui.css", "/api/docs/static/swagger-initializer.js"];

  it("refuses every docs URL without credentials, asking the browser for a password", async () => {
    for (const url of DOCS_URLS) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBe(401);
      expect(r.headers["www-authenticate"], url).toMatch(/^Basic realm="NAAC Assistant API docs"/);
      expect(r.body, url).not.toContain("openapi");
    }
  });

  it("refuses wrong or malformed credentials", async () => {
    const bad: Record<string, string>[] = [
      basic(DOCS_USER, "wrong password!!"),
      basic("admin", DOCS_PASSWORD),
      basic(DOCS_USER, ""),
      basic("", ""),
      { authorization: "Bearer abc" },
      { authorization: "Basic !!!not-base64" },
      { authorization: `Basic ${Buffer.from("no-colon").toString("base64")}` },
    ];
    for (const headers of bad) {
      const r = await app.inject({ url: "/api/docs/json", headers, remoteAddress: "198.51.100.200" });
      expect(r.statusCode, headers.authorization).toBe(401);
    }
  });

  it("serves everything with the right credentials, never cached", async () => {
    for (const url of DOCS_URLS.filter((u) => u !== "/api/docs")) {
      const r = await app.inject({ url, headers: auth });
      expect(r.statusCode, url).toBe(200);
      // The spec and the UI page describe the API: never cached. (The swagger-ui library files
      // under /static are public code with their own cache header.)
      if (!url.includes("/static/")) expect(r.headers["cache-control"], url).toBe("no-store");
    }
    // The bare path redirects into the UI, still behind the password.
    expect([200, 302]).toContain((await app.inject({ url: "/api/docs", headers: auth })).statusCode);
  });

  it("has no path-trick bypasses", async () => {
    for (const url of [
      "/api/docs/json?x=1",
      "/api/%64ocs/json",
      "/%61pi/docs/json",
      "/api/docs/%6Ason",
      "/api/docs%2Fjson",
      "/api/docs//json",
      "//api/docs/json",
      "/api/docs/./json",
      "/api/x/../docs/json",
      "/API/DOCS/json",
      "/api/docs/json/",
      "/api/docs/static/%73wagger-ui.css",
    ]) {
      const r = await app.inject({ url });
      expect(r.statusCode === 200 && r.body.includes('"openapi"'), `${url} -> ${r.statusCode}`).toBe(false);
    }
  });

  it("locks an IP out after repeated wrong passwords, even with the right one", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 10; i++) expect((await app.inject({ url: "/api/docs/json", headers: basic(DOCS_USER, `guess-${i}-xxxxxxx`), remoteAddress: ip })).statusCode).toBe(401);
    const locked = await app.inject({ url: "/api/docs/json", headers: auth, remoteAddress: ip });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    // Other IPs are not affected.
    expect((await app.inject({ url: "/api/docs/json", headers: auth, remoteAddress: "203.0.113.78" })).statusCode).toBe(200);
  });

  it("does not touch the API itself", async () => {
    expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/me" })).statusCode).toBe(401); // the app's own session auth, not Basic
    expect((await app.inject({ url: "/api/v1/me" })).headers["www-authenticate"]).toBeUndefined();
  });

  it("is not served at all when API_DOCS is on but no password is set", async () => {
    const boot = await bootstrap({ databaseUrl: "", pgliteDir: "", publicUrl: "http://test.local", apiDocs: true, apiDocsPassword: "" }, () => {});
    const open = await buildApp({ cfg: boot.cfg, db: boot.db, frameworks: boot.frameworks, logger: boot.logger, files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-nodocs-"))), mailer: new MemoryMailer() });
    for (const url of ["/api/docs/json", "/api/docs/"]) expect((await open.inject({ url })).statusCode, url).toBe(404);
    expect(securityWarnings(boot.cfg).join("\n")).toMatch(/API_DOCS_PASSWORD is not set/);
    await open.close();
    await boot.db.close();
  });

  it("rejects a short docs password at start-up", () => {
    expect(() => loadConfig({ apiDocsPassword: "short" })).toThrow(/at least 12 characters/);
    expect(() => loadConfig({ apiDocsPassword: "long enough pass" })).not.toThrow();
  });

  it("parses Basic credentials, including colons in the password", () => {
    expect(basicCredentials(basic("u", "p:a:ss").authorization)).toEqual({ user: "u", pass: "p:a:ss" });
    expect(basicCredentials(undefined)).toBeNull();
    expect(basicCredentials("Digest x")).toBeNull();
  });
});

describe("request ids", () => {
  it("returns a new id on every response", async () => {
    const a = await app.inject({ url: "/api/v1/health" });
    const b = await app.inject({ url: "/api/v1/health" });
    expect(a.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  it("reuses a well-formed id from a proxy and replaces anything else", async () => {
    const kept = await app.inject({ url: "/api/v1/health", headers: { "x-request-id": "edge-123.abc" } });
    expect(kept.headers["x-request-id"]).toBe("edge-123.abc");
    const replaced = await app.inject({ url: "/api/v1/health", headers: { "x-request-id": "bad id\nwith newline" } });
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
