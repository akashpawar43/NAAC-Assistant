// PDF export with the same layout as the Word export (pdfmake, pure JavaScript, no LibreOffice).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces.js";
import { MAX_DOC_ROWS } from "./docx-report.js";
import { cellText, formatValue, type ReportMetric, type ReportModel } from "./report.js";

const require = createRequire(import.meta.url);
// pdfmake's server build is CommonJS and exports a ready-made instance.
const pdfmake = require("pdfmake") as {
  setFonts(f: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(cb: (url: string) => boolean): void;
  setLocalAccessPolicy(cb: (path: string) => boolean): void;
  createPdf(d: TDocumentDefinitions): { getBuffer(): Promise<Buffer> };
};

const FONT_DIR = join(dirname(require.resolve("pdfmake/package.json")), "build", "fonts", "Roboto");
pdfmake.setFonts({
  Roboto: {
    normal: join(FONT_DIR, "Roboto-Regular.ttf"),
    bold: join(FONT_DIR, "Roboto-Medium.ttf"),
    italics: join(FONT_DIR, "Roboto-Italic.ttf"),
    bolditalics: join(FONT_DIR, "Roboto-MediumItalic.ttf"),
  },
});
// The document never needs remote images or arbitrary local files; only the bundled fonts.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p) => p.startsWith(FONT_DIR));

const STATUS_LABEL = { empty: "Not started", partial: "Partial", complete: "Complete" } as const;

function dataTable(header: string[], rows: string[][], widths?: (string | number)[]): Content {
  return {
    table: {
      headerRows: 1,
      widths: widths ?? header.map(() => "*"),
      body: [header.map((h) => ({ text: h, style: "th" })), ...rows.map((r) => r.map((v) => ({ text: v, style: "td" })))],
    },
    layout: {
      hLineColor: () => "#BFC7D5",
      vLineColor: () => "#BFC7D5",
      fillColor: (row: number) => (row === 0 ? "#E8EEF7" : null),
    },
    margin: [0, 4, 0, 8],
  };
}

function narrative(text: string): Content[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const m = /^(\d+\.\s[^:]{3,60}:)\s*([\s\S]*)$/.exec(block);
      return { text: m ? [{ text: m[1] + " ", bold: true }, m[2]] : block, alignment: "justify", margin: [0, 0, 0, 6] } as Content;
    });
}

function metric(x: ReportMetric): Content[] {
  const out: Content[] = [{ text: `${x.m.id} ${x.m.title}`, style: "h2" }];
  const facts: string[] = [];
  if (x.m.type !== "qualitative" && x.m.type !== "external") {
    facts.push(`Value: ${formatValue(x.value, x.m.unit)}${x.points !== null ? ` (indicative ${x.points}/4)` : ""}`);
  }
  facts.push(`Status: ${STATUS_LABEL[x.status]}`);
  out.push({ text: facts.join("     "), style: "muted" });
  if (x.value === null && x.reason && x.m.type !== "qualitative" && !(x.columns.length && !x.rows.length)) out.push({ text: x.reason, style: "warn" });
  if (x.columns.length) {
    if (x.rows.length) {
      const shown = x.rows.slice(0, MAX_DOC_ROWS);
      out.push(dataTable(x.columns.map((c) => c.label), shown.map((r) => x.columns.map((c) => cellText(r[c.key])))));
      if (x.rows.length > shown.length) out.push({ text: `Showing ${shown.length} of ${x.rows.length} rows. The Excel export has all rows.`, italics: true });
    } else out.push({ text: "No rows entered.", italics: true });
  }
  for (const line of x.answer) out.push({ text: line });
  if (x.m.type === "qualitative") out.push(...(x.narrativeText ? narrative(x.narrativeText) : [{ text: "Not written yet.", italics: true }]));
  if (x.m.type === "external") out.push({ text: x.m.explain, italics: true });
  if (x.evidence.length) {
    out.push({ text: "Evidence", bold: true, margin: [0, 4, 0, 2] });
    out.push({ ul: x.evidence.map((e) => ({ text: [`${e.label}: `, { text: e.filename, link: e.link, color: "#1f4e8c", decoration: "underline" }] })) });
  }
  const missing = x.missing.filter((m) => m.startsWith("Evidence:"));
  if (missing.length) out.push({ text: `Missing: ${missing.map((m) => m.replace(/^Evidence:\s*/, "")).join("; ")}`, style: "bad" });
  return out;
}

export async function exportPdf(r: ReportModel): Promise<Buffer> {
  const metrics = r.criteria.flatMap((c) => c.metrics);
  const details = [r.college.state, r.college.type, r.college.aishe ? `AISHE ${r.college.aishe}` : null].filter(Boolean).join(" · ");
  const content: Content[] = [
    { text: r.collegeName, style: "title" },
    { text: r.title, style: "subtitle" },
    ...(details ? [{ text: details } as Content] : []),
    { text: `Academic years: ${r.years.join(", ")}` },
    { text: `Framework: ${r.framework.name} v${r.framework.version}` },
    ...(r.wholeReport ? [] : [{ text: `Contents: ${r.selection}`, bold: true } as Content]),
    { text: `Generated ${r.generatedAt.toISOString().slice(0, 10)} by NAAC Assistant. Draft for review before submission.`, style: "muted", margin: [0, 12, 0, 0] },
    ...(r.framework.verified ? [] : [{ text: "Calculated values and points are indicative. Check them against the current NAAC manual.", style: "warn" } as Content]),
    { text: "Summary", style: "h1", pageBreak: "before" },
    { text: `${metrics.length} metrics: ${r.counts.complete} complete, ${r.counts.partial} partial, ${r.counts.empty} not started.` },
    dataTable(
      ["Metric", "Title", "Value", "Status"],
      metrics.map((x) => [x.m.id, x.m.title, x.m.type === "qualitative" ? "Narrative" : formatValue(x.value, x.m.unit), STATUS_LABEL[x.status]]),
      [40, "*", 70, 60],
    ),
  ];
  if (r.wholeReport) {
    const hasSingle = r.inputs.some((i) => !i.perYear);
    content.push(
      { text: "Extended profile", style: "h1", pageBreak: "before" },
      dataTable(
        ["Field", ...r.years, ...(hasSingle ? ["Value"] : [])],
        r.inputs.map((i) => [i.label, ...i.values.map((v) => (v === null ? "" : String(v))), ...(hasSingle ? [i.value === null ? "" : String(i.value)] : [])]),
        ["*", ...r.years.map(() => 48), ...(hasSingle ? [48] : [])],
      ),
    );
  }
  for (const c of r.criteria) {
    content.push({ text: `Criterion ${c.id}: ${c.title}`, style: "h1", pageBreak: "before" }, ...c.metrics.flatMap(metric));
  }
  const doc: TDocumentDefinitions = {
    info: { title: `${r.collegeName} - ${r.title}`, creator: "NAAC Assistant" },
    pageSize: "A4",
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.2 },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 120, 0, 6] },
      subtitle: { fontSize: 16, bold: true, margin: [0, 0, 0, 12] },
      h1: { fontSize: 15, bold: true, color: "#1f4e8c", margin: [0, 0, 0, 8] },
      h2: { fontSize: 11.5, bold: true, margin: [0, 12, 0, 3] },
      th: { bold: true, fontSize: 8.5 },
      td: { fontSize: 8.5 },
      muted: { color: "#5f6b7a", margin: [0, 0, 0, 4] },
      warn: { color: "#9a5b00", italics: true },
      bad: { color: "#b3261e", italics: true },
    },
    footer: (page: number, pages: number) => ({
      text: `${r.collegeName} · ${r.title} · Page ${page} of ${pages}`,
      alignment: "center",
      fontSize: 8,
      color: "#5f6b7a",
      margin: [0, 20, 0, 0],
    }),
    content,
  };
  return pdfmake.createPdf(doc).getBuffer();
}
