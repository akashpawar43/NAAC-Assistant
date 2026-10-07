// Word (.docx) export in NAAC order: cover, summary, extended profile, then criterion by
// criterion with each metric's value, data table, answers, narrative and evidence list.
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { cellText, formatValue, type ReportMetric, type ReportModel } from "./report.js";

/** Long tables belong in the Excel export; Word stays readable. */
export const MAX_DOC_ROWS = 200;

const STATUS_LABEL = { empty: "Not started", partial: "Partial", complete: "Complete" } as const;
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "BFC7D5" };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

const p = (text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string; spacingAfter?: number } = {}) =>
  new Paragraph({
    spacing: { after: opts.spacingAfter ?? 120 },
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size, color: opts.color })],
  });

function cell(text: string, header = false, width?: number): TableCell {
  return new TableCell({
    borders: BORDERS,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: header ? { type: ShadingType.CLEAR, color: "auto", fill: "E8EEF7" } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text, bold: header, size: 18 })] })],
  });
}

function table(header: string[], rows: string[][], widths?: number[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, true, widths?.[i])) }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, false, widths?.[i])) })),
    ],
  });
}

/** Narrative text keeps its paragraphs; numbered NAAC headings ("1. Title of the Practice:") are bold. */
function narrativeParagraphs(text: string): Paragraph[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const m = /^(\d+\.\s[^:]{3,60}:)\s*([\s\S]*)$/.exec(block);
      const runs = m
        ? [new TextRun({ text: m[1] + " ", bold: true }), new TextRun(m[2])]
        : block.split("\n").flatMap((line, i) => (i ? [new TextRun({ text: line, break: 1 })] : [new TextRun(line)]));
      return new Paragraph({ spacing: { after: 160 }, alignment: AlignmentType.JUSTIFIED, children: runs });
    });
}

function metricSection(x: ReportMetric): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`${x.m.id} ${x.m.title}`)] })];
  const facts: string[] = [];
  if (x.m.type !== "qualitative" && x.m.type !== "external") {
    facts.push(`Value: ${formatValue(x.value, x.m.unit)}${x.points !== null ? ` (indicative ${x.points}/4)` : ""}`);
  }
  facts.push(`Status: ${STATUS_LABEL[x.status]}`);
  out.push(p(facts.join("    "), { color: "44506A" }));
  if (x.value === null && x.reason && x.m.type !== "qualitative" && !(x.columns.length && !x.rows.length)) out.push(p(x.reason, { italics: true, color: "9A5B00" }));

  if (x.columns.length) {
    if (x.rows.length) {
      const shown = x.rows.slice(0, MAX_DOC_ROWS);
      out.push(table(x.columns.map((c) => c.label), shown.map((r) => x.columns.map((c) => cellText(r[c.key])))));
      if (x.rows.length > shown.length) out.push(p(`Showing ${shown.length} of ${x.rows.length} rows. The Excel export has all rows.`, { italics: true }));
    } else {
      out.push(p("No rows entered.", { italics: true }));
    }
  }
  for (const line of x.answer) out.push(p(line));
  if (x.m.type === "qualitative") {
    out.push(...(x.narrativeText ? narrativeParagraphs(x.narrativeText) : [p("Not written yet.", { italics: true })]));
  }
  if (x.m.type === "external") out.push(p(x.m.explain, { italics: true }));

  if (x.evidence.length) {
    out.push(p("Evidence", { bold: true, spacingAfter: 60 }));
    for (const e of x.evidence) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun(`${e.label}: `), new ExternalHyperlink({ link: e.link, children: [new TextRun({ text: e.filename, style: "Hyperlink" })] })],
        }),
      );
    }
  }
  const missing = x.missing.filter((m) => m.startsWith("Evidence:"));
  if (missing.length) out.push(p(`Missing: ${missing.map((m) => m.replace(/^Evidence:\s*/, "")).join("; ")}`, { italics: true, color: "B3261E" }));
  return out;
}

export async function exportDocx(r: ReportModel): Promise<Buffer> {
  const metrics = r.criteria.flatMap((c) => c.metrics);
  const details = [r.college.state, r.college.type, r.college.aishe ? `AISHE ${r.college.aishe}` : null].filter(Boolean).join(" · ");

  const cover: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(r.collegeName)] }),
    p(r.title, { bold: true, size: 32 }),
    ...(details ? [p(details)] : []),
    p(`Academic years: ${r.years.join(", ")}`),
    p(`Framework: ${r.framework.name} v${r.framework.version}`),
    ...(r.wholeReport ? [] : [p(`Contents: ${r.selection}`, { bold: true })]),
    p(`Generated ${r.generatedAt.toISOString().slice(0, 10)} by NAAC Assistant. Draft for review before submission.`, { italics: true, color: "5F6B7A" }),
    ...(r.framework.verified ? [] : [p("Calculated values and points are indicative. Check them against the current NAAC manual.", { italics: true, color: "9A5B00" })]),
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun("Summary")] }),
    p(`${metrics.length} metrics: ${r.counts.complete} complete, ${r.counts.partial} partial, ${r.counts.empty} not started.`),
    table(
      ["Metric", "Title", "Value", "Status"],
      metrics.map((x) => [x.m.id, x.m.title, x.m.type === "qualitative" ? "Narrative" : formatValue(x.value, x.m.unit), STATUS_LABEL[x.status]]),
      [10, 60, 15, 15],
    ),
  ];

  const profile: (Paragraph | Table)[] = r.wholeReport
    ? [
        new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun("Extended profile")] }),
        table(
          ["Field", ...r.years, ...(r.inputs.some((i) => !i.perYear) ? ["Value"] : [])],
          r.inputs.map((i) => [
            i.label,
            ...i.values.map((v) => (v === null ? "" : String(v))),
            ...(r.inputs.some((j) => !j.perYear) ? [i.value === null ? "" : String(i.value)] : []),
          ]),
        ),
      ]
    : [];

  const body = r.criteria.flatMap((c) => [
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(`Criterion ${c.id}: ${c.title}`)] }),
    ...c.metrics.flatMap(metricSection),
  ]);

  const doc = new Document({
    creator: "NAAC Assistant",
    title: `${r.collegeName} - ${r.title}`,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: `${r.collegeName} · ${r.title} · Page `, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], size: 16 })],
              }),
            ],
          }),
        },
        children: [...cover, ...profile, ...body],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
