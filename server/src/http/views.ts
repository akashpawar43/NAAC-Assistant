// What the API sends about frameworks: only what the screens use. Formulas, score bands and the
// NAAC data-template layout stay on the server, so signing up does not hand out the framework files.
// Fields are listed one by one on purpose: a new framework field stays private until added here.
import type { Column, Framework, MetricDef } from "../domain/framework.js";
import { rowColumns } from "../domain/framework.js";

export interface ClientMetric {
  id: string;
  type: MetricDef["type"];
  title: string;
  explain: string;
  unit?: string;
  criterion: string;
  key_indicator: string;
  key_indicator_title: string;
  verified?: boolean;
  /** The columns a row of this metric has (checklist items and choice options included). */
  columns: Column[];
  items?: { key: string; label: string }[];
  options?: { key: string; label: string }[];
  narrative?: { word_limit: number; min_words: number; fields: NonNullable<MetricDef["narrative"]>["fields"] };
  evidence: MetricDef["evidence"];
  /** Calculated from another metric's records (one NAAC data-template sheet serves both). */
  data_from?: string;
}

export function clientMetric(m: MetricDef): ClientMetric {
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    explain: m.explain,
    unit: m.unit,
    criterion: m.criterion,
    key_indicator: m.key_indicator,
    key_indicator_title: m.key_indicator_title,
    verified: m.verified,
    columns: rowColumns(m),
    items: m.items?.map(({ key, label }) => ({ key, label })),
    options: m.options?.map(({ key, label }) => ({ key, label })),
    narrative: m.narrative && { word_limit: m.narrative.word_limit, min_words: m.narrative.min_words, fields: m.narrative.fields },
    evidence: m.evidence,
    data_from: m.data_from,
  };
}

/** One framework as the extended-profile and review screens need it. */
export function clientFramework(fw: Framework) {
  return { id: fw.id, name: fw.name, version: fw.version, verified: fw.verified, inputs: fw.inputs, metrics: fw.metrics.map(clientMetric) };
}
