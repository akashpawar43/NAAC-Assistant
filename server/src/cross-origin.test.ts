// The client hosted on its own origin (APP_URL) calling the API on another (PUBLIC_URL).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Db } from "./db/client.js";
import { LocalFileStore } from "./infra/file-store.js";
import { MemoryMailer } from "./infra/mailer.js";
import { bootstrapWithFrameworks } from "./testing/bootstrap.js";

process.env.NODE_ENV = "test";

const APP = "https://app.example.in";
const API = "https://api.example.in";
const EVIL = "https://evil.example.com";

let app: FastifyInstance;
let sameOriginApp: FastifyInstance;
let db: Db;
const mailer = new MemoryMailer();

// Over HTTPS the cookies carry the __Host- prefix (only this exact host may set them).
const SESSION = "__Host-naac_session";
const LOGIN = "__Host-naac_login";

async function signIn(email: string) {
  mailer.sent = [];
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", headers: { origin: APP }, payload: { email } });
  const login = r.cookies.find((x) => x.name === LOGIN)!.value;
  const link = new URL(/http\S+/.exec(mailer.sent[0].text)![0]);
  return { link, login, res: await app.inject({ url: link.pathname + link.search, headers: { cookie: `${LOGIN}=${login}` } }) };
}

beforeAll(async () => {
  const boot = await bootstrapWithFrameworks({ publicUrl: API, appUrl: APP, cookieSameSite: "none", authRateLimitPerMin: 100 });
  db = boot.db;
  const deps = { db, frameworks: boot.frameworks, logger: boot.logger, files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-files-"))), mailer };
  app = await buildApp({ ...deps, cfg: boot.cfg });
  sameOriginApp = await buildApp({ ...deps, cfg: { ...boot.cfg, appUrl: API, cookieSameSite: "lax" } });
}, 120000);

afterAll(async () => {
  await app?.close();
  await sameOriginApp?.close();
  await db?.close();
});

describe("client on another origin", () => {
  it("answers the app's preflight with credentials allowed", async () => {
    const r = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/cycles/x/shares/y",
      headers: { origin: APP, "access-control-request-method": "DELETE" },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(APP);
    expect(r.headers["access-control-allow-credentials"]).toBe("true");
    expect(r.headers["access-control-allow-methods"]).toContain("DELETE");
  });

  it("exposes Content-Disposition so the app can name downloads", async () => {
    const r = await app.inject({ url: "/api/v1/health", headers: { origin: APP } });
    expect(r.headers["access-control-allow-origin"]).toBe(APP);
    expect(r.headers["access-control-expose-headers"]).toContain("Content-Disposition");
  });

  it("does not grant CORS to other origins", async () => {
    const r = await app.inject({ url: "/api/v1/health", headers: { origin: EVIL } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects state-changing requests from other origins", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", headers: { origin: EVIL }, payload: { email: "x@a.edu" } });
    expect(r.statusCode).toBe(403);
  });

  it("accepts state-changing requests from the app and from clients that send no Origin", async () => {
    for (const headers of [{ origin: APP }, {}]) {
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", headers, payload: { email: "x@a.edu" } });
      expect(r.statusCode).toBe(200);
    }
  });

  it("sign-in link points at the API, sets a cross-site cookie and lands on the app", async () => {
    const { link, res } = await signIn("admin@a.edu");
    expect(link.origin).toBe(API);
    expect(res.headers.location).toBe(`${APP}/`);
    const c = res.cookies.find((x) => x.name === SESSION)!;
    expect(c.sameSite).toBe("None");
    expect(c.secure).toBe(true);
    expect(c.httpOnly).toBe(true);
  });

  it("a failed sign-in lands on the app with the error", async () => {
    const { link } = await signIn("admin@a.edu");
    const r = await app.inject({ url: link.pathname + link.search });
    expect(r.headers.location).toMatch(/^https:\/\/app\.example\.in\/\?login_error=/);
  });

  it("sign-out clears the cookie with the same cross-site attributes", async () => {
    const c = (await signIn("admin@a.edu")).res.cookies.find((x) => x.name === SESSION)!;
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { origin: APP, cookie: `${SESSION}=${c.value}` } });
    const cleared = r.cookies.find((x) => x.name === SESSION)!;
    expect(cleared.value).toBe("");
    expect(cleared.sameSite).toBe("None");
    expect(cleared.secure).toBe(true);
  });

  it("collection links point at the app", async () => {
    const c = (await signIn("admin@a.edu")).res.cookies.find((x) => x.name === SESSION)!;
    const headers = { origin: APP, cookie: `${SESSION}=${c.value}` };
    const me = (await app.inject({ url: "/api/v1/me", headers })).json();
    const cycle = (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${me.memberships[0].college_id}/cycles`,
        headers,
        payload: { kind: "AQAR", label: "AQAR", last_year: "2024-25", framework_id: "demo_college", college_name: "Alpha College" },
      })
    ).json().id;
    const link = await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/collection-links`, headers, payload: {} });
    expect(link.json().url).toMatch(new RegExp(`^${APP}/collect/`));
  });
});

describe("client on the same origin", () => {
  it("sends no CORS headers", async () => {
    const r = await sameOriginApp.inject({ method: "POST", url: "/api/v1/auth/magic-link", headers: { origin: API }, payload: { email: "x@a.edu" } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // SEC-25: SameSite=Lax lets a sibling subdomain (same site) send the cookie, so Origin is
  // checked in this mode too. This test used to assert the opposite ("does not check Origin").
  it("rejects state-changing requests from other origins, including sibling subdomains", async () => {
    for (const origin of [EVIL, "https://student-club.example.in", "null"]) {
      const r = await sameOriginApp.inject({ method: "POST", url: "/api/v1/auth/magic-link", headers: { origin }, payload: { email: "x@a.edu" } });
      expect(r.statusCode, origin).toBe(403);
    }
  });

  it("without an Origin header, uses Fetch Metadata and still serves non-browser clients", async () => {
    const post = (headers: Record<string, string>) => sameOriginApp.inject({ method: "POST", url: "/api/v1/auth/magic-link", headers, payload: { email: "x@a.edu" } });
    expect((await post({ "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await post({ "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    expect((await post({ "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    expect((await post({})).statusCode).toBe(200); // curl, scripts: no ambient cookies to abuse
  });

  it("reads never need an Origin check", async () => {
    expect((await sameOriginApp.inject({ url: "/api/v1/health", headers: { origin: EVIL } })).statusCode).toBe(200);
  });
});
