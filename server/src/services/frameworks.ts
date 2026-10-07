// Frameworks live in the database: imported from framework files (npm run import-frameworks), then
// validated again and kept in memory by every server at start-up. The files are not part of the app.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Db } from "../db/client.js";
import { FRAMEWORK_FORMAT_VERSION, frameworkFromFile, readFrameworkYaml, type Framework, type MetricDef } from "../domain/framework.js";
import { notFound } from "./errors.js";

interface FrameworkRow {
  id: string;
  file: unknown;
  format_version: number | null;
  definition: Framework;
}

export class FrameworkRegistry {
  private byId = new Map<string, Framework>();

  /**
   * Every framework in the database, each validated again with this release's rules; a framework
   * that fails stops start-up with its id and the problem, rather than failing later in a request.
   */
  static async fromDb(db: Db, log: (m: string) => void = () => {}): Promise<FrameworkRegistry> {
    const reg = new FrameworkRegistry();
    const rows = (await db.query<FrameworkRow>("SELECT id, file, format_version, definition FROM framework ORDER BY id")).rows;
    const seeded: string[] = [];
    for (const r of rows) {
      if (r.format_version === null) {
        // Seeded at start-up by a release before imports; it was validated then.
        seeded.push(r.id);
        reg.byId.set(r.id, r.definition);
        continue;
      }
      if (r.format_version !== FRAMEWORK_FORMAT_VERSION) {
        throw new Error(
          `Framework ${r.id} was imported in format ${r.format_version}, but this release reads format ${FRAMEWORK_FORMAT_VERSION}. ` +
            "Import the frameworks again with this release: npm run import-frameworks -- <dir>",
        );
      }
      try {
        reg.byId.set(r.id, frameworkFromFile(r.file));
      } catch (e) {
        throw new Error(`Framework ${r.id} in the database is not valid for this release: ${(e as Error).message}`);
      }
    }
    if (seeded.length) log(`frameworks ${seeded.join(", ")} predate imports; import them again to have them re-checked at start-up`);
    return reg;
  }

  add(fw: Framework) {
    this.byId.set(fw.id, fw);
  }

  get(id: string): Framework {
    const fw = this.byId.get(id);
    if (!fw) throw notFound(`Unknown framework ${id}`);
    return fw;
  }

  metric(fwId: string, metricId: string): MetricDef {
    const m = this.get(fwId).metrics.find((x) => x.id === metricId);
    if (!m) throw notFound(`Unknown metric ${metricId}`);
    return m;
  }

  list(): Framework[] {
    return [...this.byId.values()];
  }
}

export interface FrameworkFileData {
  /** Where it came from (file name), for error messages. */
  name: string;
  /** The parsed YAML, anchors resolved. */
  data: unknown;
}

/** Every *.yaml framework file in a folder. */
export function readFrameworkDir(dir: string): FrameworkFileData[] {
  if (!existsSync(dir)) throw new Error(`Framework folder ${dir} does not exist`);
  const names = readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort();
  if (!names.length) throw new Error(`No framework files (*.yaml) in ${dir}`);
  return names.map((name) => ({ name, data: readFrameworkYaml(readFileSync(join(dir, name), "utf8")) }));
}

/**
 * Adds or updates frameworks. Every file is validated before anything is written, so one bad file
 * imports nothing. Frameworks already in the database but not in `files` are kept: reports point
 * at them. Running servers pick the changes up when they restart.
 */
export async function importFrameworks(
  db: Db,
  files: FrameworkFileData[],
  opts: { contentDir: string; log?: (m: string) => void },
): Promise<Framework[]> {
  const log = opts.log ?? (() => {});
  const parsed = files.map((f) => {
    try {
      return { fw: frameworkFromFile(f.data), data: f.data };
    } catch (e) {
      throw new Error(`${f.name}: ${(e as Error).message}. Nothing was imported.`);
    }
  });
  const ids = parsed.map((p) => p.fw.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`Framework ${dup} appears in more than one file. Nothing was imported.`);
  for (const { fw, data } of parsed) {
    await db.query(
      `INSERT INTO framework (id, name, version, definition, file, format_version) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, definition = EXCLUDED.definition,
         file = EXCLUDED.file, format_version = EXCLUDED.format_version, loaded_at = now()`,
      [fw.id, fw.name, fw.version, JSON.stringify(fw), JSON.stringify(data), FRAMEWORK_FORMAT_VERSION],
    );
    log(`framework ${fw.id} v${fw.version}: ${fw.metrics.length} metrics`);
  }
  const frameworks = parsed.map((p) => p.fw);
  // Each metric's explainer is searchable help; it is rewritten only for the imported frameworks.
  await db.query("DELETE FROM help_article WHERE kind = 'explainer' AND framework_id = ANY($1::text[])", [ids]);
  const explainers = frameworks.flatMap((fw) => explainerArticles(fw, opts.contentDir));
  await insertHelpArticles(db, explainers);
  log(`metric explainers: ${explainers.length}`);
  return frameworks;
}

/** Loads <dir>/metric_equivalence.json (same question across frameworks), if present. */
export async function seedEquivalence(db: Db, dir: string, log: (m: string) => void = () => {}): Promise<number> {
  const file = join(dir, "metric_equivalence.json");
  if (!existsSync(file)) return 0;
  const pairs = JSON.parse(readFileSync(file, "utf8")) as { a: [string, string]; b: [string, string]; score: number }[];
  await db.tx(async (t) => {
    await t.query("DELETE FROM metric_equivalence");
    for (let i = 0; i < pairs.length; i += 500) {
      await t.query(
        `INSERT INTO metric_equivalence (a_framework, a_metric, b_framework, b_metric, score)
         SELECT a_framework, a_metric, b_framework, b_metric, score FROM jsonb_to_recordset($1::jsonb)
           AS x(a_framework text, a_metric text, b_framework text, b_metric text, score real)
         ON CONFLICT DO NOTHING`,
        [JSON.stringify(pairs.slice(i, i + 500).map((p) => ({ a_framework: p.a[0], a_metric: p.a[1], b_framework: p.b[0], b_metric: p.b[1], score: p.score })))],
      );
    }
  });
  log(`metric equivalences: ${pairs.length}`);
  return pairs.length;
}

interface FaqItem {
  q: string;
  a: string;
  metric_id?: string;
  source?: string;
}

interface HelpArticle {
  id: string;
  kind: "explainer" | "faq" | "manual";
  framework_id: string | null;
  metric_id: string | null;
  title: string;
  body: string;
  source: string | null;
}

/** Inserts help articles in batches (one query per 500, not one per article). */
async function insertHelpArticles(db: Db, articles: HelpArticle[]): Promise<void> {
  for (let i = 0; i < articles.length; i += 500) {
    await db.query(
      `INSERT INTO help_article (id, kind, framework_id, metric_id, title, body, source)
       SELECT id, kind, framework_id, metric_id, title, body, source FROM jsonb_to_recordset($1::jsonb)
         AS x(id text, kind text, framework_id text, metric_id text, title text, body text, source text)`,
      [JSON.stringify(articles.slice(i, i + 500))],
    );
  }
}

/** One explainer per metric: the framework's `explain`, plus server/content/explainers/<id>.md when written. */
function explainerArticles(fw: Framework, contentDir: string): HelpArticle[] {
  return fw.metrics.map((m) => {
    const extra = join(contentDir, "explainers", `${m.id}.md`);
    const more = existsSync(extra) ? "\n\n" + readFileSync(extra, "utf8") : "";
    const evidence = m.evidence.map((e) => e.label).join("; ");
    return {
      id: `explainer:${fw.id}:${m.id}`,
      kind: "explainer",
      framework_id: fw.id,
      metric_id: m.id,
      title: `${m.id} ${m.title}`,
      body: `${m.explain}${evidence ? `\nDocuments needed: ${evidence}.` : ""}${more}`,
      source: `Framework ${fw.name} v${fw.version}`,
    };
  });
}

/**
 * The app's own help content, searched by "Search NAAC": server/content/faq.yaml and
 * server/content/manual/*.md sections. Metric explainers come with the frameworks (importFrameworks)
 * and are left alone here.
 */
export async function seedHelp(db: Db, contentDir: string, log: (m: string) => void = () => {}): Promise<number> {
  const articles: HelpArticle[] = [];
  const faqPath = join(contentDir, "faq.yaml");
  if (existsSync(faqPath)) {
    const items = (parse(readFileSync(faqPath, "utf8")) as FaqItem[]) ?? [];
    items.forEach((it, i) =>
      articles.push({ id: `faq:${i}`, kind: "faq", framework_id: null, metric_id: it.metric_id ?? null, title: it.q, body: it.a, source: it.source ?? null }),
    );
  }
  const manualDir = join(contentDir, "manual");
  if (existsSync(manualDir)) {
    for (const f of readdirSync(manualDir).filter((n) => n.endsWith(".md") && n !== "README.md").sort()) {
      const text = readFileSync(join(manualDir, f), "utf8");
      // One article per "## " section so citations point to a section, not a whole file.
      // Text before the first "## " heading is an intro, not a section.
      const sections = text.split(/^##\s+/m).slice(1).filter((s) => s.trim());
      sections.forEach((s, i) => {
        const [title, ...body] = s.split("\n");
        const mid = /^([1-7]\.\d{1,2}(?:\.\d{1,2})?)\b/.exec(title.trim())?.[1] ?? null;
        articles.push({ id: `manual:${f}:${i}`, kind: "manual", framework_id: null, metric_id: mid, title: title.trim(), body: body.join("\n").trim(), source: f });
      });
    }
  }
  await db.tx(async (t) => {
    await t.query("DELETE FROM help_article WHERE kind IN ('faq', 'manual')");
    await insertHelpArticles(t, articles);
  });
  log(`help articles: ${articles.length}`);
  return articles.length;
}
