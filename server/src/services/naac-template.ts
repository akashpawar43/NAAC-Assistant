// NAAC's official data-template workbook: export a report's records in NAAC's sheet layout, and
// read a workbook filled in that layout back in. The layout of each sheet comes from the metric's
// `naac_sheet` in the framework file.
import ExcelJS from "exceljs";
import type { Column, Framework, MetricDef, NaacSheetDef } from "../domain/framework.js";
import type { Row } from "../domain/formula.js";
import { badRequest } from "./errors.js";
import { loadWorkbook, populatedRowNumbers, type ParsedWorkbook } from "./excel.js";

const README_SHEET = "Read me";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
const MAX_ROWS = 20000;

type Table = NaacSheetDef["tables"][number];

export function naacMetrics(fw: Framework): MetricDef[] {
  return fw.metrics.filter((m) => m.naac_sheet);
}

/** NAAC writes dates as DD-MM-YYYY; rows store them as YYYY-MM-DD. */
function cellOut(v: unknown, c: Column | undefined): ExcelJS.CellValue {
  if (v === null || v === undefined || v === "") return null;
  if (c?.type === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return v as ExcelJS.CellValue;
}

function writeTable(ws: ExcelJS.Worksheet, t: Table, rows: Row[], cols: Map<string, Column>): void {
  if (t.caption) ws.addRow([t.caption]).font = { bold: true };
  if (t.columns.some((c) => c.group)) {
    const g = ws.addRow(t.columns.map((c) => c.group ?? c.header));
    g.font = { bold: true };
    g.fill = HEADER_FILL;
    // Merge each run of columns under one group heading.
    let start = 0;
    t.columns.forEach((c, i) => {
      const next = t.columns[i + 1];
      if (!next || next.group !== c.group || !c.group) {
        if (c.group && i > start) ws.mergeCells(g.number, start + 1, g.number, i + 1);
        start = i + 1;
      }
    });
  }
  const h = ws.addRow(t.columns.map((c) => c.header));
  h.font = { bold: true };
  h.fill = HEADER_FILL;
  h.alignment = { wrapText: true, vertical: "top" };
  rows.forEach((r, i) => ws.addRow(t.columns.map((c) => (c.serial ? i + 1 : cellOut(r[c.key!], cols.get(c.key!))))));
}

function rowsFor(t: Table, rows: Row[]): Row[] {
  return t.where ? rows.filter((r) => String(r[t.where!.field] ?? "") === t.where!.eq) : rows;
}

/** A workbook in NAAC's data-template layout, one sheet per metric entered as records. */
export async function naacTemplateWorkbook(
  fw: Framework,
  years: string[],
  rowsByMetric: Map<string, Row[]>,
  about: { college: string; report: string },
): Promise<Buffer> {
  const metrics = naacMetrics(fw);
  if (!metrics.length) throw badRequest(`${fw.name} has no NAAC data-template layout`);
  const wb = new ExcelJS.Workbook();
  wb.creator = "NAAC Assistant";
  const readme = wb.addWorksheet(README_SHEET);
  readme.addRows([
    [`${about.college}: ${about.report}`],
    [],
    ["The sheets below follow NAAC's data-template workbook for this framework (same sheet names, headers and yearly blocks), filled from the records entered in NAAC Assistant."],
    [`Yearly blocks: ${years.map((y, i) => `Year ${i + 1} = ${y}`).join(", ")}.`],
    ["NAAC's workbook has a few more sheets for information NAAC Assistant does not record as rows (for example the student list); fill those in NAAC's own workbook."],
    ["This workbook can be imported back (Data workbook page, NAAC format)."],
    [],
    ["Sheet", "Metrics"],
    ...metrics.map((m) => [m.naac_sheet!.sheet, [m, ...fw.metrics.filter((d) => d.data_from === m.id)].map((x) => `${x.id} ${x.title}`).join("\n")]),
  ]);
  readme.getCell("A1").font = { bold: true, size: 14 };
  readme.getColumn(1).width = 18;
  readme.getColumn(2).width = 120;

  for (const m of metrics) {
    const s = m.naac_sheet!;
    const ws = wb.addWorksheet(s.sheet.slice(0, 31));
    const cols = new Map((m.template?.columns ?? []).map((c) => [c.key, c]));
    const rows = rowsByMetric.get(m.id) ?? [];
    for (const t of s.title) ws.addRow([t]).font = { bold: true };
    ws.addRow([]);
    if (s.by_year) {
      years.forEach((y, i) => {
        const yearRows = rows.filter((r) => r.academic_year === y);
        ws.addRow([`Year ${i + 1} (${y})`]).font = { bold: true };
        for (const t of s.tables) writeTable(ws, t, rowsFor(t, yearRows), cols);
        if (s.total) {
          const at = s.tables[0].columns.findIndex((c) => c.key === s.total);
          const total = yearRows.reduce((a, r) => a + (Number(r[s.total!]) || 0), 0);
          const tr = ws.addRow(s.tables[0].columns.map((_, j) => (j === 0 ? "Total" : j === at ? total : null)));
          tr.font = { bold: true };
        }
        ws.addRow([]);
      });
    } else {
      s.tables.forEach((t, i) => {
        if (i) ws.addRow([]);
        writeTable(ws, t, rowsFor(t, rows), cols);
      });
    }
    const width = Math.max(...s.tables.map((t) => t.columns.length));
    for (let c = 1; c <= width; c++) ws.getColumn(c).width = 24;
    ws.getColumn(1).width = 34;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- import

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function text(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return text(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("hyperlink" in v) return (v as { hyperlink: string }).hyperlink;
    return null;
  }
  return v;
}

/** NAAC's sheets are filled by hand: "Ph.D (Chemistry)" means the "Ph.D." option. */
function matchOption(v: unknown, c: Column | undefined): unknown {
  if (c?.type !== "enum" || v === null || v === undefined) return v;
  const n = norm(v).replace(/ /g, "");
  if (!n) return v;
  const exact = c.options?.find((o) => norm(o).replace(/ /g, "") === n);
  if (exact) return exact;
  const opts = (c.options ?? []).map((o) => [o, norm(o).replace(/ /g, "")] as const).filter(([, k]) => k);
  // The longest option the value starts with or contains ("phdinchemistry" -> "phd").
  const hit = opts.filter(([, k]) => n.startsWith(k) || n.includes(k)).sort((a, b) => b[1].length - a[1].length)[0];
  return hit ? hit[0] : v;
}

/** Is row `r` this table's header row (its headers, in order, from column A)? */
function isHeader(ws: ExcelJS.Worksheet, r: number, t: Table): boolean {
  const row = ws.getRow(r);
  return t.columns.every((c, i) => norm(text(row.getCell(i + 1).value)) === norm(c.header));
}

/** Year of a "Year 3 (2021-22)" or "Year 3" block label above a header row. */
function blockYear(ws: ExcelJS.Worksheet, headerRow: number, years: string[]): string | null {
  for (let r = headerRow - 1; r >= Math.max(1, headerRow - 3); r--) {
    const v = String(text(ws.getRow(r).getCell(1).value) ?? "");
    const explicit = /(\d{4}-\d{2})/.exec(v);
    if (explicit && years.includes(explicit[1])) return explicit[1];
    const n = /^\s*year\s*-?\s*(\d)/i.exec(v);
    if (n) return years[Number(n[1]) - 1] ?? null;
  }
  return null;
}

function parseSheet(m: MetricDef, ws: ExcelJS.Worksheet, years: string[]): { rows: Row[]; rowNumbers: number[]; error?: string } {
  const s = m.naac_sheet!;
  const cols = new Map((m.template?.columns ?? []).map((c) => [c.key, c]));
  // Every header row of every table, in sheet order (a by_year sheet has one per year).
  const headers: { row: number; t: Table }[] = [];
  // Only rows that hold values (blank rows are skipped below anyway), never 1..rowCount.
  const filled = populatedRowNumbers(ws);
  for (const r of filled) {
    const t = s.tables.find((x) => isHeader(ws, r, x));
    if (t) headers.push({ row: r, t });
  }
  if (!headers.length) return { rows: [], rowNumbers: [], error: `Sheet "${ws.name}" has none of NAAC's header rows for ${m.id}. Keep the header rows as they are in NAAC's workbook.` };
  const rows: Row[] = [];
  const rowNumbers: number[] = [];
  headers.forEach(({ row: h, t }, i) => {
    const year = s.by_year ? blockYear(ws, h, years) : null;
    const end = i + 1 < headers.length ? headers[i + 1].row : ws.rowCount + 1;
    for (const r of filled) {
      if (r <= h) continue;
      if (r >= end) break;
      const cells = t.columns.map((_, j) => text(ws.getRow(r).getCell(j + 1).value));
      const first = norm(cells[0]);
      // Stop at the next block: "Total", "Year 2", a caption, or a note / instruction under the table.
      if (/^(total|year \d|note|instruction)\b/.test(first) || (first && s.tables.some((x) => x.caption && norm(x.caption) === first))) break;
      if (!cells.some((v) => v !== null && String(v).trim() !== "")) continue;
      const out: Row = {};
      t.columns.forEach((c, j) => {
        if (c.key) out[c.key] = matchOption(cells[j], cols.get(c.key));
      });
      if (t.where) out[t.where.field] = t.where.eq;
      if (s.by_year && year && out.academic_year === undefined) out.academic_year = year;
      rows.push(out);
      rowNumbers.push(r);
    }
  });
  return { rows, rowNumbers };
}

/** Reads a workbook in NAAC's layout into the same shape as the app's own workbook import. */
export async function parseNaacWorkbook(fw: Framework, years: string[], body: Buffer): Promise<ParsedWorkbook> {
  const wb = await loadWorkbook(body, "an .xlsx file in NAAC's data-template layout");
  const bySheet = new Map(naacMetrics(fw).map((m) => [norm(m.naac_sheet!.sheet), m]));
  const out: ParsedWorkbook = { sheets: [], profile: [], profileErrors: [], ignored: [] };
  let total = 0;
  for (const ws of wb.worksheets) {
    if (ws.name === README_SHEET) continue;
    const m = bySheet.get(norm(ws.name));
    if (!m) {
      out.ignored.push(ws.name);
      continue;
    }
    const parsed = parseSheet(m, ws, years);
    total += parsed.rows.length;
    if (total > MAX_ROWS) throw badRequest(`Too many rows in the workbook (max ${MAX_ROWS})`);
    out.sheets.push({ metricId: m.id, ...parsed });
  }
  return out;
}
