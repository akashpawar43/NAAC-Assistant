// Row validation for metric data templates (manual entry and Excel import share this).
import type { Column } from "./framework.js";
import type { Row } from "./formula.js";

export interface RowError {
  row: number; // 1-based row number as the user sees it (Excel: data row index)
  field?: string;
  message: string;
}

export interface ValidationResult {
  rows: Row[];
  errors: RowError[];
}

const YEAR_RE = /^(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/;

/** "2023-24", "2023-2024", "2023/24" -> "2023-24". Returns null when not a valid academic year. */
export function normalizeYear(v: unknown): string | null {
  const m = YEAR_RE.exec(String(v ?? "").trim());
  if (!m) return null;
  const start = Number(m[1]);
  const endRaw = m[2];
  const ok = endRaw.length === 4 ? Number(endRaw) === start + 1 : Number(endRaw) === (start + 1) % 100;
  if (!ok) return null;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Academic years ending with `lastYear`, e.g. (2023-24, 5) -> 2019-20 .. 2023-24. */
export function academicYears(lastYear: string, count: number): string[] {
  const n = normalizeYear(lastYear);
  if (!n) throw new Error(`invalid academic year ${lastYear}`);
  const start = Number(n.slice(0, 4));
  return Array.from({ length: count }, (_, i) => {
    const s = start - (count - 1 - i);
    return `${s}-${String((s + 1) % 100).padStart(2, "0")}`;
  });
}

export function normalizeDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

export interface ValidateOptions {
  /** Allowed academic years (the cycle's years). */
  years?: string[];
  /** Column keys that together must be unique across rows. */
  unique?: string[];
  /** Rows already stored, used for the uniqueness check on single-row inserts. */
  existing?: Row[];
  /** Number shown to the user for the first row (Excel data starts at row 2). */
  firstRowNumber?: number;
  /** Exact row number per input row (Excel imports skip blank rows, so positions differ). */
  rowNumbers?: number[];
}

export function validateRows(columns: Column[], input: Row[], opts: ValidateOptions = {}): ValidationResult {
  const errors: RowError[] = [];
  const out: Row[] = [];
  const first = opts.firstRowNumber ?? 1;
  const seen = new Set<string>();
  const keyOf = (r: Row) => (opts.unique ?? []).map((k) => String(r[k] ?? "").trim().toLowerCase()).join("\u0001");
  for (const r of opts.existing ?? []) if (opts.unique?.length) seen.add(keyOf(r));

  input.forEach((raw, idx) => {
    const rowNo = opts.rowNumbers?.[idx] ?? first + idx;
    const row: Row = {};
    let ok = true;
    const err = (field: string, message: string) => {
      errors.push({ row: rowNo, field, message });
      ok = false;
    };
    for (const c of columns) {
      const v = raw[c.key];
      if (isBlank(v)) {
        if (c.required) err(c.key, `${c.label} is required`);
        continue;
      }
      switch (c.type) {
        case "text":
          row[c.key] = String(v).trim().slice(0, 2000);
          break;
        case "int":
        case "number": {
          const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
          if (!Number.isFinite(n)) {
            err(c.key, `${c.label} must be a number`);
            break;
          }
          if (c.type === "int" && !Number.isInteger(n)) {
            err(c.key, `${c.label} must be a whole number`);
            break;
          }
          if (c.min !== undefined && n < c.min) err(c.key, `${c.label} must be at least ${c.min}`);
          else if (c.max !== undefined && n > c.max) err(c.key, `${c.label} must be at most ${c.max}`);
          else row[c.key] = n;
          break;
        }
        case "year": {
          const y = normalizeYear(v);
          if (!y) err(c.key, `${c.label} must look like 2023-24`);
          else if (opts.years && !opts.years.includes(y)) err(c.key, `${y} is not a year of this cycle (${opts.years.join(", ")})`);
          else row[c.key] = y;
          break;
        }
        case "date": {
          const d = normalizeDate(v);
          if (!d) err(c.key, `${c.label} must be a date like 2024-01-31 or 31-01-2024`);
          else row[c.key] = d;
          break;
        }
        case "enum": {
          const match = (c.options ?? []).find((o) => o.toLowerCase() === String(v).trim().toLowerCase());
          if (!match) err(c.key, `${c.label} must be one of: ${(c.options ?? []).join(", ")}`);
          else row[c.key] = match;
          break;
        }
        case "bool": {
          const b = parseBool(v);
          if (b === null) err(c.key, `${c.label} must be Yes or No`);
          else row[c.key] = b;
          break;
        }
      }
    }
    if (ok && opts.unique?.length) {
      const k = keyOf(row);
      if (seen.has(k)) {
        errors.push({ row: rowNo, message: `Duplicate row (same ${opts.unique.join(" + ")})` });
        ok = false;
      } else seen.add(k);
    }
    if (ok) out.push(row);
  });
  return { rows: out, errors };
}
