// Regression tests for the fixes in security-audit/REMEDIATION_LOG.md. Each describe block names
// the finding it guards; the test fails if the vulnerability comes back.
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { Writable } from "node:stream";
import { buildApp } from "./app.js";
import { loadConfig, securityWarnings } from "./config.js";
import type { Db } from "./db/client.js";
import { LocalFileStore } from "./infra/file-store.js";
import { createLogger } from "./infra/logger.js";
import { createMailer, MemoryMailer } from "./infra/mailer.js";
import { purgeExpired } from "./services/auth.js";
import { Collection } from "./services/collection.js";
import { csvCell } from "./services/evidence-zip.js";
import { parseImport } from "./services/excel.js";
import { Workspace } from "./services/workspace.js";
import type { FrameworkRegistry } from "./services/frameworks.js";
import { assertXlsxWithinLimits, XlsxLimitError } from "./services/xlsx-guard.js";
import { bootstrapWithFrameworks } from "./testing/bootstrap.js";

process.env.NODE_ENV = "test";

let app: FastifyInstance;
let db: Db;
let frameworks: FrameworkRegistry;
const mailer = new MemoryMailer();
const FW = "demo_college";
const cookies: Record<string, string> = {};
let ipSeq = 1;

/** Signs in the way a browser does: the sign-in link is opened in the browser that asked for it. */
async function signIn(email: string): Promise<string> {
  mailer.sent = [];
  const ip = `10.9.0.${ipSeq++}`;
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email }, remoteAddress: ip });
  expect(r.statusCode).toBe(200);
  const nonce = r.cookies.find((c) => c.name === "naac_login");
  const link = new URL(/http\S+/.exec(mailer.sent[0].text)![0]);
  const v = await app.inject({ url: link.pathname + link.search, headers: nonce ? { cookie: `naac_login=${nonce.value}` } : {}, remoteAddress: ip });
  const c = v.cookies.find((x) => x.name === "naac_session")!;
  return `naac_session=${c.value}`;
}
const as = (who: string) => ({ cookie: cookies[who] });
const me = async (who: string) => (await app.inject({ url: "/api/v1/me", headers: as(who) })).json();
const workspaceOf = async (who: string) => (await me(who)).memberships.find((m: { owned: boolean }) => m.owned).college_id as string;
const newCycle = async (who: string, collegeName = "Alpha College") =>
  (
    await app.inject({
      method: "POST",
      url: `/api/v1/colleges/${await workspaceOf(who)}/cycles`,
      headers: as(who),
      payload: { kind: "AQAR", label: "AQAR 2024-25", last_year: "2024-25", framework_id: FW, college_name: collegeName },
    })
  ).json().id as string;

beforeAll(async () => {
  const boot = await bootstrapWithFrameworks({ publicUrl: "http://test.local", authRateLimitPerMin: 1000, evidenceQuotaBytes: 64 * 1024 });
  db = boot.db;
  frameworks = boot.frameworks;
  app = await buildApp({ cfg: boot.cfg, db, frameworks, logger: boot.logger, files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-sec-"))), mailer });
}, 120000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

// ------------------------------------------------------------------------------------------------
describe("SEC-07 spreadsheet amplification", () => {
  const metric = () => frameworks.metric(FW, "5.2.1");

  async function sparseWorkbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    const cols = metric().template!.columns!;
    cols.forEach((c, i) => (ws.getCell(1, i + 1).value = c.label));
    ws.getCell(2, 1).value = "2024-25";
    ws.getCell(2, 2).value = "Student A";
    ws.getCell(2, 3).value = "Placed";
    ws.getCell(2, 4).value = "Infosys";
    ws.getCell("A1048576").value = "x"; // pushes rowCount to Excel's maximum
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("parses a sparse sheet without walking empty rows (bounded time and memory)", async () => {
    const buf = await sparseWorkbook();
    expect(buf.length).toBeLessThan(20_000);
    const before = process.memoryUsage().rss;
    const t = Date.now();
    const r = await parseImport(metric(), buf);
    const grewMb = (process.memoryUsage().rss - before) / 1048576;
    expect(Date.now() - t).toBeLessThan(3000);
    expect(grewMb).toBeLessThan(300); // was ~1,079 MB before the fix
    expect(r.rows).toHaveLength(2); // the real row, plus the stray "x" row (rejected later by validation)
    expect(r.rowNumbers).toEqual([2, 1048576]);
  });

  it("rejects archives that inflate past the cap, even when headers lie", async () => {
    const zip = new JSZip();
    zip.file("xl/worksheets/sheet1.xml", Buffer.alloc(60 * 1024 * 1024, 0x20)); // 60 MB of spaces, compresses to ~60 KB
    const bomb = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => assertXlsxWithinLimits(bomb)).toThrow(XlsxLimitError);
    await expect(parseImport(metric(), bomb)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/too large once unpacked/) });
  });

  it("rejects non-zip input and accepts a normal template", async () => {
    expect(() => assertXlsxWithinLimits(Buffer.from("not a zip at all, just text"))).toThrow(XlsxLimitError);
    expect(() => assertXlsxWithinLimits(Buffer.alloc(0))).toThrow(XlsxLimitError);
    expect(() => assertXlsxWithinLimits(Buffer.from("PK\x05\x06" + "\0".repeat(18), "latin1"))).not.toThrow(); // empty zip
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("s").getCell("A1").value = "ok";
    const good = Buffer.from(await wb.xlsx.writeBuffer());
    expect(() => assertXlsxWithinLimits(good)).not.toThrow();
  });

  it("rate-limits the per-metric import route", async () => {
    cookies["imp@x.edu"] = await signIn("imp@x.edu");
    const cycle = await newCycle("imp@x.edu");
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      codes.push((await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/import`, headers: as("imp@x.edu"), remoteAddress: "198.51.100.77" })).statusCode);
    }
    expect(codes.slice(0, 20).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-01 / SEC-02 / SEC-16 membership integrity", () => {
  let ws = "";
  beforeAll(async () => {
    for (const e of ["owner@m.edu", "coadmin@m.edu", "staff@m.edu", "victim@m.edu"]) cookies[e] = await signIn(e);
    ws = await workspaceOf("owner@m.edu");
    for (const [email, role] of [["coadmin@m.edu", "iqac_admin"], ["staff@m.edu", "viewer"]]) {
      expect((await app.inject({ method: "POST", url: `/api/v1/colleges/${ws}/members`, headers: as("owner@m.edu"), payload: { email, role } })).statusCode).toBe(200);
    }
  });
  const uid = async (email: string) => (await db.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email])).rows[0].id;

  it("SEC-02: adding a member never changes an existing person's name", async () => {
    await db.query("UPDATE app_user SET name = 'Real Name' WHERE email = 'victim@m.edu'");
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/colleges/${ws}/members`,
      headers: as("owner@m.edu"),
      payload: { email: "victim@m.edu", name: "ATTACKER-SET NAME", role: "viewer" },
    });
    expect(r.statusCode).toBe(200);
    expect((await me("victim@m.edu")).user.name).toBe("Real Name");
    // A brand-new address still gets the name it was invited with.
    await app.inject({ method: "POST", url: `/api/v1/colleges/${ws}/members`, headers: as("owner@m.edu"), payload: { email: "new.person@m.edu", name: "New Person", role: "viewer" } });
    expect((await db.query<{ name: string }>("SELECT name FROM app_user WHERE email = 'new.person@m.edu'")).rows[0].name).toBe("New Person");
  });

  it("SEC-16: a co-admin cannot demote or remove the owner", async () => {
    const ownerId = await uid("owner@m.edu");
    const demote = await app.inject({ method: "POST", url: `/api/v1/colleges/${ws}/members`, headers: as("coadmin@m.edu"), payload: { email: "owner@m.edu", role: "viewer" } });
    expect(demote.statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/colleges/${ws}/members/${ownerId}`, headers: as("coadmin@m.edu") })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/colleges/${ws}/audit-log`, headers: as("owner@m.edu") })).statusCode).toBe(200);
    expect((await me("owner@m.edu")).memberships.find((m: { college_id: string }) => m.college_id === ws).role).toBe("iqac_admin");
  });

  it("SEC-01: a removed member loses access immediately; only admins can remove", async () => {
    const cycle = await newCycle("owner@m.edu");
    const staffId = await uid("staff@m.edu");
    await app.inject({ method: "PUT", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/assign`, headers: as("owner@m.edu"), payload: { user_id: staffId } });
    expect((await app.inject({ url: `/api/v1/cycles/${cycle}`, headers: as("staff@m.edu") })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/colleges/${ws}/members/${staffId}`, headers: as("victim@m.edu") })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/colleges/${ws}/members/${staffId}`, headers: as("coadmin@m.edu") })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/cycles/${cycle}`, headers: as("staff@m.edu") })).statusCode).toBe(404);
    expect((await db.query("SELECT 1 FROM metric_entry WHERE assigned_to = $1", [staffId])).rows).toHaveLength(0);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/colleges/${ws}/members/${staffId}`, headers: as("owner@m.edu") })).statusCode).toBe(404);
    const log = (await app.inject({ url: `/api/v1/colleges/${ws}/audit-log`, headers: as("owner@m.edu") })).json();
    expect(log.some((l: { action: string }) => l.action === "member.remove")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-03 outbound email abuse", () => {
  it("share notices carry no sharer-typed text", async () => {
    cookies["sharer@s.edu"] = await signIn("sharer@s.edu");
    const cycle = await newCycle("sharer@s.edu", "URGENT verify your account at http://phish.example now");
    await app.inject({ method: "PATCH", url: `/api/v1/cycles/${cycle}`, headers: as("sharer@s.edu"), payload: { label: "Click http://phish.example" } });
    mailer.sent = [];
    expect((await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/shares`, headers: as("sharer@s.edu"), payload: { email: "target@t.edu", role: "viewer" } })).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    expect(m.subject).toBe("A report was shared with you in NAAC Assistant");
    expect(`${m.subject}\n${m.text}`).not.toMatch(/phish|URGENT/);
  });

  it("caps share notices per account per day", async () => {
    cookies["bulk@s.edu"] = await signIn("bulk@s.edu");
    const cycle = await newCycle("bulk@s.edu");
    const uid = (await me("bulk@s.edu")).user.id;
    // 49 notices already sent today, as if by earlier requests.
    for (let i = 0; i < 49; i++) await db.query("INSERT INTO audit_log (user_id, action) VALUES ($1, 'report.share_notice')", [uid]);
    const share = (n: number) => app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/shares`, headers: as("bulk@s.edu"), payload: { email: `r${n}@t.edu`, role: "viewer" } });
    expect((await share(1)).statusCode).toBe(200);
    const blocked = await share(2);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("share_limit");
    expect((await db.query("SELECT 1 FROM report_share s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'r2@t.edu'")).rows).toHaveLength(0);
  });

  it("caps outstanding sign-in links per address, with the same answer every time", async () => {
    mailer.sent = [];
    const bodies: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: "flooded@t.edu" }, remoteAddress: `192.0.2.${i + 1}` });
      expect(r.statusCode).toBe(200);
      bodies.push(r.body);
    }
    expect(mailer.sent.filter((m) => m.to === "flooded@t.edu")).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-06 evidence storage quota", () => {
  it("refuses uploads past the workspace quota and counts deletions back", async () => {
    cookies["quota@q.edu"] = await signIn("quota@q.edu");
    const cycle = await newCycle("quota@q.edu");
    const boundary = "----q";
    const pdf = (kb: number) =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_key"\r\n\r\noffer_letters\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(kb * 1024 - 9, 0x20)]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const up = (kb: number) =>
      app.inject({
        method: "POST",
        url: `/api/v1/cycles/${cycle}/metrics/5.2.1/evidence`,
        headers: { ...as("quota@q.edu"), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: pdf(kb),
      });
    const first = await up(40); // the quota in this suite is 64 KB
    expect(first.statusCode).toBe(200);
    const over = await up(40);
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toBe("quota_exceeded");
    expect((await app.inject({ method: "DELETE", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/evidence/${first.json().id}`, headers: as("quota@q.edu") })).statusCode).toBe(200);
    expect((await up(40)).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-08 login CSRF: a link opened in another browser needs confirmation", () => {
  async function requestLink(email: string) {
    mailer.sent = [];
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email }, remoteAddress: "10.20.0.1" });
    const link = new URL(/http\S+/.exec(mailer.sent[0].text)![0]);
    return { nonce: r.cookies.find((c) => c.name === "naac_login")!, path: link.pathname + link.search, token: link.searchParams.get("token")! };
  }

  it("sets an HttpOnly, short-lived login cookie when a link is requested", async () => {
    const { nonce } = await requestLink("csrf.attacker@x.edu");
    expect(nonce.httpOnly).toBe(true);
    expect(nonce.maxAge).toBe(900);
    expect(nonce.sameSite).toBe("Lax");
  });

  it("another browser (the victim's) gets the confirmation page, and the link stays unused", async () => {
    const { path, token } = await requestLink("csrf.attacker@x.edu");
    const victim = await app.inject({ url: path }); // no login cookie
    expect(victim.statusCode).toBe(302);
    expect(victim.headers.location).toBe(`http://test.local/login/confirm#token=${encodeURIComponent(token)}`);
    expect(victim.cookies.find((c) => c.name === "naac_session")).toBeUndefined();
    // A wrong nonce is the same as none.
    const wrong = await app.inject({ url: path, headers: { cookie: "naac_login=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    expect(wrong.headers.location).toMatch(/\/login\/confirm#/);
    // The confirmation page can show whose account this is before anything happens.
    const info = await app.inject({ method: "POST", url: "/api/v1/auth/link-info", payload: { token } });
    expect(info.json()).toEqual({ email: "csrf.attacker@x.edu" });
    // An attacker page cannot complete the confirmation for the victim (Origin check, SEC-25).
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/verify", headers: { origin: "https://evil.test" }, payload: { token } })).statusCode).toBe(403);
    // The person confirming it themselves can.
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/verify", headers: { origin: "http://test.local" }, payload: { token } });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.find((c) => c.name === "naac_session")?.value).toBeTruthy();
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/verify", payload: { token } })).json().error).toBe("invalid_link");
  });

  it("link scanners do not use up the link", async () => {
    const { nonce, path } = await requestLink("scanned@x.edu");
    await app.inject({ url: path });
    await app.inject({ url: path });
    const real = await app.inject({ url: path, headers: { cookie: `naac_login=${nonce.value}` } });
    expect(real.headers.location).toBe("http://test.local/");
    expect(real.cookies.find((c) => c.name === "naac_session")?.value).toBeTruthy();
  });

  it("SEC-19: failures redirect with a fixed error code, never free text", async () => {
    const r = await app.inject({ url: "/api/v1/auth/verify?token=not-a-real-token-at-all" });
    expect(r.headers.location).toBe("http://test.local/?login_error=invalid_link");
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-09 X-Forwarded-For only from trusted proxies", () => {
  it("a client connecting directly cannot rotate its IP with the header", async () => {
    // This suite allows 1000 sign-in requests a minute, so use a fresh app with the default limit (5).
    const boot = await bootstrapWithFrameworks({ publicUrl: "http://test.local" });
    const strict = await buildApp({ cfg: boot.cfg, db: boot.db, frameworks: boot.frameworks, logger: boot.logger, files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-xff-"))), mailer });
    const send = (remoteAddress: string, xff?: string) =>
      strict.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: "xff@x.edu" }, remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {} });
    const direct: number[] = [];
    for (let i = 0; i < 7; i++) direct.push((await send("203.0.113.10", `198.51.100.${i}`)).statusCode);
    expect(direct).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // Behind a proxy on the Docker network (private address), the header is still honoured.
    const proxied: number[] = [];
    for (let i = 0; i < 7; i++) proxied.push((await send("172.18.0.5", `198.51.100.${i}`)).statusCode);
    expect(proxied).toEqual([200, 200, 200, 200, 200, 200, 200]);
    await strict.close();
    await boot.db.close();
  });

  it("TRUST_PROXY is configurable and defaults to private networks only", () => {
    expect(loadConfig().trustProxy).toBe("loopback,linklocal,uniquelocal");
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-10 / SEC-11 evidence content and CSV index", () => {
  let cycle = "";
  const boundary = "----ev";
  const mk = (type: string, filename: string, body: Buffer) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_key"\r\n\r\noffer_letters\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  const up = (type: string, filename: string, body: Buffer) =>
    app.inject({
      method: "POST",
      url: `/api/v1/cycles/${cycle}/metrics/5.2.1/evidence`,
      headers: { ...as("ev@e.edu"), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: mk(type, filename, body),
    });
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  beforeAll(async () => {
    cookies["ev@e.edu"] = await signIn("ev@e.edu");
    cycle = await newCycle("ev@e.edu");
  });

  it("SEC-10: bytes must match the declared type", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await up("image/png", "a.png", html)).statusCode).toBe(400);
    expect((await up("image/jpeg", "a.jpg", html)).statusCode).toBe(400);
    expect((await up("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", html)).statusCode).toBe(400);
    expect((await up("constructor", "a.bin", html)).statusCode).toBe(400); // not an inherited object key either
    expect((await up("image/png", "real.png", PNG)).statusCode).toBe(200);
    expect((await up("image/jpeg", "real.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("s").getCell("A1").value = 1;
    expect((await up("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "real.xlsx", Buffer.from(await wb.xlsx.writeBuffer()))).statusCode).toBe(200);
  });

  it("SEC-11: formula-looking cells are neutralised in the ZIP index", async () => {
    expect(csvCell("=HYPERLINK(\"http://evil\",\"x\")")).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    for (const p of ["+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(p).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell("offer.pdf")).toBe("offer.pdf");
    expect((await up("image/png", "=cmd.png", PNG)).statusCode).toBe(200);
    const zip = await app.inject({ url: `/api/v1/cycles/${cycle}/evidence.zip`, headers: as("ev@e.edu") });
    const z = await JSZip.loadAsync(zip.rawPayload);
    const csv = await z.files[Object.keys(z.files).find((n) => n.endsWith("_index.csv"))!].async("string");
    expect(csv).toContain(",'=cmd.png,");
    expect(csv).not.toMatch(/(^|,)=cmd/m);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-12 collection-link cap under concurrency", () => {
  it("never stores more submissions than max_submissions", async () => {
    cookies["cap@c.edu"] = await signIn("cap@c.edu");
    const cycle = await newCycle("cap@c.edu");
    const link = (await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/collection-links`, headers: as("cap@c.edu"), payload: {} })).json();
    const token = link.url.split("/collect/")[1];
    await db.query("UPDATE collection_link SET max_submissions = 1 WHERE id = $1", [link.id]);
    const ws = new Workspace(db, frameworks, new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-cap-"))));
    const col = new Collection(db, frameworks, ws);
    const row = (i: number) => ({ academic_year: "2024-25", student: `S${i}`, outcome: "Placed", employer_or_institution: "X" });
    const res = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => col.submit(token, { name: "dept", rows: [row(i)] })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM collection_submission WHERE link_id = $1", [link.id])).rows[0].n).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-13 sessions: idle timeout, sign out everywhere, purge", () => {
  it("a session unused for longer than the idle limit stops working", async () => {
    const c = await signIn("idle@s.edu");
    expect((await app.inject({ url: "/api/v1/me", headers: { cookie: c } })).statusCode).toBe(200);
    await db.query("UPDATE user_session SET last_seen_at = now() - interval '15 days' WHERE user_id = (SELECT id FROM app_user WHERE email = 'idle@s.edu')");
    expect((await app.inject({ url: "/api/v1/me", headers: { cookie: c } })).statusCode).toBe(401);
  });

  it("an active session is kept alive", async () => {
    const c = await signIn("active@s.edu");
    await db.query("UPDATE user_session SET last_seen_at = now() - interval '13 days' WHERE user_id = (SELECT id FROM app_user WHERE email = 'active@s.edu')");
    expect((await app.inject({ url: "/api/v1/me", headers: { cookie: c } })).statusCode).toBe(200);
    const seen = (await db.query<{ fresh: boolean }>("SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM user_session WHERE user_id = (SELECT id FROM app_user WHERE email = 'active@s.edu')")).rows[0];
    expect(seen.fresh).toBe(true);
  });

  it("sign out everywhere ends every session of the user", async () => {
    const laptop = await signIn("multi@s.edu");
    const phone = await signIn("multi@s.edu");
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/logout-all", headers: { cookie: laptop } });
    expect(r.json()).toEqual({ ok: true, sessions: 2 });
    expect((await app.inject({ url: "/api/v1/me", headers: { cookie: phone } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout-all" })).statusCode).toBe(401);
  });

  it("purge removes expired links and sessions and never-used accounts, and keeps invited ones", async () => {
    await db.query("INSERT INTO app_user (id, email, created_at) VALUES ('ghost', 'ghost@p.edu', now() - interval '40 days'), ('invitee', 'invitee@p.edu', now() - interval '40 days')");
    await db.query("INSERT INTO membership (user_id, college_id, role) VALUES ('invitee', $1, 'viewer')", [await workspaceOf("ev@e.edu")]);
    await db.query("INSERT INTO login_token (token_hash, user_id, expires_at) VALUES ('old', 'invitee', now() - interval '2 days')");
    const r = await purgeExpired(db, { idleDays: 14, unverifiedDays: 30 });
    expect(r.users).toBeGreaterThanOrEqual(1);
    const left = (await db.query<{ email: string }>("SELECT email FROM app_user WHERE id IN ('ghost', 'invitee')")).rows.map((x) => x.email);
    expect(left).toEqual(["invitee@p.edu"]);
    expect((await db.query("SELECT 1 FROM login_token WHERE token_hash = 'old'")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM user_session WHERE last_seen_at < now() - interval '14 days'")).rows).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-14 security events are logged", () => {
  it("logs sign-in, sign-in failure, sign-out and rate-limit events without secrets", async () => {
    const lines: Record<string, unknown>[] = [];
    const sink = new Writable({ write: (chunk, _e, cb) => (lines.push(JSON.parse(String(chunk))), cb()) });
    const boot = await bootstrapWithFrameworks({ publicUrl: "http://test.local" });
    const logged = await buildApp({
      cfg: boot.cfg,
      db: boot.db,
      frameworks: boot.frameworks,
      // The production logger (its redacting serializers), writing here instead of stdout.
      logger: createLogger({ logLevel: "info", logFormat: "json" }, sink),
      files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-log-"))),
      mailer,
    });
    mailer.sent = [];
    const r = await logged.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: "logged@l.edu" } });
    const link = new URL(/http\S+/.exec(mailer.sent[0].text)![0]);
    const v = await logged.inject({ url: link.pathname + link.search, headers: { cookie: `naac_login=${r.cookies.find((c) => c.name === "naac_login")!.value}` } });
    const session = v.cookies.find((c) => c.name === "naac_session")!.value;
    await logged.inject({ url: link.pathname + link.search }); // reused link
    await logged.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: `naac_session=${session}` } });
    for (let i = 0; i < 6; i++) await logged.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: "rl@l.edu" }, remoteAddress: "203.0.113.50" });
    const events = lines.map((l) => l.event).filter(Boolean);
    for (const e of ["auth.link_requested", "auth.login", "auth.login_failed", "auth.logout", "rate_limit.exceeded"]) expect(events).toContain(e);
    const all = lines.map((l) => JSON.stringify(l)).join("\n");
    expect(all).not.toContain(session);
    expect(all).not.toContain(link.searchParams.get("token")!);
    await logged.close();
    await boot.db.close();
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-15 / SEC-04 / SEC-05 / SEC-17 configuration guards", () => {
  const cfg = (o: object) => ({ ...loadConfig({ databaseUrl: "", publicUrl: "https://naac.example.in", appUrl: "https://naac.example.in", apiDocs: false }), ...o });
  const silent = pino({ level: "silent" });

  it("SEC-15: refuses to start in production without SMTP; dev still logs mail", () => {
    expect(() => createMailer(cfg({ smtp: { host: "", port: 587, user: "", pass: "", from: "x" } }), silent, "production")).toThrow(/SMTP_HOST must be set/);
    expect(() => createMailer(cfg({ smtp: { host: "", port: 587, user: "", pass: "", from: "x" } }), silent, "development")).not.toThrow();
  });

  it("warns about unverified database TLS, admin roles and remote databases outside production", () => {
    const w = securityWarnings(cfg({ databaseUrl: "postgres://avnadmin:x@pg-1.aivencloud.com:1/db?uselibpqcompat=true&sslmode=require" }), "development");
    expect(w.join("\n")).toMatch(/certificate is NOT verified/);
    expect(w.join("\n")).toMatch(/administrator "avnadmin"/);
    expect(w.join("\n")).toMatch(/remote database .* outside production/);
    expect(securityWarnings(cfg({ databaseUrl: "postgres://naac_app:x@pg-1.aivencloud.com:1/db?sslmode=verify-full&sslrootcert=ca.pem" }), "production")).toEqual([]);
    expect(securityWarnings(cfg({ databaseUrl: "postgres://naac:x@db:5432/naac" }), "production")).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("SEC-24 / SEC-26 / SEC-27", () => {
  it("SEC-24: share-only viewers do not see staff emails in narrative history", async () => {
    cookies["n.owner@n.edu"] = await signIn("n.owner@n.edu");
    const cycle = await newCycle("n.owner@n.edu");
    await app.inject({ method: "PUT", url: `/api/v1/cycles/${cycle}/metrics/7.3.1/narrative`, headers: as("n.owner@n.edu"), payload: { area: "a", description: "d" } });
    await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/shares`, headers: as("n.owner@n.edu"), payload: { email: "outside@o.edu", role: "viewer" } });
    cookies["outside@o.edu"] = await signIn("outside@o.edu");
    const theirs = (await app.inject({ url: `/api/v1/cycles/${cycle}/metrics/7.3.1/narrative/versions`, headers: as("outside@o.edu") })).json();
    expect(theirs).toHaveLength(1);
    expect(theirs[0].saved_by).toBeNull();
    const owners = (await app.inject({ url: `/api/v1/cycles/${cycle}/metrics/7.3.1/narrative/versions`, headers: as("n.owner@n.edu") })).json();
    expect(owners[0].saved_by).toBe("n.owner@n.edu");
  });

  it("SEC-26: a repeated query parameter on the public upload is a 400, not a crash", async () => {
    cookies["q@q2.edu"] = await signIn("q@q2.edu");
    const cycle = await newCycle("q@q2.edu");
    const link = (await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/collection-links`, headers: as("q@q2.edu"), payload: {} })).json();
    const token = link.url.split("/collect/")[1];
    const r = await app.inject({ method: "POST", url: `/api/v1/collect/${token}/upload?name=a&name=b`, headers: { "content-type": "multipart/form-data; boundary=x" }, payload: "--x--\r\n" });
    expect(r.statusCode).toBe(400);
  });

  it("SEC-27: a user can delete their account, workspace and files; others keep their data", async () => {
    cookies["leaver@d.edu"] = await signIn("leaver@d.edu");
    cookies["stayer@d.edu"] = await signIn("stayer@d.edu");
    const mine = await newCycle("leaver@d.edu");
    const theirs = await newCycle("stayer@d.edu");
    // The leaver also works in someone else's workspace.
    await app.inject({ method: "POST", url: `/api/v1/colleges/${await workspaceOf("stayer@d.edu")}/members`, headers: as("stayer@d.edu"), payload: { email: "leaver@d.edu", role: "viewer" } });
    const boundary = "----d";
    const pdf = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_key"\r\n\r\noffer_letters\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 x\r\n--${boundary}--\r\n`),
    ]);
    const ev = await app.inject({ method: "POST", url: `/api/v1/cycles/${mine}/metrics/5.2.1/evidence`, headers: { ...as("leaver@d.edu"), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: pdf });
    expect(ev.statusCode).toBe(200);
    const key = (await db.query<{ file_key: string }>("SELECT file_key FROM evidence WHERE id = $1", [ev.json().id])).rows[0].file_key;

    expect((await app.inject({ method: "DELETE", url: "/api/v1/me", headers: as("leaver@d.edu"), payload: { confirm_email: "someone@else.edu" } })).statusCode).toBe(400);
    const del = await app.inject({ method: "DELETE", url: "/api/v1/me", headers: as("leaver@d.edu"), payload: { confirm_email: "Leaver@d.edu" } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/me", headers: as("leaver@d.edu") })).statusCode).toBe(401);
    expect((await db.query("SELECT 1 FROM app_user WHERE email = 'leaver@d.edu'")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM cycle WHERE id = $1", [mine])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM evidence WHERE file_key = $1", [key])).rows).toHaveLength(0);
    expect((await app.inject({ url: `/api/v1/cycles/${theirs}`, headers: as("stayer@d.edu") })).statusCode).toBe(200);
  });
});
