// Excel templates, import parsing and AQAR/SSR export workbooks.
import ExcelJS from "exceljs";
import type { Column, Framework, MetricDef } from "../domain/framework.js";
import { rowColumns } from "../domain/framework.js";
import type { Row } from "../domain/formula.js";
import { badRequest } from "./errors.js";
import { cellText, formatValue, type ReportModel } from "./report.js";
import { assertXlsxWithinLimits, XlsxLimitError } from "./xlsx-guard.js";

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
const MAX_IMPORT_ROWS = 5000;
const MAX_WORKBOOK_ROWS = 20000;
/** Rows below the data that get dropdown lists, so new rows can be typed in Excel. */
const DROPDOWN_ROWS = 1000;

function typeHint(c: Column): string {
  switch (c.type) {
    case "year":
      return "e.g. 2023-24";
    case "date":
      return "dd-mm-yyyy";
    case "bool":
      return "Yes / No";
    case "enum":
      return (c.options ?? []).join(" / ");
    case "int":
      return "whole number";
    case "number":
      return "number";
    default:
      return "";
  }
}

/** Writes a metric's data sheet: header row (what the importer matches on), optional rows, dropdowns. */
function fillMetricSheet(ws: ExcelJS.Worksheet, m: MetricDef, years: string[], rows: Row[] = []): void {
  const cols = rowColumns(m);
  ws.columns = cols.map((c) => ({ header: c.label + (c.required ? " *" : ""), key: c.key, width: Math.min(Math.max(c.label.length + 4, 14), 45) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = HEADER_FILL;
  for (const r of rows) ws.addRow(cols.map((c) => (typeof r[c.key] === "boolean" ? cellText(r[c.key]) : (r[c.key] ?? null))) as ExcelJS.CellValue[]);
  const lastRow = rows.length + DROPDOWN_ROWS;
  cols.forEach((c, i) => {
    const list = c.type === "enum" ? c.options : c.type === "bool" ? ["Yes", "No"] : c.type === "year" ? years : undefined;
    if (list?.length) {
      for (let r = 2; r <= lastRow; r++) {
        ws.getCell(r, i + 1).dataValidation = { type: "list", allowBlank: !c.required, formulae: [`"${list.join(",").slice(0, 250)}"`] };
      }
    }
    ws.getCell(1, i + 1).note = typeHint(c) || c.label;
  });
}

/** Blank template: row 1 = labels (what the importer matches on), row 2+ = data. */
export async function metricTemplate(m: MetricDef, years: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  fillMetricSheet(wb.addWorksheet(m.id.replaceAll(".", "_")), m, years);
  const info = wb.addWorksheet("About");
  info.addRows([
    [`Metric ${m.id}`],
    [m.title],
    [],
    ["How to fill"],
    [m.explain],
    [],
    ["Columns marked * are required. Keep the header row as it is. Years must be one of: " + years.join(", ")],
  ]);
  info.getColumn(1).width = 120;
  info.getCell("A1").font = { bold: true, size: 14 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result as ExcelJS.CellValue);
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("hyperlink" in v) return (v as { text?: string; hyperlink: string }).text ?? v.hyperlink;
    return null;
  }
  return v;
}

const norm = (s: string) => s.toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const TEMPLATE_HINT = "an .xlsx file made from the template";

/** Reads an uploaded .xlsx; a file ExcelJS cannot open is the user's mistake, so a 400 that says what to upload. */
export async function loadWorkbook(body: Buffer, expected = TEMPLATE_HINT): Promise<ExcelJS.Workbook> {
  try {
    assertXlsxWithinLimits(body);
  } catch (e) {
    if (!(e instanceof XlsxLimitError)) throw e;
    throw badRequest(e.message === "uncompressed size limit exceeded" ? "The file is too large once unpacked. Split it into smaller files." : `Could not read the file. Upload ${expected}.`);
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(body as unknown as ArrayBuffer);
  } catch {
    throw badRequest(`Could not read the file. Upload ${expected}.`);
  }
  return wb;
}

/**
 * Numbers of the rows from `from` on that hold a value, in order. Never loops up to
 * `ws.rowCount`: one stray cell at row 1,048,576 would otherwise make every import walk (and
 * allocate) a million empty rows.
 */
export function populatedRowNumbers(ws: ExcelJS.Worksheet, from = 1): number[] {
  const out: number[] = [];
  ws.eachRow({ includeEmpty: false }, (_row, r) => {
    if (r >= from) out.push(r);
  });
  return out;
}

/** Single-metric import: reads the first sheet of the uploaded file. */
export async function parseImport(m: MetricDef, body: Buffer): Promise<{ rows: Row[]; rowNumbers: number[] }> {
  const ws = (await loadWorkbook(body)).worksheets[0];
  if (!ws) throw badRequest("The workbook has no sheets");
  return parseSheet(m, ws);
}

/** Reads one metric's sheet; columns are matched by header label or key, in any order. */
function parseSheet(m: MetricDef, ws: ExcelJS.Worksheet): { rows: Row[]; rowNumbers: number[] } {
  const cols = rowColumns(m);
  const header = ws.getRow(1);
  const map = new Map<number, string>();
  header.eachCell((cell, colNo) => {
    const h = norm(String(cellValue(cell.value) ?? ""));
    const c = cols.find((x) => norm(x.label) === h || norm(x.key) === h);
    if (c) map.set(colNo, c.key);
  });
  const missing = cols.filter((c) => c.required && ![...map.values()].includes(c.key));
  if (missing.length) throw badRequest(`Missing columns: ${missing.map((c) => c.label).join(", ")}. Use the template for ${m.id}.`);
  const rows: Row[] = [];
  const rowNumbers: number[] = [];
  for (const r of populatedRowNumbers(ws, 2)) {
    const row: Row = {};
    let any = false;
    for (const [colNo, key] of map) {
      const v = cellValue(ws.getRow(r).getCell(colNo).value);
      if (v !== null && String(v).trim() !== "") any = true;
      row[key] = v;
    }
    if (any) {
      rows.push(row);
      rowNumbers.push(r);
    }
    if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`Too many rows (max ${MAX_IMPORT_ROWS})`);
  }
  return { rows, rowNumbers };
}

// ---------------------------------------------------------------- one workbook for all metrics

const PROFILE_SHEET = "Extended profile";
const README_SHEET = "Read me";

export interface WorkbookSheet {
  metricId: string;
  rows: Row[];
  rowNumbers: number[];
  /** Set when the sheet itself is unusable (for example a required column was deleted). */
  error?: string;
}

export interface ParsedWorkbook {
  sheets: WorkbookSheet[];
  profile: { key: string; year: string; value: number }[];
  profileErrors: { row: number; message: string }[];
  /** Sheets that are not a data metric of this framework; ignored and reported back. */
  ignored: string[];
}

/** Every data metric on its own sheet (named by metric ID), pre-filled with the current rows. */
export async function workbookTemplate(
  fw: Framework,
  years: string[],
  rowsByMetric: Map<string, Row[]>,
  inputs: Record<string, Record<string, number>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NAAC Assistant";
  const metrics = fw.metrics.filter((m) => m.type === "quantitative" && rowColumns(m).length);
  const readme = wb.addWorksheet(README_SHEET);
  readme.addRows([
    ["How to use this workbook"],
    [],
    ["Each sheet named like 5.2.1 holds one metric's data. Keep the sheet names and header rows as they are."],
    [`Academic years must be one of: ${years.join(", ")}.`],
    [`"${PROFILE_SHEET}" holds the base numbers (students, teachers, ...). A blank cell there means "no change".`],
    ['When uploading, choose "Replace" to make each sheet the metric\'s data, or "Add" to append the rows.'],
    ["A sheet with no data rows never clears a metric. Delete a sheet if there is nothing to send for it."],
    [],
    ["Sheet", "Metric"],
    ...metrics.map((m) => [m.id, m.title]),
  ]);
  readme.getColumn(1).width = 12;
  readme.getColumn(2).width = 110;
  readme.getCell("A1").font = { bold: true, size: 14 };

  const ep = wb.addWorksheet(PROFILE_SHEET);
  ep.addRow(["Field", "Key", ...years, "Value (not yearly)"]).font = { bold: true };
  for (const i of fw.inputs) {
    const v = inputs[i.key] ?? {};
    ep.addRow([i.label, i.key, ...years.map((y) => (i.per_year ? (v[y] ?? null) : null)), i.per_year ? null : (v[""] ?? null)]);
  }
  ep.getColumn(1).width = 50;
  ep.getColumn(2).hidden = true;

  for (const m of metrics) fillMetricSheet(wb.addWorksheet(m.id), m, years, rowsByMetric.get(m.id) ?? []);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parseWorkbook(fw: Framework, years: string[], body: Buffer): Promise<ParsedWorkbook> {
  const wb = await loadWorkbook(body);
  const byId = new Map(fw.metrics.filter((m) => m.type === "quantitative" && !m.data_from).map((m) => [m.id, m]));
  const out: ParsedWorkbook = { sheets: [], profile: [], profileErrors: [], ignored: [] };
  let total = 0;
  for (const ws of wb.worksheets) {
    const name = ws.name.trim();
    if (name === README_SHEET) continue;
    if (name === PROFILE_SHEET) {
      parseProfileSheet(fw, years, ws, out);
      continue;
    }
    const m = byId.get(name.replace(/_/g, "."));
    if (!m) {
      out.ignored.push(name);
      continue;
    }
    let parsed: { rows: Row[]; rowNumbers: number[] };
    try {
      parsed = parseSheet(m, ws);
    } catch (e) {
      out.sheets.push({ metricId: m.id, rows: [], rowNumbers: [], error: e instanceof Error ? e.message : "Unreadable sheet" });
      continue;
    }
    total += parsed.rows.length;
    if (total > MAX_WORKBOOK_ROWS) throw badRequest(`Too many rows in the workbook (max ${MAX_WORKBOOK_ROWS})`);
    out.sheets.push({ metricId: m.id, ...parsed });
  }
  return out;
}

function parseProfileSheet(fw: Framework, years: string[], ws: ExcelJS.Worksheet, out: ParsedWorkbook): void {
  const header: string[] = [];
  ws.getRow(1).eachCell((cell, col) => (header[col] = String(cellValue(cell.value) ?? "").trim()));
  const colOf = (name: string) => header.findIndex((h) => h === name);
  const keyCol = colOf("Key");
  const valueCol = header.findIndex((h) => /^value/i.test(h ?? ""));
  if (keyCol < 0) {
    out.profileErrors.push({ row: 1, message: `The "${PROFILE_SHEET}" sheet has no Key column. Download a fresh workbook.` });
    return;
  }
  const defs = new Map(fw.inputs.map((i) => [i.key, i]));
  for (const r of populatedRowNumbers(ws, 2)) {
    const row = ws.getRow(r);
    const def = defs.get(String(cellValue(row.getCell(keyCol).value) ?? "").trim());
    if (!def) continue;
    const cells: [string, number][] = def.per_year ? years.map((y) => [y, colOf(y)]) : [["", valueCol]];
    for (const [year, col] of cells) {
      if (col < 0) continue;
      const raw = cellValue(row.getCell(col).value);
      if (raw === null || String(raw).trim() === "") continue; // blank = no change
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) {
        out.profileErrors.push({ row: r, message: `${def.label}${year ? ` (${year})` : ""}: "${String(raw)}" is not a non-negative number` });
        continue;
      }
      out.profile.push({ key: def.key, year, value: n });
    }
  }
}

/** One workbook: summary, extended profile, one sheet per data metric, answers, narratives. */
export async function exportWorkbook(r: ReportModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NAAC Assistant";
  const metrics = r.criteria.flatMap((c) => c.metrics);
  const sum = wb.addWorksheet("Summary");
  sum.addRow([`${r.collegeName}: ${r.title}`]).font = { bold: true, size: 14 };
  if (!r.wholeReport) sum.addRow([`Selection: ${r.selection}`]).font = { italic: true };
  sum.addRow([`Framework: ${r.framework.name} v${r.framework.version}${r.framework.verified ? "" : " (formulas indicative; verify against the NAAC manual)"}`]);
  sum.addRow([`Academic years: ${r.years.join(", ")}`]);
  sum.addRow([]);
  const hdr = sum.addRow(["Metric", "Title", "Type", "Value", "Unit", "Indicative points", "Status", "Note"]);
  hdr.font = { bold: true };
  hdr.fill = HEADER_FILL;
  for (const x of metrics) {
    sum.addRow([x.m.id, x.m.title, x.m.type, x.value, x.m.unit ?? "", x.points, x.status, x.reason ?? ""]);
  }
  sum.getColumn(2).width = 80;
  sum.getColumn(8).width = 50;

  const ep = wb.addWorksheet("Extended profile");
  const epHdr = ep.addRow(["Field", ...r.years, "Value (not yearly)"]);
  epHdr.font = { bold: true };
  for (const inp of r.inputs) ep.addRow([inp.label, ...inp.values, inp.value]);
  ep.getColumn(1).width = 50;

  const used = new Set<string>();
  for (const x of metrics) {
    if (!x.columns.length) continue;
    let name = `${x.m.id}`;
    while (used.has(name)) name += "_";
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.addRow([`${x.m.id} ${x.m.title}`]).font = { bold: true };
    ws.addRow([`Value: ${formatValue(x.value, x.m.unit)}`]);
    ws.addRow([]);
    const h = ws.addRow(x.columns.map((c) => c.label));
    h.font = { bold: true };
    h.fill = HEADER_FILL;
    for (const row of x.rows) ws.addRow(x.columns.map((c) => (typeof row[c.key] === "boolean" ? cellText(row[c.key]) : (row[c.key] ?? null))) as ExcelJS.CellValue[]);
    if (x.evidence.length) {
      ws.addRow([]);
      ws.addRow(["Evidence"]).font = { bold: true };
      for (const e of x.evidence) ws.addRow([e.label, { text: e.filename, hyperlink: e.link }]);
    }
    x.columns.forEach((c, i) => (ws.getColumn(i + 1).width = Math.min(Math.max(c.label.length + 2, 12), 40)));
  }

  const answered = metrics.filter((x) => x.answer.length);
  if (answered.length) {
    const aw = wb.addWorksheet("Answers");
    aw.getColumn(1).width = 12;
    aw.getColumn(2).width = 110;
    for (const x of answered) {
      aw.addRow([x.m.id, x.m.title]).font = { bold: true };
      for (const line of x.answer) aw.addRow(["", line]);
      aw.addRow([]);
    }
  }

  const narratives = metrics.filter((y) => y.m.type === "qualitative");
  if (narratives.length) {
    const nw = wb.addWorksheet("Narratives");
    nw.getColumn(1).width = 12;
    nw.getColumn(2).width = 120;
    for (const x of narratives) {
      nw.addRow([x.m.id, x.m.title]).font = { bold: true };
      for (const f of x.m.narrative?.fields ?? []) {
        const t = x.narrative[f.key];
        if (t) {
          const row = nw.addRow([f.label, t]);
          row.alignment = { wrapText: true, vertical: "top" };
        }
      }
      nw.addRow([]);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
