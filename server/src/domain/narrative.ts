// Narrative drafts from structured fields via Jinja-style templates (Nunjucks).
import nunjucks from "nunjucks";

const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false, trimBlocks: false });

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export interface DraftInput {
  template: string;
  fields: Record<string, string>;
  /** Short factual lines from the college's own data, e.g. "3.3.1: 1.25 papers per teacher". */
  facts?: string[];
}

export function renderDraft(input: DraftInput): { text: string; words: number } {
  const fields = Object.fromEntries(Object.entries(input.fields).map(([k, v]) => [k, (v ?? "").trim()]));
  const text = env
    .renderString(input.template, { fields, facts: input.facts ?? [] })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, words: wordCount(text) };
}
