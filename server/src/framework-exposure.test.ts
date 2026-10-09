// Signing up must not hand out the framework files: formulas, score bands and the NAAC data-template
// layout stay on the server. Walks every response a signed-in user gets about each framework.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Db } from "./db/client.js";
import { LocalFileStore } from "./infra/file-store.js";
import { MemoryMailer } from "./infra/mailer.js";
import type { FrameworkRegistry } from "./services/frameworks.js";
import { bootstrapWithFrameworks } from "./testing/bootstrap.js";

process.env.NODE_ENV = "test";

const PRIVATE_KEYS = ["formula", "bands", "lower_is_better", "naac_sheet"];

let app: FastifyInstance;
let db: Db;
let frameworks: FrameworkRegistry;
let cookie = "";
const mailer = new MemoryMailer();

/** Every object key anywhere in a JSON value, with the path where it was found. */
function keysOf(value: unknown, path = "$"): { key: string; path: string }[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysOf(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [{ key: k, path: `${path}.${k}` }, ...keysOf(v, `${path}.${k}`)]);
}

async function get(url: string): Promise<unknown> {
  const r = await app.inject({ url, headers: { cookie } });
  expect(r.statusCode, url).toBe(200);
  return r.json();
}

function expectNoPrivateKeys(url: string, body: unknown) {
  const leaked = keysOf(body).filter((k) => PRIVATE_KEYS.includes(k.key));
  expect(leaked.slice(0, 5).map((k) => k.path), url).toEqual([]);
}

beforeAll(async () => {
  const boot = await bootstrapWithFrameworks({ publicUrl: "http://test.local" });
  db = boot.db;
  frameworks = boot.frameworks;
  app = await buildApp({ cfg: boot.cfg, db, frameworks, logger: boot.logger, files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-files-"))), mailer });
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: "curious@example.test" } });
  const link = new URL(/http\S+/.exec(mailer.sent[0].text)![0]);
  // Opened in the browser that asked for it (it holds the login cookie), as a person would.
  const nonce = r.cookies.find((c) => c.name === "naac_login")!.value;
  const v = await app.inject({ url: link.pathname + link.search, headers: { cookie: `naac_login=${nonce}` } });
  cookie = `naac_session=${v.cookies.find((c) => c.name === "naac_session")!.value}`;
}, 120000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("framework internals stay on the server", () => {
  it("the framework list and each framework's metrics leave out formulas, bands and NAAC layouts", async () => {
    expectNoPrivateKeys("/api/v1/frameworks", await get("/api/v1/frameworks"));
    for (const fw of frameworks.list()) {
      const url = `/api/v1/frameworks/${fw.id}/metrics`;
      const body = (await get(url)) as { metrics: { id: string; columns: unknown[] }[] };
      expectNoPrivateKeys(url, body);
      // Still everything the screens need: every metric, each with its row columns.
      expect(body.metrics.map((m) => m.id), url).toEqual(fw.metrics.map((m) => m.id));
    }
  });

  it("no report screen sends them either, for any metric of any framework", async () => {
    const me = (await get("/api/v1/me")) as { memberships: { college_id: string }[] };
    const collegeId = me.memberships[0].college_id;
    for (const fw of frameworks.list()) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${collegeId}/cycles`,
        headers: { cookie },
        payload: { kind: fw.applies_to[0], label: fw.id, last_year: "2024-25", framework_id: fw.id, college_name: "Exposure College" },
      });
      expect(r.statusCode, fw.id).toBe(200);
      const base = `/api/v1/cycles/${r.json().id}`;
      for (const path of ["", "/review-checklist", "/cgpa", "/trends"]) expectNoPrivateKeys(base + path, await get(base + path));
      for (const m of fw.metrics) expectNoPrivateKeys(`${base}/metrics/${m.id}`, await get(`${base}/metrics/${m.id}`));
    }
  }, 120000);
});
