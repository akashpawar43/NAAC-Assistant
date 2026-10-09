import ExcelJS from "exceljs";
import JSZip from "jszip";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Db } from "./db/client.js";
import { LocalFileStore } from "./infra/file-store.js";
import { MemoryMailer } from "./infra/mailer.js";
import { upsertUser } from "./services/auth.js";
import type { FrameworkRegistry } from "./services/frameworks.js";
import { bootstrapWithFrameworks } from "./testing/bootstrap.js";

process.env.NODE_ENV = "test";

let app: FastifyInstance;
let db: Db;
let frameworks: FrameworkRegistry;
const mailer = new MemoryMailer();
const FW = "demo_college";

// Every user signs up by email and gets a private workspace. Users A and B are separate people.
// dept@a / viewer@a are added to A's workspace directly in the DB to keep the sharing-ready
// role checks covered (the UI does not expose sharing yet).
const ids = { A: "", B: "" };
const cookies: Record<string, string> = {};

async function signIn(email: string): Promise<string> {
  mailer.sent = [];
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email } });
  expect(r.statusCode).toBe(200);
  const link = /http\S+/.exec(mailer.sent[0].text)![0];
  // Opened in the browser that asked for it: it holds the login cookie set above.
  const nonce = r.cookies.find((x) => x.name === "naac_login")!.value;
  const v = await app.inject({ method: "GET", url: new URL(link).pathname + new URL(link).search, headers: { cookie: `naac_login=${nonce}` } });
  expect(v.statusCode).toBe(302);
  const c = v.cookies.find((x) => x.name === "naac_session")!;
  return `naac_session=${c.value}`;
}

const as = (who: string) => ({ cookie: cookies[who] });

beforeAll(async () => {
  const boot = await bootstrapWithFrameworks({ publicUrl: "http://test.local", authRateLimitPerMin: 100 });
  db = boot.db;
  frameworks = boot.frameworks;
  app = await buildApp({
    cfg: boot.cfg,
    db,
    frameworks,
    logger: boot.logger,
    files: new LocalFileStore(mkdtempSync(join(tmpdir(), "naac-files-"))),
    mailer,
  });
  for (const e of ["admin@a.edu", "admin@b.edu", "dept@a.edu", "viewer@a.edu"]) cookies[e] = await signIn(e);
  const workspaceOf = async (email: string) =>
    (await app.inject({ url: "/api/v1/me", headers: as(email) })).json().memberships[0].college_id as string;
  ids.A = await workspaceOf("admin@a.edu");
  ids.B = await workspaceOf("admin@b.edu");
  for (const [email, role] of [["dept@a.edu", "dept_editor"], ["viewer@a.edu", "viewer"]]) {
    const uid = (await db.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email])).rows[0].id;
    await db.query("INSERT INTO membership (user_id, college_id, role) VALUES ($1,$2,$3)", [uid, ids.A, role]);
  }
}, 120000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("auth", () => {
  it("open sign-up: a new email gets a link, and the first sign-in creates a private workspace", async () => {
    mailer.sent = [];
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: "New.Person@X.edu" } });
    expect(r.statusCode).toBe(200);
    expect(mailer.sent.map((m) => m.to)).toEqual(["new.person@x.edu"]);
    const cookie = await signIn("new.person@x.edu");
    const me = (await app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    expect(me.memberships).toEqual([expect.objectContaining({ role: "iqac_admin", owned: true })]);
    // Signing in again reuses the same workspace.
    const again = (await app.inject({ url: "/api/v1/me", headers: { cookie: await signIn("new.person@x.edu") } })).json();
    expect(again.memberships.map((m: { college_id: string }) => m.college_id)).toEqual([me.memberships[0].college_id]);
    const cycles = await app.inject({ url: `/api/v1/colleges/${me.memberships[0].college_id}/cycles`, headers: { cookie } });
    expect(cycles.json()).toEqual([]);
  });

  it("an account from before open sign-up keeps its college and reports", async () => {
    const old = randomUUID();
    await db.query("INSERT INTO college (id, name) VALUES ($1, 'Old College')", [old]);
    const uid = await upsertUser(db, "old@x.edu");
    await db.query("INSERT INTO membership (user_id, college_id, role) VALUES ($1, $2, 'iqac_admin')", [uid, old]);
    const me = (await app.inject({ url: "/api/v1/me", headers: { cookie: await signIn("old@x.edu") } })).json();
    expect(me.memberships).toEqual([expect.objectContaining({ college_id: old, owned: true })]);
  });

  it("a magic link works only once", async () => {
    mailer.sent = [];
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/magic-link", payload: { email: "admin@a.edu" } });
    const headers = { cookie: `naac_login=${r.cookies.find((x) => x.name === "naac_login")!.value}` };
    const link = new URL(/http\S+/.exec(mailer.sent[0].text)![0]);
    const path = link.pathname + link.search;
    expect((await app.inject({ url: path, headers })).headers.location).toBe("http://test.local/"); // APP_URL defaults to PUBLIC_URL
    expect((await app.inject({ url: path, headers })).headers.location).toMatch(/login_error/);
  });

  it("requires a session", async () => {
    expect((await app.inject({ url: "/api/v1/me" })).statusCode).toBe(401);
    const me = await app.inject({ url: "/api/v1/me", headers: as("admin@a.edu") });
    expect(me.json().memberships.map((m: { college_id: string }) => m.college_id)).toEqual([ids.A]);
  });
});

describe("workspace", () => {
  let cycleA: string;

  it("a report needs a college name", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/colleges/${ids.A}/cycles`,
      headers: as("admin@a.edu"),
      payload: { kind: "AQAR", label: "x", last_year: "2024-25", framework_id: FW },
    });
    expect(r.statusCode).toBe(400);
  });

  it("admin creates an SSR cycle with five academic years", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/colleges/${ids.A}/cycles`,
      headers: as("admin@a.edu"),
      payload: { kind: "SSR", label: "SSR 2025", last_year: "2024-25", framework_id: FW, college_name: "Alpha College", state: "Kerala", institution_type: "Affiliated College" },
    });
    expect(r.statusCode).toBe(200);
    cycleA = r.json().id;
    expect(r.json().years).toEqual(["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"]);
  });

  it("tenant isolation: college B cannot read or write college A's cycle", async () => {
    for (const [method, url, payload] of [
      ["GET", `/api/v1/cycles/${cycleA}`, undefined],
      ["GET", `/api/v1/cycles/${cycleA}/metrics/5.2.1`, undefined],
      ["POST", `/api/v1/cycles/${cycleA}/metrics/5.2.1/rows`, { academic_year: "2024-25" }],
      ["GET", `/api/v1/colleges/${ids.A}/cycles`, undefined],
      ["GET", `/api/v1/cycles/${cycleA}/export.xlsx`, undefined],
    ] as const) {
      const r = await app.inject({ method, url, headers: as("admin@b.edu"), payload });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    const s = await app.inject({ url: `/api/v1/search?q=Asha&scope=mine&cycle_id=${cycleA}`, headers: as("admin@b.edu") });
    expect(s.statusCode).toBe(404);
  });

  it("extended profile + rows -> computed value; idempotent create", async () => {
    const inputs = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"].map((y) => ({ key: "outgoing_students", year: y, value: 10 }));
    expect((await app.inject({ method: "PUT", url: `/api/v1/cycles/${cycleA}/inputs`, headers: as("admin@a.edu"), payload: inputs })).statusCode).toBe(200);

    const rows = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"].flatMap((y) =>
      Array.from({ length: 5 }, (_, i) => ({ academic_year: y, student: `S${y}-${i}`, outcome: "Placed", employer_or_institution: "TCS" })),
    );
    const headers = { ...as("admin@a.edu"), "idempotency-key": "batch-1" };
    const r1 = await app.inject({ method: "POST", url: `/api/v1/cycles/${cycleA}/metrics/5.2.1/rows`, headers, payload: rows });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().computed.value).toBe(50);
    const r2 = await app.inject({ method: "POST", url: `/api/v1/cycles/${cycleA}/metrics/5.2.1/rows`, headers, payload: rows });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().replayed).toBe(true);
    const d = await app.inject({ url: `/api/v1/cycles/${cycleA}/metrics/5.2.1`, headers: as("admin@a.edu") });
    expect(d.json().rows).toHaveLength(25);
    expect(d.json().status).toBe("partial"); // evidence still missing
  });

  it("returns every validation error at once", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/cycles/${cycleA}/metrics/5.2.1/rows`,
      headers: as("admin@a.edu"),
      payload: [{ academic_year: "2010-11", student: "X", outcome: "Retired" }],
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().details.map((e: { field: string }) => e.field).sort()).toEqual(["academic_year", "employer_or_institution", "outcome"]);
  });

  it("roles: viewer cannot write; dept editor only on assigned metrics", async () => {
    const row = { academic_year: "2024-25", title: "P", authors: "A", journal: "J", ugc_care: "Yes" };
    const url = `/api/v1/cycles/${cycleA}/metrics/3.3.1/rows`;
    expect((await app.inject({ method: "POST", url, headers: as("viewer@a.edu"), payload: row })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: as("dept@a.edu"), payload: row })).statusCode).toBe(403);
    const me = (await app.inject({ url: "/api/v1/me", headers: as("dept@a.edu") })).json();
    await app.inject({ method: "PUT", url: `/api/v1/cycles/${cycleA}/metrics/3.3.1/assign`, headers: as("admin@a.edu"), payload: { user_id: me.user.id } });
    expect((await app.inject({ method: "POST", url, headers: as("dept@a.edu"), payload: row })).statusCode).toBe(201);
  });

  it("Excel template -> import (validate, then commit) round trip", async () => {
    const t = await app.inject({ url: `/api/v1/cycles/${cycleA}/metrics/3.1.1/template.xlsx`, headers: as("admin@a.edu") });
    expect(t.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(t.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const header = (ws.getRow(1).values as string[]).slice(1);
    expect(header[0]).toMatch(/Academic year/);
    ws.addRow(["2023-24", "Water study", "Dr X", "DST", "Government", 12.5]);
    ws.addRow(["2024-25", "Soil study", "Dr Y", "ICSSR", "Government", "7.5"]);
    ws.addRow(["2024-25", "Bad row", "", "", "Government", "abc"]);
    const file = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = (commit: boolean) => {
      const boundary = "----naac" + Math.random().toString(16).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
        file,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({
        method: "POST",
        url: `/api/v1/cycles/${cycleA}/metrics/3.1.1/import?commit=${commit}`,
        headers: { ...as("admin@a.edu"), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
    };
    const dry = (await upload(false)).json();
    expect(dry).toMatchObject({ total: 3, valid: 2, committed: false });
    let badRow = 0;
    ws.eachRow((row, n) => {
      if (row.getCell(2).value === "Bad row") badRow = n;
    });
    expect(badRow).toBeGreaterThan(1);
    expect(dry.errors.every((e: { row: number }) => e.row === badRow)).toBe(true);
    const commit = (await upload(true)).json();
    expect(commit.committed).toBe(false); // errors block commit
    ws.getRow(badRow).values = [];
    const fixed = Buffer.from(await wb.xlsx.writeBuffer());
    const again = await (async () => {
      const boundary = "----naac2";
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        fixed,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({
        method: "POST",
        url: `/api/v1/cycles/${cycleA}/metrics/3.1.1/import?commit=true&mode=replace`,
        headers: { ...as("admin@a.edu"), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
    })();
    expect(again.json()).toMatchObject({ valid: 2, committed: true });
    const d = await app.inject({ url: `/api/v1/cycles/${cycleA}/metrics/3.1.1`, headers: as("admin@a.edu") });
    expect(d.json().computed.value).toBe(20);
  });

  it("narrative save + draft preview with facts", async () => {
    const fields = { title: "Earn and learn", objectives: "o", context: "c", practice: "p", evidence: "e", problems: "none" };
    const s = await app.inject({ method: "PUT", url: `/api/v1/cycles/${cycleA}/metrics/7.2.1/narrative`, headers: as("admin@a.edu"), payload: fields });
    expect(s.statusCode).toBe(200);
    expect(s.json().status).toBe("partial");
    const p = await app.inject({
      method: "POST",
      url: `/api/v1/cycles/${cycleA}/metrics/7.2.1/narrative/preview`,
      headers: as("admin@a.edu"),
      payload: { fields, fact_metrics: ["5.2.1"] },
    });
    expect(p.json().text).toContain("Practice: Earn and learn");
    expect(p.json().text).toMatch(/placement.*50 %/i);
    expect(p.json().is_draft).toBe(true);
  });

  it("evidence upload is type-checked and stays inside the tenant", async () => {
    const boundary = "----ev";
    const mk = (type: string, content: string) =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_key"\r\n\r\noffer_letters\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="offer.pdf"\r\nContent-Type: ${type}\r\n\r\n`),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const headers = { ...as("admin@a.edu"), "content-type": `multipart/form-data; boundary=${boundary}` };
    const url = `/api/v1/cycles/${cycleA}/metrics/5.2.1/evidence`;
    expect((await app.inject({ method: "POST", url, headers, payload: mk("text/html", "<script>") })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers, payload: mk("application/pdf", "not a pdf") })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url, headers, payload: mk("application/pdf", "%PDF-1.4 test") });
    expect(ok.statusCode).toBe(200);
    const evId = ok.json().id;
    expect((await app.inject({ url: `/api/v1/cycles/${cycleA}/evidence/${evId}`, headers: as("admin@a.edu") })).body).toBe("%PDF-1.4 test");
    expect((await app.inject({ url: `/api/v1/cycles/${cycleA}/evidence/${evId}`, headers: as("admin@b.edu") })).statusCode).toBe(404);
  });

  it("dashboard, review checklist and export", async () => {
    const d = (await app.inject({ url: `/api/v1/cycles/${cycleA}`, headers: as("viewer@a.edu") })).json();
    expect(d.readiness_pct).toBeGreaterThan(0);
    expect(d.criteria).toHaveLength(7);
    const c = (await app.inject({ url: `/api/v1/cycles/${cycleA}/review-checklist`, headers: as("admin@a.edu") })).json();
    expect(c.summary.high).toBeGreaterThan(0);
    const x = await app.inject({ url: `/api/v1/cycles/${cycleA}/export.xlsx`, headers: as("admin@a.edu") });
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(["Summary", "Extended profile", "5.2.1", "3.1.1", "Narratives"]));
    const sheet = wb.getWorksheet("5.2.1")!;
    expect(String(sheet.getCell("A2").value)).toContain("50");
  });

  it("carry-forward copies narratives and non-yearly inputs into the next cycle", async () => {
    const next = (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${ids.A}/cycles`,
        headers: as("admin@a.edu"),
        payload: { kind: "AQAR", label: "AQAR 2025-26", last_year: "2025-26", framework_id: FW, previous_cycle_id: cycleA, college_name: "Alpha College" },
      })
    ).json();
    const r = await app.inject({ method: "POST", url: `/api/v1/cycles/${next.id}/carry-forward`, headers: as("admin@a.edu") });
    expect(r.json().entries).toBeGreaterThanOrEqual(1);
    const d = (await app.inject({ url: `/api/v1/cycles/${next.id}/metrics/7.2.1`, headers: as("admin@a.edu") })).json();
    expect(d.narrative.title).toBe("Earn and learn");
  });
});

describe("search and corpus", () => {
  beforeAll(async () => {
    await db.query("INSERT INTO naac_college (key, aishe_id, name, state, institution_type) VALUES ('C-1','C-1','Alpha College','Kerala','Affiliated College'), ('C-2','C-2','Beta College','Kerala','Affiliated College')");
    for (const [sha, key, grade, rank, aid] of [
      ["s1", "C-1", "A+", 7, 1],
      ["s2", "C-2", "B", 3, 2],
    ] as const) {
      await db.query(
        "INSERT INTO ssr_doc (sha256, kind, college_key, assessment_id, grade, grade_rank, is_raf, is_latest, raf_markers, extract_status, iiqa_date) VALUES ($1,'ssr',$2,$3,$4,$5,true,true,10,'ok','2023-05-01')",
        [sha, key, aid, grade, rank],
      );
    }
    await db.query("INSERT INTO criterion_score (assessment_id, criterion, weight, points, gpa) VALUES (1,'5',100,350,3.5),(2,'5',100,150,1.5)");
    await db.query(
      `INSERT INTO ssr_chunk (doc_sha, metric_id, title, page_from, page_to, text, response_value, confidence) VALUES
       ('s1','5.2.1','Percentage of placement',40,41,'Placement cell organised campus recruitment drives with 40 companies',62.5,0.9),
       ('s2','5.2.1','Percentage of placement',30,30,'Students were placed through the placement cell',20,0.85),
       ('s2','5.2.1','junk',31,31,'low confidence text placement',99,0.3)`,
    );
  });

  it("peer examples are ranked by criterion score and exclude low-confidence chunks", async () => {
    const r = (await app.inject({ url: "/api/v1/metrics/5.2.1/peer-examples?state=kerala", headers: as("admin@a.edu") })).json();
    expect(r.map((x: { college: string }) => x.college)).toEqual(["Alpha College", "Beta College"]);
    expect(r[0].citation).toBe("Alpha College (Kerala), SSR 2023, pages 40-41");
    const g = (await app.inject({ url: "/api/v1/metrics/5.2.1/peer-examples?min_grade=A", headers: as("admin@a.edu") })).json();
    expect(g).toHaveLength(1);
    expect((await app.inject({ url: "/api/v1/metrics/5.2.1/peer-examples?min_grade=Z", headers: as("admin@a.edu") })).statusCode).toBe(400);
  });

  it("benchmark shows the distribution and the college's percentile", async () => {
    const cycles = (await app.inject({ url: `/api/v1/colleges/${ids.A}/cycles`, headers: as("admin@a.edu") })).json();
    const ssr = cycles.find((c: { kind: string }) => c.kind === "SSR");
    const b = (await app.inject({ url: `/api/v1/metrics/5.2.1/benchmark?cycle_id=${ssr.id}`, headers: as("admin@a.edu") })).json();
    expect(b).toMatchObject({ sample_size: 2, median: 41.25, yours: 50, your_percentile: 50 });
  });

  it("search finds explainers by metric id and words, peers with synonyms, and the college's own data", async () => {
    const byId = (await app.inject({ url: "/api/v1/search?q=3.3.1", headers: as("admin@a.edu") })).json();
    expect(byId.results.help[0].metric_id).toBe("3.3.1");
    const words = (await app.inject({ url: "/api/v1/search?q=campus%20recruitment&scope=peers", headers: as("admin@a.edu") })).json();
    expect(words.results.peers[0].college).toBe("Alpha College");
    const typo = (await app.inject({ url: "/api/v1/search?q=placemnt%20percentag&scope=help", headers: as("admin@a.edu") })).json();
    expect(typo.results.help.length).toBeGreaterThan(0);
    const cycles = (await app.inject({ url: `/api/v1/colleges/${ids.A}/cycles`, headers: as("admin@a.edu") })).json();
    const mine = (await app.inject({ url: `/api/v1/search?q=TCS&scope=mine&cycle_id=${cycles[0].id}`, headers: as("admin@a.edu") })).json();
    expect(Array.isArray(mine.results.mine)).toBe(true);
  });
});


describe("report settings", () => {
  it("edits college details and deletes a report with its files; other users cannot", async () => {
    const r = (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${ids.B}/cycles`,
        headers: as("admin@b.edu"),
        payload: { kind: "AQAR", label: "AQAR 2024-25", last_year: "2024-25", framework_id: FW, college_name: "Beta College" },
      })
    ).json();
    const patch = await app.inject({ method: "PATCH", url: `/api/v1/cycles/${r.id}`, headers: as("admin@b.edu"), payload: { state: "Goa", college_name: "Beta College, Panaji" } });
    expect(patch.json()).toMatchObject({ college_name: "Beta College, Panaji", state: "Goa", label: "AQAR 2024-25" });
    expect((await app.inject({ method: "PATCH", url: `/api/v1/cycles/${r.id}`, headers: as("admin@a.edu"), payload: { state: "X" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/cycles/${r.id}`, headers: as("admin@a.edu") })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/cycles/${r.id}`, headers: as("admin@b.edu") })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/cycles/${r.id}`, headers: as("admin@b.edu") })).statusCode).toBe(404);
  });
});

describe("exports", () => {
  let cycle = "";
  const get = (path: string, who = "admin@a.edu") => app.inject({ url: `/api/v1/cycles/${cycle}/${path}`, headers: as(who) });
  beforeAll(async () => {
    const cycles = (await app.inject({ url: `/api/v1/colleges/${ids.A}/cycles`, headers: as("admin@a.edu") })).json();
    cycle = cycles.find((c: { kind: string }) => c.kind === "SSR").id;
  });

  it("Excel respects a criterion selection", async () => {
    const r = await get("export.xlsx?criteria=5");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toContain("Alpha College - SSR 2025 - Criterion 5.xlsx");
    expect((await get("export.docx?criteria=5,7")).headers["content-disposition"]).toContain("Criterion 5, 7.docx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("5.2.1");
    expect(names).not.toContain("3.1.1");
    // 5.4.1 (alumni) is criterion 5's narrative metric; criterion 7's must not appear.
    wb.getWorksheet("Narratives")?.eachRow((row) => expect(String(row.getCell(1).value)).not.toMatch(/^7\./));
    expect(String(wb.getWorksheet("Summary")!.getCell("A2").value)).toBe("Selection: Criterion 5");
  });

  it("Word contains the chosen metrics, their rows and narratives, and nothing else", async () => {
    const r = await get("export.docx?metrics=5.2.1,7.2.1");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("wordprocessingml");
    const zip = await JSZip.loadAsync(r.rawPayload);
    const xml = await zip.file("word/document.xml")!.async("string");
    const text = xml.replace(/<[^>]+>/g, " ");
    expect(text).toContain("5.2.1 Placement and progression");
    expect(text).toContain("Earn and learn"); // 7.2.1 narrative
    expect(text).toContain("TCS"); // a 5.2.1 data row
    expect(text).toContain("offer.pdf"); // evidence list
    expect(text).not.toContain("3.1.1 Research grants");
  });

  it("PDF is a valid document", async () => {
    const r = await get("export.pdf?criteria=5,7");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(r.rawPayload.length).toBeGreaterThan(5000);
  });

  it("evidence ZIP has files in criterion/metric folders and an index of missing documents", async () => {
    const r = await get("evidence.zip");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    const zip = await JSZip.loadAsync(r.rawPayload);
    const names = Object.keys(zip.files);
    const pdf = names.find((n) => n.endsWith("Criterion 5 - Students/5.2.1/Offer or admission letters/offer.pdf"));
    expect(pdf).toBeTruthy();
    expect(await zip.file(pdf!)!.async("string")).toBe("%PDF-1.4 test");
    const index = await zip.file(names.find((n) => n.endsWith("_index.csv"))!)!.async("string");
    expect(index).toContain("5.2.1");
    expect(index).toMatch(/Placement list \(Excel\),MISSING/);
  });

  it("rejects bad selections and empty evidence, and stays inside the tenant", async () => {
    expect((await get("export.docx?criteria=9")).statusCode).toBe(400);
    expect((await get("export.docx?metrics=9.9")).statusCode).toBe(400);
    expect((await get("evidence.zip?criteria=3")).json().message).toMatch(/No evidence/);
    expect((await get("export.pdf?status=complete&criteria=1")).statusCode).toBe(400); // nothing matches
    expect((await get("export.docx", "admin@b.edu")).statusCode).toBe(404);
    expect((await get("evidence.zip", "admin@b.edu")).statusCode).toBe(404);
  });
});

describe("narrative history", () => {
  let cycle = "";
  const base = () => `/api/v1/cycles/${cycle}/metrics/7.3.1/narrative`;
  const save = (fields: Record<string, string>, who = "admin@a.edu") => app.inject({ method: "PUT", url: base(), headers: as(who), payload: fields });
  const versions = async (who = "admin@a.edu") => (await app.inject({ url: `${base()}/versions`, headers: as(who) })).json();
  // Simulates time passing so the next save starts a new editing session (no real waiting).
  const ageVersions = () => db.query("UPDATE narrative_version SET saved_at = saved_at - interval '1 hour'");

  beforeAll(async () => {
    const cycles = (await app.inject({ url: `/api/v1/colleges/${ids.A}/cycles`, headers: as("admin@a.edu") })).json();
    cycle = cycles.find((c: { kind: string }) => c.kind === "SSR").id;
  });

  it("autosaves within one session merge into one version; unchanged saves add nothing", async () => {
    await save({ area: "Rural outreach", description: "First draft" });
    await save({ area: "Rural outreach", description: "First draft, longer" });
    await save({ area: "Rural outreach", description: "First draft, longer" });
    const v = await versions();
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ saved_by: "admin@a.edu", preview: expect.stringContaining("longer") });
  });

  it("a later session starts a new version, and restore brings old text back as a new version", async () => {
    await ageVersions();
    await save({ area: "Rural outreach", description: "Rewritten completely" });
    const v = await versions();
    expect(v).toHaveLength(2);
    const old = v[1];
    expect((await app.inject({ url: `${base()}/versions/${old.id}`, headers: as("admin@a.edu") })).json().description).toBe("First draft, longer");
    await ageVersions();
    const r = await app.inject({ method: "POST", url: `${base()}/versions/${old.id}/restore`, headers: as("admin@a.edu") });
    expect(r.statusCode).toBe(200);
    const detail = (await app.inject({ url: `/api/v1/cycles/${cycle}/metrics/7.3.1`, headers: as("admin@a.edu") })).json();
    expect(detail.narrative.description).toBe("First draft, longer");
    expect(await versions()).toHaveLength(3);
  });

  it("keeps at most 50 versions", async () => {
    const entry = (await db.query<{ id: string }>("SELECT id FROM metric_entry WHERE cycle_id = $1 AND metric_id = '7.3.1'", [cycle])).rows[0].id;
    for (let i = 0; i < 55; i++) {
      await db.query(
        "INSERT INTO narrative_version (entry_id, college_id, fields, saved_at) VALUES ($1, $2, $3::jsonb, now() - make_interval(days => $4))",
        [entry, ids.A, JSON.stringify({ area: `old ${i}`, description: "x" }), 10 + i],
      );
    }
    await ageVersions();
    await save({ area: "Newest", description: "x" });
    const v = await versions();
    expect(v).toHaveLength(50);
    expect(v[0].preview).toContain("Newest");
  });

  it("other users cannot see or restore versions; viewers cannot restore", async () => {
    const [first] = await versions();
    expect((await app.inject({ url: `${base()}/versions`, headers: as("admin@b.edu") })).statusCode).toBe(404);
    expect((await app.inject({ url: `${base()}/versions/${first.id}`, headers: as("admin@b.edu") })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${base()}/versions/${first.id}/restore`, headers: as("viewer@a.edu") })).statusCode).toBe(403);
    expect((await app.inject({ url: `${base()}/versions/999999`, headers: as("admin@a.edu") })).statusCode).toBe(404);
    expect((await app.inject({ url: `${base()}/versions/abc`, headers: as("admin@a.edu") })).statusCode).toBe(400);
  });
});

describe("one workbook for all metrics", () => {
  let cycle = "";
  const YEARS = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"];
  const upload = (buf: Buffer, query: string, who = "admin@b.edu") => {
    const boundary = "----wb" + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="wb.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: "POST",
      url: `/api/v1/cycles/${cycle}/workbook/import?${query}`,
      headers: { ...as(who), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
  };
  const download = async () => {
    const r = await app.inject({ url: `/api/v1/cycles/${cycle}/workbook.xlsx`, headers: as("admin@b.edu") });
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    return wb;
  };
  const toBuffer = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());
  const value = async (metric: string) =>
    (await app.inject({ url: `/api/v1/cycles/${cycle}/metrics/${metric}`, headers: as("admin@b.edu") })).json();

  beforeAll(async () => {
    cycle = (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${ids.B}/cycles`,
        headers: as("admin@b.edu"),
        payload: { kind: "SSR", label: "SSR WB", last_year: "2024-25", framework_id: FW, college_name: "Beta College" },
      })
    ).json().id;
  });

  /** Fills the profile and two metric sheets of a freshly downloaded workbook. */
  async function filledWorkbook() {
    const wb = await download();
    const ep = wb.getWorksheet("Extended profile")!;
    ep.eachRow((row, n) => {
      if (n > 1 && row.getCell(2).value === "outgoing_students") YEARS.forEach((_, i) => (row.getCell(3 + i).value = 100));
    });
    const p = wb.getWorksheet("5.2.1")!;
    YEARS.forEach((y, i) => p.getRow(2 + i).values = [y, `Student ${i}`, "BSc", "Placed", "Infosys", 4]);
    wb.getWorksheet("3.1.1")!.getRow(2).values = ["2024-25", "Solar study", "Dr X", "DST", "Government", 10];
    return wb;
  }

  it("downloads one sheet per data metric plus profile and read-me", async () => {
    const names = (await download()).worksheets.map((w) => w.name);
    expect(names.slice(0, 2)).toEqual(["Read me", "Extended profile"]);
    expect(names).toEqual(expect.arrayContaining(["5.2.1", "3.1.1", "3.3.1"]));
    expect(names).not.toContain("7.2.1"); // narratives are not data sheets
  });

  it("check-only reports per sheet and writes nothing; commit writes everything", async () => {
    const buf = await toBuffer(await filledWorkbook());
    const dry = (await upload(buf, "commit=false&mode=replace")).json();
    expect(dry).toMatchObject({ committed: false, error_count: 0, profile: { values: 5 } });
    const bySheet = Object.fromEntries(dry.sheets.map((s: { metric_id: string }) => [s.metric_id, s]));
    expect(bySheet["5.2.1"]).toMatchObject({ in_file: 5, valid: 5, action: "replace" });
    expect(bySheet["3.3.1"]).toMatchObject({ in_file: 0, action: "unchanged" });
    expect((await value("5.2.1")).rows).toHaveLength(0);

    const done = (await upload(buf, "commit=true&mode=replace")).json();
    expect(done.committed).toBe(true);
    expect((await value("5.2.1")).computed.value).toBe(1); // 1 placed of 100 outgoing, every year
    expect((await value("3.1.1")).computed.value).toBe(10);
  });

  it("the downloaded workbook comes back pre-filled, so a round trip changes nothing", async () => {
    const wb = await download();
    expect(wb.getWorksheet("5.2.1")!.getRow(2).getCell(2).value).toBe("Student 0");
    const r = (await upload(await toBuffer(wb), "commit=true&mode=replace")).json();
    expect(r.committed).toBe(true);
    expect((await value("5.2.1")).rows).toHaveLength(5);
  });

  it("one bad row anywhere blocks the whole import", async () => {
    const wb = await filledWorkbook();
    wb.getWorksheet("5.2.1")!.getRow(2).getCell(2).value = "Changed name";
    wb.getWorksheet("3.1.1")!.getRow(3).values = ["2024-25", "Bad grant", "Dr Y", "DST", "Government", "lots"];
    const r = (await upload(await toBuffer(wb), "commit=true&mode=replace")).json();
    expect(r.committed).toBe(false);
    expect(r.error_count).toBe(1);
    const bad = r.sheets.find((s: { metric_id: string }) => s.metric_id === "3.1.1");
    expect(bad.errors[0]).toMatchObject({ row: 3, field: "amount_lakhs" });
    expect((await value("5.2.1")).rows.map((x: { data: { student: string } }) => x.data.student)).not.toContain("Changed name");
  });

  it("a blank template never wipes data, and append mode catches duplicates", async () => {
    const blank = new ExcelJS.Workbook();
    const sheet = blank.addWorksheet("5.2.1");
    sheet.addRow(["Academic year *", "Student *", "Programme", "Outcome *", "Joined (employer or institution) *", "Salary package (LPA)"]);
    const r = (await upload(await toBuffer(blank), "commit=true&mode=replace")).json();
    expect(r.sheets[0].action).toBe("unchanged");
    expect((await value("5.2.1")).rows).toHaveLength(5);

    sheet.addRow(["2024-25", "Student 4", "BSc", "Placed", "TCS", 5]); // same year + student as an existing row
    const dup = (await upload(await toBuffer(blank), "commit=false&mode=append")).json();
    expect(dup.sheets[0].errors[0].message).toMatch(/Duplicate/);
  });

  it("reports profile errors and unknown sheets; only the owner may import", async () => {
    const wb = await download();
    wb.getWorksheet("Extended profile")!.eachRow((row, n) => {
      if (n > 1 && row.getCell(2).value === "teachers_fulltime") row.getCell(3).value = "forty";
    });
    wb.addWorksheet("My notes").addRow(["hello"]);
    const r = (await upload(await toBuffer(wb), "commit=true&mode=replace")).json();
    expect(r.committed).toBe(false);
    expect(r.profile.errors[0].message).toMatch(/forty/);
    expect(r.ignored_sheets).toEqual(["My notes"]);
    expect((await upload(await toBuffer(wb), "commit=false", "admin@a.edu")).statusCode).toBe(404);
    expect((await upload(Buffer.from("not excel"), "commit=false")).statusCode).toBe(400);
  });
});

describe("build SSR from AQARs", () => {
  const newCycle = async (kind: "AQAR" | "SSR", lastYear: string, college: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${ids.B}/cycles`,
        headers: as("admin@b.edu"),
        payload: { kind, label: `${kind} ${lastYear}`, last_year: lastYear, framework_id: FW, college_name: college },
      })
    ).json().id as string;
  const post = (url: string, payload?: object) => app.inject({ method: "POST", url, headers: as("admin@b.edu"), ...(payload ? { payload } : {}) });
  let ssr = "";

  beforeAll(async () => {
    for (const [year, students] of [["2023-24", ["A", "B"]], ["2024-25", ["C"]]] as const) {
      const aq = await newCycle("AQAR", year, "Gamma College");
      await post(`/api/v1/cycles/${aq}/metrics/5.2.1/rows`, students.map((s) => ({ academic_year: year, student: s, outcome: "Placed", employer_or_institution: "TCS" })));
      await app.inject({ method: "PUT", url: `/api/v1/cycles/${aq}/inputs`, headers: as("admin@b.edu"), payload: [{ key: "outgoing_students", year, value: 10 }] });
      await app.inject({ method: "PUT", url: `/api/v1/cycles/${aq}/metrics/7.3.1/narrative`, headers: as("admin@b.edu"), payload: { area: `Area ${year}`, description: "d" } });
    }
    const other = await newCycle("AQAR", "2024-25", "Some Other College");
    await post(`/api/v1/cycles/${other}/metrics/5.2.1/rows`, { academic_year: "2024-25", student: "Z", outcome: "Placed", employer_or_institution: "X" });
    ssr = await newCycle("SSR", "2024-25", "gamma college ");
  });

  it("previews which AQARs, rows, profile values and narratives will be used", async () => {
    const p = (await app.inject({ url: `/api/v1/cycles/${ssr}/fill-from-aqars`, headers: as("admin@b.edu") })).json();
    expect(p.sources.map((s: { year: string }) => s.year)).toEqual(["2023-24", "2024-25"]);
    expect(p.years_without_aqar).toEqual(["2020-21", "2021-22", "2022-23"]);
    expect(p.rows).toEqual([{ metric_id: "5.2.1", add: 3, duplicates: 0 }]); // not the other college's row
    expect(p.inputs).toBe(2);
    expect(p.answers).toEqual([{ metric_id: "7.3.1", from: "AQAR 2024-25" }]);
    const detail = (await app.inject({ url: `/api/v1/cycles/${ssr}/metrics/5.2.1`, headers: as("admin@b.edu") })).json();
    expect(detail.rows).toHaveLength(0); // preview writes nothing
  });

  it("fills the SSR, and running it again adds nothing", async () => {
    expect((await post(`/api/v1/cycles/${ssr}/fill-from-aqars`)).statusCode).toBe(200);
    const d = (await app.inject({ url: `/api/v1/cycles/${ssr}/metrics/5.2.1`, headers: as("admin@b.edu") })).json();
    expect(d.rows.map((r: { data: { student: string } }) => r.data.student)).toEqual(["A", "B", "C"]);
    const n = (await app.inject({ url: `/api/v1/cycles/${ssr}/metrics/7.3.1`, headers: as("admin@b.edu") })).json();
    expect(n.narrative.area).toBe("Area 2024-25");
    const again = (await post(`/api/v1/cycles/${ssr}/fill-from-aqars`)).json();
    expect(again.rows).toEqual([{ metric_id: "5.2.1", add: 0, duplicates: 3 }]);
    expect(again.inputs).toBe(0);
    expect(again.answers).toEqual([]);
  });

  it("only works on an SSR, and only for its owner", async () => {
    const aq = await newCycle("AQAR", "2022-23", "Gamma College");
    expect((await app.inject({ url: `/api/v1/cycles/${aq}/fill-from-aqars`, headers: as("admin@b.edu") })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/v1/cycles/${ssr}/fill-from-aqars`, headers: as("admin@a.edu") })).statusCode).toBe(404);
  });
});

describe("report sharing", () => {
  let cycle = "";
  let other = ""; // another report of the same owner, never shared
  const owner = "admin@b.edu";
  const people = ["share.editor@x.edu", "share.viewer@x.edu", "stranger@x.edu"];
  const uid = async (email: string) => (await db.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [email])).rows[0].id;
  const req = (who: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: as(who), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    for (const e of people) cookies[e] = await signIn(e);
    const mk = async (label: string) =>
      (
        await req(owner, "POST", `/api/v1/colleges/${ids.B}/cycles`, { kind: "SSR", label, last_year: "2024-25", framework_id: FW, college_name: "Delta College" })
      ).json().id as string;
    cycle = await mk("Shared SSR");
    other = await mk("Private SSR");
    mailer.sent = [];
    expect((await req(owner, "POST", `/api/v1/cycles/${cycle}/shares`, { email: "share.editor@x.edu", role: "editor" })).statusCode).toBe(200);
    expect((await req(owner, "POST", `/api/v1/cycles/${cycle}/shares`, { email: "Share.Viewer@x.edu", role: "viewer" })).statusCode).toBe(200);
  });

  it("emails a notice once per new share or role change", async () => {
    expect(mailer.sent.map((m) => m.to)).toEqual(["share.editor@x.edu", "share.viewer@x.edu"]);
    mailer.sent = [];
    await req(owner, "POST", `/api/v1/cycles/${cycle}/shares`, { email: "share.viewer@x.edu", role: "viewer" });
    expect(mailer.sent).toHaveLength(0);
  });

  it("access matrix: what owner, editor, viewer and stranger can do", async () => {
    const row = { academic_year: "2024-25", student: "S", outcome: "Placed", employer_or_institution: "X" };
    const actions: [string, (who: string) => Promise<{ statusCode: number }>][] = [
      ["view report", (w) => req(w, "GET", `/api/v1/cycles/${cycle}`)],
      ["view metric", (w) => req(w, "GET", `/api/v1/cycles/${cycle}/metrics/5.2.1`)],
      ["export word", (w) => req(w, "GET", `/api/v1/cycles/${cycle}/export.docx`)],
      ["add rows", (w) => req(w, "POST", `/api/v1/cycles/${cycle}/metrics/5.2.1/rows`, { ...row, student: `S-${w}` })],
      ["write narrative", (w) => req(w, "PUT", `/api/v1/cycles/${cycle}/metrics/7.3.1/narrative`, { area: w, description: "d" })],
      ["set profile", (w) => req(w, "PUT", `/api/v1/cycles/${cycle}/inputs`, [{ key: "outgoing_students", year: "2024-25", value: 5 }])],
      ["rename report", (w) => req(w, "PATCH", `/api/v1/cycles/${cycle}`, { label: "x" })],
      ["see shares", (w) => req(w, "GET", `/api/v1/cycles/${cycle}/shares`)],
      ["share further", (w) => req(w, "POST", `/api/v1/cycles/${cycle}/shares`, { email: "z@x.edu", role: "viewer" })],
      ["fill from AQARs", (w) => req(w, "GET", `/api/v1/cycles/${cycle}/fill-from-aqars`)],
      ["owner's other report", (w) => req(w, "GET", `/api/v1/cycles/${other}`)],
      ["owner's report list", (w) => req(w, "GET", `/api/v1/colleges/${ids.B}/cycles`)],
    ];
    const expected: Record<string, number[]> = {
      // owner, editor, viewer, stranger
      "view report": [200, 200, 200, 404],
      "view metric": [200, 200, 200, 404],
      "export word": [200, 200, 200, 404],
      "add rows": [201, 201, 403, 404],
      "write narrative": [200, 200, 403, 404],
      "set profile": [200, 200, 403, 404],
      "rename report": [200, 403, 403, 404],
      "see shares": [200, 403, 403, 404],
      "share further": [200, 403, 403, 404],
      "fill from AQARs": [200, 403, 403, 404],
      "owner's other report": [200, 404, 404, 404],
      "owner's report list": [200, 404, 404, 404],
    };
    const who = [owner, ...people];
    const actual: Record<string, number[]> = {};
    for (const [name, run] of actions) {
      actual[name] = [];
      for (const w of who) actual[name].push((await run(w)).statusCode);
    }
    expect(actual).toEqual(expected);
    const detail = (await req("share.editor@x.edu", "GET", `/api/v1/cycles/${cycle}/metrics/5.2.1`)).json();
    expect(detail.can_edit).toBe(true);
    expect((await req("share.viewer@x.edu", "GET", `/api/v1/cycles/${cycle}/metrics/5.2.1`)).json().can_edit).toBe(false);
  });

  it("lists shared reports for the recipient, with owner and access", async () => {
    const list = (await req("share.viewer@x.edu", "GET", "/api/v1/shared-reports")).json();
    expect(list).toEqual([expect.objectContaining({ id: cycle, access: "viewer", owner_email: owner, college_name: "Delta College" })]);
    expect((await req("stranger@x.edu", "GET", "/api/v1/shared-reports")).json()).toEqual([]);
  });

  it("rejects sharing with yourself, and revoking removes access immediately", async () => {
    expect((await req(owner, "POST", `/api/v1/cycles/${cycle}/shares`, { email: owner, role: "viewer" })).statusCode).toBe(400);
    const v = await uid("share.viewer@x.edu");
    expect((await req(owner, "DELETE", `/api/v1/cycles/${cycle}/shares/${v}`)).statusCode).toBe(200);
    expect((await req("share.viewer@x.edu", "GET", `/api/v1/cycles/${cycle}`)).statusCode).toBe(404);
    expect((await req(owner, "DELETE", `/api/v1/cycles/${cycle}/shares/${v}`)).statusCode).toBe(404);
  });
});

describe("collection links", () => {
  let cycle = "";
  let link: { id: string; url: string };
  const token = () => link.url.split("/collect/")[1];
  const pub = (method: "GET" | "POST", path: string, payload?: object) => app.inject({ method, url: `/api/v1/collect/${path}`, ...(payload ? { payload } : {}) });
  const owner = (method: "GET" | "POST" | "DELETE", path: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/cycles/${cycle}/${path}`, headers: as("admin@b.edu"), ...(payload ? { payload } : {}) });
  const row = (student: string) => ({ academic_year: "2024-25", student, outcome: "Placed", employer_or_institution: "Wipro" });

  beforeAll(async () => {
    cycle = (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${ids.B}/cycles`,
        headers: as("admin@b.edu"),
        payload: { kind: "AQAR", label: "AQAR links", last_year: "2024-25", framework_id: FW, college_name: "Epsilon College" },
      })
    ).json().id;
    await owner("POST", "metrics/5.2.1/rows", row("Existing"));
    link = (await owner("POST", "metrics/5.2.1/collection-links", { label: "Commerce dept", days: 7 })).json();
  });

  it("shows only the form to the link holder, never existing data", async () => {
    expect(link.url).toMatch(/^http:\/\/test\.local\/collect\/[A-Za-z0-9_-]{40,}$/);
    const info = (await pub("GET", token())).json();
    expect(info).toMatchObject({ college_name: "Epsilon College", label: "Commerce dept", metric: { id: "5.2.1" }, submissions_left: 20 });
    expect(JSON.stringify(info)).not.toContain("Existing");
    expect((await pub("GET", `${token()}/template.xlsx`)).statusCode).toBe(200);
    // Only a hash is stored.
    const stored = (await db.query<{ token_hash: string }>("SELECT token_hash FROM collection_link WHERE id = $1", [link.id])).rows[0];
    expect(stored.token_hash).not.toContain(token());
  });

  it("validates submissions and queues them without touching the report", async () => {
    const bad = await pub("POST", `${token()}/submit`, { name: "Commerce", rows: [{ academic_year: "1999-00", student: "X" }] });
    expect(bad.statusCode).toBe(422);
    expect((await pub("POST", `${token()}/submit`, { name: " ", rows: [row("A")] })).statusCode).toBe(400);
    const ok = await pub("POST", `${token()}/submit`, { name: "Commerce dept", note: "batch 1", rows: [row("A"), row("Existing")] });
    expect(ok.statusCode).toBe(200);
    const detail = (await owner("GET", "metrics/5.2.1")).json();
    expect(detail.rows).toHaveLength(1); // still only the owner's row
    const subs = (await owner("GET", "submissions?status=pending")).json();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ submitter_name: "Commerce dept", row_count: 2, link_label: "Commerce dept" });
  });

  it("accept re-checks against current data; reject and double-accept are handled", async () => {
    const [sub] = (await owner("GET", "submissions?status=pending")).json();
    const dup = await owner("POST", `submissions/${sub.id}/accept`);
    expect(dup.statusCode).toBe(422); // "Existing" is now a duplicate
    expect((await owner("GET", "submissions?status=pending")).json()).toHaveLength(1); // back to pending
    expect((await owner("POST", `submissions/${sub.id}/reject`)).statusCode).toBe(200);
    expect((await owner("POST", `submissions/${sub.id}/accept`)).statusCode).toBe(404);

    await pub("POST", `${token()}/submit`, { name: "Commerce dept", rows: [row("B"), row("C")] });
    const [next] = (await owner("GET", "submissions?status=pending")).json();
    const [first, second] = await Promise.all([owner("POST", `submissions/${next.id}/accept`), owner("POST", `submissions/${next.id}/accept`)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
    const students = (await owner("GET", "metrics/5.2.1")).json().rows.map((r: { data: { student: string } }) => r.data.student);
    expect(students).toEqual(["Existing", "B", "C"]);
  });

  it("revoked, unknown and malformed tokens all look the same", async () => {
    expect((await owner("DELETE", `collection-links/${link.id}`)).statusCode).toBe(200);
    for (const t of [token(), "x".repeat(43), "../../etc"]) {
      const r = await pub("GET", encodeURIComponent(t));
      expect(r.statusCode).toBe(404);
      expect(r.json().message).toBe("This link is not valid any more");
    }
    expect((await pub("POST", `${token()}/submit`, { name: "x", rows: [row("Z")] })).statusCode).toBe(404);
  });

  it("only the owner creates links; other users cannot see submissions", async () => {
    expect((await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/collection-links`, headers: as("admin@a.edu"), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/cycles/${cycle}/submissions`, headers: as("admin@a.edu") })).statusCode).toBe(404);
    expect((await owner("POST", "metrics/7.2.1/collection-links", {})).statusCode).toBe(400); // narrative metric
  });

  it("redacts tokens from logged URLs", async () => {
    const { redactUrl } = await import("./infra/logger.js");
    expect(redactUrl("/api/v1/auth/verify?token=abc123&x=1")).toBe("/api/v1/auth/verify?token=[redacted]&x=1");
    expect(redactUrl("/api/v1/collect/SECRET/submit")).toBe("/api/v1/collect/[redacted]/submit");
    expect(redactUrl("/collect/SECRET")).toBe("/collect/[redacted]");
  });
});

describe("web app routes", () => {
  it("deep links into the app (metric IDs contain dots) get the page; missing assets get 404", async () => {
    const page = await app.inject({ url: "/c/some-report/m/7.3.1" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect((await app.inject({ url: "/collect/abc123" })).headers["content-type"]).toContain("text/html");
    expect((await app.inject({ url: "/assets/old-build-123.js" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/favicon.ico" })).statusCode).toBe(404);
  });
});

describe("estimated CGPA", () => {
  it("is part of the dashboard and has a per-criterion breakdown; others cannot see it", async () => {
    const cycles = (await app.inject({ url: `/api/v1/colleges/${ids.A}/cycles`, headers: as("admin@a.edu") })).json();
    const ssr = cycles.find((c: { kind: string }) => c.kind === "SSR").id;
    const d = (await app.inject({ url: `/api/v1/cycles/${ssr}`, headers: as("admin@a.edu") })).json();
    expect(d.cgpa).toMatchObject({ available: true });
    expect(d.cgpa.min).toBeLessThanOrEqual(d.cgpa.max);
    const full = (await app.inject({ url: `/api/v1/cycles/${ssr}/cgpa`, headers: as("admin@a.edu") })).json();
    expect(full.criteria).toHaveLength(7);
    const ki521 = full.criteria.find((c: { id: string }) => c.id === "5").key_indicators.find((k: { id: string }) => k.id === "5.2");
    expect(ki521.weight).toBe(100);
    expect(ki521.metrics.find((m: { metric_id: string }) => m.metric_id === "5.2.1").basis).toBe("calculated");
    expect((await app.inject({ url: `/api/v1/cycles/${ssr}/cgpa`, headers: as("admin@b.edu") })).statusCode).toBe(404);
  });
});

describe("trends across reports", () => {
  it("lines up the same college's reports, and a shared viewer sees only the shared report", async () => {
    const mk = async (kind: "AQAR" | "SSR", year: string, college: string) =>
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/colleges/${ids.B}/cycles`,
          headers: as("admin@b.edu"),
          payload: { kind, label: `${kind} ${year}`, last_year: year, framework_id: FW, college_name: college },
        })
      ).json().id as string;
    const put = async (cycle: string, year: string, outgoing: number, placed: number) => {
      await app.inject({ method: "PUT", url: `/api/v1/cycles/${cycle}/inputs`, headers: as("admin@b.edu"), payload: [{ key: "outgoing_students", year, value: outgoing }] });
      const rows = Array.from({ length: placed }, (_, i) => ({ academic_year: year, student: `T${i}`, outcome: "Placed", employer_or_institution: "X" }));
      await app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/metrics/5.2.1/rows`, headers: as("admin@b.edu"), payload: rows });
    };
    const older = await mk("AQAR", "2022-23", "Zeta College");
    const newer = await mk("AQAR", "2023-24", "Zeta College");
    await mk("AQAR", "2023-24", "Unrelated College");
    await put(older, "2022-23", 10, 8);
    await put(newer, "2023-24", 10, 6);

    const t = (await app.inject({ url: `/api/v1/cycles/${newer}/trends`, headers: as("admin@b.edu") })).json();
    expect(t.reports.map((r: { label: string }) => r.label)).toEqual(["AQAR 2022-23", "AQAR 2023-24"]);
    expect(t.metrics.find((m: { metric_id: string }) => m.metric_id === "5.2.1")).toMatchObject({ points: [80, 60], change_pct: -25, dropped: true });

    await app.inject({ method: "POST", url: `/api/v1/cycles/${newer}/shares`, headers: as("admin@b.edu"), payload: { email: "share.editor@x.edu", role: "viewer" } });
    const shared = (await app.inject({ url: `/api/v1/cycles/${newer}/trends`, headers: as("share.editor@x.edu") })).json();
    expect(shared.reports.map((r: { label: string }) => r.label)).toEqual(["AQAR 2023-24"]);
    expect((await app.inject({ url: `/api/v1/cycles/${newer}/trends`, headers: as("admin@a.edu") })).statusCode).toBe(404);
  });
});

describe("trends use AQARs only", () => {
  it("an SSR of the same college is not mixed into the yearly series", async () => {
    const ssr = (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${ids.B}/cycles`,
        headers: as("admin@b.edu"),
        payload: { kind: "SSR", label: "SSR Zeta", last_year: "2024-25", framework_id: FW, college_name: "Zeta College" },
      })
    ).json().id;
    const t = (await app.inject({ url: `/api/v1/cycles/${ssr}/trends`, headers: as("admin@b.edu") })).json();
    expect(t.reports.map((r: { label: string }) => r.label)).toEqual(["AQAR 2022-23", "AQAR 2023-24"]);
  });
});

describe("peer examples across frameworks", () => {
  it("match the same question by equivalence, not the bare metric ID", async () => {
    await db.query(
      `INSERT INTO ssr_chunk (doc_sha, metric_id, framework, title, page_from, page_to, text, response_value, confidence) VALUES
       ('s1','3.4.3','demo_other','Patents filed',50,50,'patents filed text',1.2,0.95),
       ('s2','3.4.5','some_other_framework','A different question that happens to be numbered 3.4.5',60,60,'unrelated text',9,0.95)`,
    );
    const get = (q: string) => app.inject({ url: `/api/v1/metrics/3.4.5/peer-examples?${q}`, headers: as("admin@a.edu") });
    const scoped = (await get("framework=demo_college")).json();
    expect(scoped.map((p: { metric_id: string; college: string }) => [p.metric_id, p.college])).toEqual([["3.4.3", "Alpha College"]]);
    const bench = (await app.inject({ url: "/api/v1/metrics/3.4.5/benchmark?framework=demo_college", headers: as("admin@a.edu") })).json();
    expect(bench).toMatchObject({ sample_size: 1, median: 1.2 });
    // Without a framework the old ID-only behaviour remains.
    expect((await get("")).json().map((p: { metric_id: string }) => p.metric_id)).toEqual(["3.4.5"]);
  });
});

describe("NAAC-style data-template workbook (records)", () => {
  let cycle = "";
  const YEARS = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"];
  const rows = (metric: string, payload: Record<string, unknown>[]) =>
    app.inject({ method: "POST", url: `/api/v1/cycles/${cycle}/metrics/${metric}/rows`, headers: as("admin@b.edu"), payload });
  const value = async (metric: string) => (await app.inject({ url: `/api/v1/cycles/${cycle}/metrics/${metric}`, headers: as("admin@b.edu") })).json();
  const download = async () => {
    const r = await app.inject({ url: `/api/v1/cycles/${cycle}/naac-workbook.xlsx`, headers: as("admin@b.edu") });
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    return wb;
  };
  const upload = async (wb: ExcelJS.Workbook, query: string) => {
    const boundary = "----naac" + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="naac.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(await wb.xlsx.writeBuffer()),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: "POST",
      url: `/api/v1/cycles/${cycle}/naac-workbook/import?${query}`,
      headers: { ...as("admin@b.edu"), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
  };
  const cellsOf = (ws: ExcelJS.Worksheet) => {
    const out: string[][] = [];
    ws.eachRow((r) => out.push(Array.from((r.values as unknown[]).slice(1), (v) => String(v ?? ""))));
    return out;
  };

  beforeAll(async () => {
    cycle = (
      await app.inject({
        method: "POST",
        url: `/api/v1/colleges/${ids.B}/cycles`,
        headers: as("admin@b.edu"),
        payload: { kind: "SSR", label: "SSR records", last_year: "2024-25", framework_id: "demo_records", college_name: "Beta College" },
      })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/api/v1/cycles/${cycle}/inputs`,
      headers: as("admin@b.edu"),
      payload: [...YEARS.map((year) => ({ key: "outgoing", year, value: 100 })), { key: "teachers_unique", value: 4 }],
    });
    expect(
      (await rows("2.1.1", [
        { academic_year: "2020-21", programme: "BSc", seats_sanctioned: 60, admitted: 48, earmarked_sc: 10, earmarked_obc: 20, admitted_sc: 8, admitted_obc: 16 },
        { academic_year: "2024-25", programme: "BCom", seats_sanctioned: 40, admitted: 40, earmarked_sc: 6, earmarked_obc: 4, admitted_sc: 6, admitted_obc: 2 },
      ])).statusCode,
    ).toBe(201);
    expect(
      (await rows("5.2.1", [
        { kind: "Placed", academic_year: "2024-25", student: "Asha", employer: "Infosys", package: 400000 },
        { kind: "Higher education", academic_year: "2024-25", student: "Ravi", institution: "IIT Madras", admitted_programme: "MSc" },
      ])).statusCode,
    ).toBe(201);
    expect((await rows("3.3.2", [{ teacher: "Dr X", book_title: "Optics" }, { teacher: "Dr Y", paper_title: "Lasers", level: "International" }])).statusCode).toBe(201);
  });

  it("a metric sharing a NAAC sheet is calculated from the other metric's records and takes none of its own", async () => {
    // 2.1.1: admitted / sanctioned = 88 / 100. 2.1.2: reserved seats filled / reserved = 32 / 40.
    expect((await value("2.1.1")).computed.value).toBe(88);
    expect((await value("2.1.2")).computed).toMatchObject({ value: 80, points: 4 }); // demo band: >= 75% scores 4
    expect((await rows("2.1.2", [{ programme: "x" }])).statusCode).toBe(400);
    // 3.3.2 per teacher without repeat count: 2 / 4.
    expect((await value("3.3.2")).computed.value).toBe(0.5);
  });

  it("exports the template's sheets: yearly blocks, two-row headers, two tables on one sheet, numbered rows", async () => {
    const wb = await download();
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(["Read me", "Admissions", "Progression", "Books", "Teachers"]));
    const seats = cellsOf(wb.getWorksheet("Admissions")!);
    expect(seats.map((r) => r[0])).toEqual(expect.arrayContaining(["Year 1 (2020-21)", "Year 5 (2024-25)"]));
    expect(seats.find((r) => r[4] === "SC")).toBeTruthy(); // the sub-header under "Seats reserved"
    expect(seats.find((r) => r[0] === "BSc")!.slice(0, 4)).toEqual(["BSc", "", "60", "48"]);
    const placement = cellsOf(wb.getWorksheet("Progression")!);
    expect(placement.find((r) => r[1] === "Asha")![4]).toBe("Infosys");
    expect(placement.find((r) => r[1] === "Ravi")![4]).toBe("IIT Madras");
    expect(cellsOf(wb.getWorksheet("Books")!).filter((r) => r[1] === "Dr X" || r[1] === "Dr Y").map((r) => r[0])).toEqual(["1", "2"]);
  });

  it("the exported workbook imports back unchanged", async () => {
    const wb = await download();
    const r = await upload(wb, "commit=true&mode=replace");
    expect(r.statusCode).toBe(200);
    expect(r.json().sheets.filter((s: { errors: unknown[] }) => s.errors.length)).toEqual([]);
    expect((await value("2.1.2")).computed.value).toBe(80);
    expect((await value("5.2.1")).rows.map((x: { data: { kind: string; student: string } }) => [x.data.kind, x.data.student])).toEqual([
      ["Placed", "Asha"],
      ["Higher education", "Ravi"],
    ]);
    expect((await value("3.3.2")).rows).toHaveLength(2);
  });

  it("reads a sheet filled in by hand in the template's layout: captions and hand-typed qualifications", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Teachers");
    // The layout is server-side only (the API does not send it), so the test reads the framework itself.
    const sheet = frameworks.metric("demo_records", "2.4.2").naac_sheet!;
    ws.addRow([sheet.title[0]]);
    ws.addRow([sheet.tables[0].caption]);
    ws.addRow(sheet.tables[0].columns.map((c: { header: string }) => c.header));
    ws.addRow(["Dr A", "T1", "Assistant Professor", "", "Physics", "Ph.D (Physics)"]);
    ws.addRow(["Dr B", "T2", "Assistant Professor", "", "Maths", "NET"]);
    ws.addRow([]);
    ws.addRow([sheet.tables[1].caption]);
    ws.addRow(sheet.tables[1].columns.map((c: { header: string }) => c.header));
    ws.addRow(["Dr C", "T3", "Lecturer", "2015-06-01", "2022-05-31", "English", "M.Phil."]);
    const preview = await upload(wb, "commit=false&mode=replace");
    const s = preview.json().sheets.find((x: { metric_id?: string; metricId?: string }) => (x.metric_id ?? x.metricId) === "2.4.2");
    // "M.Phil." is not one of the qualifying options and has no near match: reported, nothing written.
    expect(s.errors.length).toBeGreaterThan(0);
    ws.getRow(9).getCell(7).value = "Other";
    const r = await upload(wb, "commit=true&mode=replace");
    expect(r.statusCode).toBe(200);
    const d = await value("2.4.2");
    expect(d.rows.map((x: { data: { name: string; serving: string; qualification: string } }) => [x.data.name, x.data.serving, x.data.qualification])).toEqual([
      ["Dr A", "Presently working", "Ph.D."],
      ["Dr B", "Presently working", "NET"],
      ["Dr C", "Left the institution", "Other"],
    ]);
    expect(d.computed.value).toBeCloseTo(66.67);
  });
});
