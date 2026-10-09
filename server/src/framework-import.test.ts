// Frameworks are imported into the database, validated on import and again at start-up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap } from "./bootstrap.js";
import type { Db } from "./db/client.js";
import { FRAMEWORK_FORMAT_VERSION } from "./domain/framework.js";
import { FrameworkRegistry, importFrameworks, readFrameworkDir, seedHelp, type FrameworkFileData } from "./services/frameworks.js";
import { DEMO_FRAMEWORKS_DIR } from "./testing/bootstrap.js";

process.env.NODE_ENV = "test";

let db: Db;
let contentDir = "";
let files: FrameworkFileData[];

/** A copy of a framework file with one change, so tests never alter the shared data. */
function withChange(file: FrameworkFileData, change: (data: Record<string, any>) => void): FrameworkFileData {
  const data = structuredClone(file.data) as Record<string, any>;
  change(data);
  return { name: file.name, data };
}

const fileFor = (id: string) => files.find((f) => (f.data as { id: string }).id === id)!;
const count = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM framework")).rows[0].n;

beforeAll(async () => {
  const boot = await bootstrap({ databaseUrl: "", pgliteDir: "" }, () => {});
  db = boot.db;
  contentDir = boot.cfg.contentDir;
  files = readFrameworkDir(DEMO_FRAMEWORKS_DIR);
}, 120000);

afterAll(async () => {
  await db?.close();
});

describe("importing frameworks", () => {
  it("starts with none: the server no longer reads framework files", async () => {
    expect(await count()).toBe(0);
    expect((await FrameworkRegistry.fromDb(db)).list()).toEqual([]);
  });

  it("imports every file, and start-up loads them back the same", async () => {
    const imported = await importFrameworks(db, files, { contentDir });
    const loaded = await FrameworkRegistry.fromDb(db);
    expect(loaded.list().map((f) => f.id).sort()).toEqual(imported.map((f) => f.id).sort());
    for (const fw of imported) expect(loaded.get(fw.id)).toEqual(fw);
  });

  it("writes nothing when any file is invalid", async () => {
    const before = await db.query("SELECT id, version, loaded_at FROM framework ORDER BY id");
    const renamed = withChange(fileFor("demo_college"), (d) => (d.version = "changed"));
    const broken = withChange(fileFor("demo_records"), (d) => (d.criteria[0].key_indicators[0].metrics[0].id = "9.9.9"));
    await expect(importFrameworks(db, [renamed, broken], { contentDir })).rejects.toThrow(/demo_records|Nothing was imported/);
    expect((await db.query("SELECT id, version, loaded_at FROM framework ORDER BY id")).rows).toEqual(before.rows);
  });

  it("refuses two files with the same framework id", async () => {
    const f = fileFor("demo_college");
    await expect(importFrameworks(db, [f, { ...f, name: "copy.yaml" }], { contentDir })).rejects.toThrow(/more than one file/);
  });

  it("keeps frameworks that are not in the import, since reports point at them", async () => {
    const total = await count();
    await importFrameworks(db, [fileFor("demo_records")], { contentDir });
    expect(await count()).toBe(total);
  });
});

describe("loading frameworks at start-up", () => {
  const ID = "demo_college";
  let saved: { file: unknown; format_version: number | null };

  beforeAll(async () => {
    saved = (await db.query<typeof saved>("SELECT file, format_version FROM framework WHERE id = $1", [ID])).rows[0];
  });

  afterAll(async () => {
    await db.query("UPDATE framework SET file = $1::jsonb, format_version = $2 WHERE id = $3", [JSON.stringify(saved.file), saved.format_version, ID]);
  });

  it("stops with the framework and the problem when its stored file is no longer valid", async () => {
    const bad = structuredClone(saved.file) as Record<string, any>;
    bad.criteria[0].key_indicators[0].metrics[0].formula = { op: "sum", field: "no_such_column" };
    await db.query("UPDATE framework SET file = $1::jsonb WHERE id = $2", [JSON.stringify(bad), ID]);
    await expect(FrameworkRegistry.fromDb(db)).rejects.toThrow(new RegExp(`${ID}.*not valid for this release`));
    await db.query("UPDATE framework SET file = $1::jsonb WHERE id = $2", [JSON.stringify(saved.file), ID]);
  });

  it("stops and asks for a re-import when the stored format is from another release", async () => {
    await db.query("UPDATE framework SET format_version = $1 WHERE id = $2", [FRAMEWORK_FORMAT_VERSION + 1, ID]);
    await expect(FrameworkRegistry.fromDb(db)).rejects.toThrow(/import-frameworks/);
    await db.query("UPDATE framework SET format_version = $1 WHERE id = $2", [FRAMEWORK_FORMAT_VERSION, ID]);
  });

  it("still loads frameworks seeded before imports existed, and says to re-import them", async () => {
    await db.query("UPDATE framework SET file = NULL, format_version = NULL WHERE id = $1", [ID]);
    const messages: string[] = [];
    const reg = await FrameworkRegistry.fromDb(db, (m) => messages.push(m));
    expect(reg.get(ID).id).toBe(ID);
    expect(messages.join("\n")).toMatch(new RegExp(`${ID}.*import them again`));
  });
});

describe("search help that comes with the frameworks", () => {
  const explainers = async (fw: string) =>
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM help_article WHERE kind = 'explainer' AND framework_id = $1", [fw])).rows[0].n;

  it("an import writes one explainer per metric of each imported framework", async () => {
    const [fw] = await importFrameworks(db, [fileFor("demo_records")], { contentDir });
    expect(await explainers(fw.id)).toBe(fw.metrics.length);
  });

  it("start-up refreshes only the FAQ and manual, leaving the explainers alone", async () => {
    const before = await explainers("demo_college");
    expect(before).toBeGreaterThan(0);
    let queries = 0;
    const counting: Db = { ...db, query: (sql, params) => (queries++, db.query(sql, params)), tx: (fn) => fn(counting) };
    await seedHelp(counting, contentDir);
    expect(await explainers("demo_college")).toBe(before);
    // One delete and one batched insert, not one query per article.
    expect(queries).toBeLessThanOrEqual(3);
  });
});
