// Framework files (YAML, imported with npm run import-frameworks) parsed and validated into typed objects.
import { parse } from "yaml";
import { z } from "zod";
import { referencedMetrics, validateFormula, type Formula } from "./formula.js";

const Column = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "int", "number", "year", "date", "enum", "bool"]),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict();
export type Column = z.infer<typeof Column>;

const Band = z.object({ min: z.number().optional(), max: z.number().optional(), points: z.number() });
export type Band = z.infer<typeof Band>;

const Evidence = z.object({ key: z.string(), label: z.string(), required: z.boolean().optional() }).strict();
export type EvidenceDef = z.infer<typeof Evidence>;

const NarrativeField = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "longtext"]),
  required: z.boolean().optional(),
}).strict();
const Narrative = z.object({
  template: z.string(),
  word_limit: z.number(),
  min_words: z.number(),
  fields: z.array(NarrativeField),
});
export type NarrativeDef = z.infer<typeof Narrative>;

// How a metric's records appear in NAAC's official data-template workbook (export and import).
const NaacColumn = z
  .object({
    /** The metric column written here; absent for a serial-number column. */
    key: z.string().optional(),
    /** NAAC's header text, exactly as in its workbook. */
    header: z.string(),
    /** A header spanning several columns, printed in the row above (two-row headers). */
    group: z.string().optional(),
    /** "Sl. No." columns: numbered on export, ignored on import. */
    serial: z.boolean().optional(),
  })
  .strict();
const NaacTable = z
  .object({
    /** A line printed above the table's header, e.g. "2.1 b) teachers who left the institution". */
    caption: z.string().optional(),
    /** The rows that belong in this table, when one sheet holds several. */
    where: z.object({ field: z.string(), eq: z.string() }).strict().optional(),
    /** Written into this column on import, when `where` picks the table (e.g. kind = "Left"). */
    columns: z.array(NaacColumn).min(1),
  })
  .strict();
const NaacSheet = z
  .object({
    /** Sheet name in NAAC's workbook. */
    sheet: z.string(),
    /** Lines above the tables (the metric statements, as NAAC prints them). */
    title: z.array(z.string()),
    /** One block of tables per academic year of the cycle ("Year 1 (2019-20)" ...). */
    by_year: z.boolean().optional(),
    /** A "Total" row under each block, summing this column. */
    total: z.string().optional(),
    tables: z.array(NaacTable).min(1),
  })
  .strict();
export type NaacSheetDef = z.infer<typeof NaacSheet>;

const Metric = z.object({
  id: z.string(),
  type: z.enum(["quantitative", "qualitative", "checklist", "choice", "external"]),
  title: z.string(),
  explain: z.string(),
  // single_row: one row with the latest completed year's figures; saving replaces it.
  template: z.object({ columns: z.array(Column), unique: z.array(z.string()).optional(), single_row: z.boolean().optional() }).optional(),
  formula: z.any().optional(),
  unit: z.string().optional(),
  bands: z.array(Band).optional(),
  lower_is_better: z.boolean().optional(),
  items: z.array(z.object({ key: z.string(), label: z.string() }).strict()).optional(),
  options: z.array(z.object({ key: z.string(), label: z.string(), points: z.number() }).strict()).optional(),
  narrative: Narrative.optional(),
  evidence: z.array(Evidence).default([]),
  /** Weightage from the NAAC manual (sums to the key indicator's weight), when known. */
  weight: z.number().positive().optional(),
  /** Where the definition comes from, e.g. a manual page. */
  source: z.string().optional(),
  verified: z.boolean().optional(),
  /** This metric is calculated from another metric's records (one NAAC sheet serves both). */
  data_from: z.string().optional(),
  naac_sheet: NaacSheet.optional(),
});
export type MetricDef = z.infer<typeof Metric> & {
  criterion: string;
  criterion_title: string;
  key_indicator: string;
  key_indicator_title: string;
  position: number;
};

const Input = z.object({ key: z.string(), label: z.string(), per_year: z.boolean() }).strict();
export type InputDef = z.infer<typeof Input>;

const Rule = z.object({
  rule: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  message: z.string(),
  min_points: z.number().optional(),
  min_drop_pct: z.number().optional(),
});
export type RuleDef = z.infer<typeof Rule>;

const FrameworkFile = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  applies_to: z.array(z.enum(["AQAR", "SSR"])),
  institution_types: z.array(z.string()).default([]),
  source: z.record(z.string(), z.unknown()).optional(),
  verified: z.boolean().optional(),
  inputs: z.array(Input),
  checklist: z.array(Rule),
  narrative_templates: z.record(z.string(), z.string()),
  criteria: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      key_indicators: z.array(z.object({ id: z.string(), title: z.string(), weight: z.number().positive().optional(), metrics: z.array(Metric) })),
    }),
  ),
});

export interface Framework {
  id: string;
  name: string;
  version: string;
  applies_to: ("AQAR" | "SSR")[];
  institution_types: string[];
  verified: boolean;
  inputs: InputDef[];
  checklist: RuleDef[];
  narrative_templates: Record<string, string>;
  criteria: { id: string; title: string; key_indicators: { id: string; title: string; weight?: number }[] }[];
  metrics: MetricDef[];
}

/** Parse and validate a framework YAML file. Throws with a readable message on any problem. */
/**
 * The framework file format this release reads. Bump it when a change to FrameworkFile means
 * frameworks imported by an older release must be imported again.
 */
export const FRAMEWORK_FORMAT_VERSION = 1;

/** A framework file's YAML as plain data, with anchors resolved (what is stored when importing). */
export function readFrameworkYaml(yamlText: string): unknown {
  // `merge` keeps `<<:` keys working too.
  return parse(yamlText, { merge: true, maxAliasCount: 10000 });
}

export function parseFramework(yamlText: string): Framework {
  return frameworkFromFile(readFrameworkYaml(yamlText));
}

/** Validates a framework file (formulas included) and flattens it for the app. Throws on any problem. */
export function frameworkFromFile(raw: unknown): Framework {
  const f = FrameworkFile.parse(raw);
  const inputKeys = new Set(f.inputs.map((i) => i.key));
  const all = f.criteria.flatMap((c) => c.key_indicators.flatMap((ki) => ki.metrics));
  const ownColumns = new Map(all.map((m) => [m.id, new Set((m.template?.columns ?? []).map((col) => col.key))]));
  const metrics: MetricDef[] = [];
  let position = 0;
  for (const c of f.criteria) {
    for (const ki of c.key_indicators) {
      for (const m of ki.metrics) {
        const where = `metric ${m.id}`;
        if (!m.id.startsWith(ki.id + ".")) throw new Error(`${where}: id does not belong to ${ki.id}`);
        if (["quantitative", "checklist", "choice"].includes(m.type) && !m.formula) {
          throw new Error(`${where}: ${m.type} metric needs a formula`);
        }
        if (m.data_from) {
          const src = all.find((x) => x.id === m.data_from);
          if (!src?.template?.columns.length) throw new Error(`${where}: data_from ${m.data_from} is not a metric with a data template`);
          if (src.data_from) throw new Error(`${where}: data_from ${m.data_from} itself reads another metric's records`);
          if (m.template?.columns.length) throw new Error(`${where}: a metric with data_from has no columns of its own`);
        }
        if (m.type === "quantitative" && !m.template && !m.data_from) throw new Error(`${where}: quantitative metric needs a template`);
        if (m.naac_sheet) {
          const cols = ownColumns.get(m.id)!;
          for (const t of m.naac_sheet.tables) {
            for (const col of t.columns) {
              if (!col.serial && !col.key) throw new Error(`${where}: NAAC sheet column "${col.header}" needs a key or serial`);
              if (col.key && !cols.has(col.key)) throw new Error(`${where}: NAAC sheet column "${col.header}" uses unknown column ${col.key}`);
            }
            if (t.where && !cols.has(t.where.field)) throw new Error(`${where}: NAAC sheet table filter uses unknown column ${t.where.field}`);
          }
          if (m.naac_sheet.total && !cols.has(m.naac_sheet.total)) throw new Error(`${where}: NAAC sheet total uses unknown column ${m.naac_sheet.total}`);
          if (m.naac_sheet.by_year && !cols.has("academic_year")) throw new Error(`${where}: a NAAC sheet in yearly blocks needs an academic_year column`);
        }
        if (m.type === "qualitative" && !m.narrative) throw new Error(`${where}: qualitative metric needs narrative`);
        if (m.type === "checklist" && !m.items?.length) throw new Error(`${where}: checklist metric needs items`);
        if (m.type === "choice" && !m.options?.length) throw new Error(`${where}: choice metric needs options`);
        if (m.narrative && !f.narrative_templates[m.narrative.template]) {
          throw new Error(`${where}: unknown narrative template ${m.narrative.template}`);
        }
        if (m.formula) {
          const cols = new Set(m.data_from ? ownColumns.get(m.data_from) : (m.template?.columns ?? []).map((col) => col.key));
          if (m.type === "choice") cols.add("option");
          for (const it of m.items ?? []) cols.add(it.key);
          validateFormula(m.formula as Formula, { columns: cols, inputs: inputKeys, where, metricColumns: ownColumns });
        }
        metrics.push({
          ...m,
          criterion: c.id,
          criterion_title: c.title,
          key_indicator: ki.id,
          key_indicator_title: ki.title,
          position: position++,
        });
      }
    }
  }
  const ids = new Set<string>();
  for (const m of metrics) {
    if (ids.has(m.id)) throw new Error(`duplicate metric id ${m.id}`);
    ids.add(m.id);
  }
  return {
    id: f.id,
    name: f.name,
    version: f.version,
    applies_to: f.applies_to,
    institution_types: f.institution_types,
    verified: f.verified ?? false,
    inputs: f.inputs,
    checklist: f.checklist,
    narrative_templates: f.narrative_templates,
    criteria: f.criteria.map((c) => ({
      id: c.id,
      title: c.title,
      key_indicators: c.key_indicators.map((k) => ({ id: k.id, title: k.title, weight: k.weight })),
    })),
    metrics,
  };
}

/** Other metrics whose rows a metric's value depends on: its `data_from` source and any metric its formula names. */
export function rowSources(m: MetricDef): string[] {
  return [...new Set([...(m.data_from ? [m.data_from] : []), ...(m.formula ? referencedMetrics(m.formula as Formula) : [])])];
}

/** Metrics whose value changes when `metricId`'s rows change. */
export function dependents(fw: Framework, metricId: string): MetricDef[] {
  return fw.metrics.filter((m) => m.id !== metricId && rowSources(m).includes(metricId));
}

/** Columns a metric's rows carry, including synthetic ones for checklist and choice metrics. */
export function rowColumns(m: MetricDef): Column[] {
  if (m.type === "checklist") {
    return (m.items ?? []).map((it) => ({ key: it.key, label: it.label, type: "bool" as const }));
  }
  if (m.type === "choice") {
    return [{ key: "option", label: "Option", type: "enum", required: true, options: (m.options ?? []).map((o) => o.key) }];
  }
  return m.template?.columns ?? [];
}
