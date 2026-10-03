// Safe declarative formula engine. Formulas are JSON trees from the framework seed;
// nothing is ever passed to eval/Function. See server/demo/frameworks for examples of the language.

export type Where = {
  field: string;
  eq?: unknown;
  ne?: unknown;
  in?: unknown[];
  gte?: number;
  lte?: number;
};

// count/sum/avg/count_distinct read the metric's own rows, or another metric's with `metric`
// (e.g. 5.2.2 subtracts the students counted in 5.2.1).
export type Formula =
  | { op: "count"; where?: Where; metric?: string }
  | { op: "sum" | "avg" | "count_distinct"; field: string; where?: Where; metric?: string }
  | { op: "input"; key: string; year?: "latest" | "avg" }
  | { op: "per_year"; of: Formula; agg: "avg" | "sum" }
  | { op: "years" }
  | { op: "div" | "mul" | "add" | "sub"; args: [Formula, Formula] }
  | { op: "const"; value: number }
  | { op: "checked" }
  | { op: "choice"; field: string };

export type Row = Record<string, unknown>;

export interface FormulaContext {
  rows: Row[];
  /** Rows of other metrics a formula names with `metric`. */
  rowsOf?: Record<string, Row[]>;
  /** Academic years of the cycle in order, e.g. ["2019-20", ..., "2023-24"]. */
  years: string[];
  /** Extended-profile values: key -> year -> value. Non-yearly inputs use year "". */
  inputs: Record<string, Record<string, number>>;
  /** Points per option key for choice metrics. */
  optionPoints?: Record<string, number>;
  /** Set while evaluating inside per_year. */
  year?: string;
  yearField?: string;
}

export interface FormulaResult {
  value: number | null;
  /** Why there is no value (missing input, division by zero, no rows ...). */
  reason?: string;
}

export class FormulaError extends Error {}

class NoValue extends Error {}

const YEAR_FIELD = "academic_year";

export function evaluate(f: Formula, ctx: FormulaContext): FormulaResult {
  try {
    const v = ev(f, { yearField: YEAR_FIELD, ...ctx });
    if (!Number.isFinite(v)) return { value: null, reason: "result is not a finite number" };
    return { value: round(v) };
  } catch (e) {
    if (e instanceof NoValue) return { value: null, reason: e.message };
    throw e;
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function rowsIn(ctx: FormulaContext, metric?: string): Row[] {
  const rows = metric ? (ctx.rowsOf?.[metric] ?? []) : ctx.rows;
  if (!ctx.year) return rows;
  return rows.filter((r) => String(r[ctx.yearField ?? YEAR_FIELD] ?? "") === ctx.year);
}

/** Other metrics whose rows a formula reads (`metric` on an aggregate). */
export function referencedMetrics(f: Formula): string[] {
  const out = new Set<string>();
  const walk = (n: Formula) => {
    if ("metric" in n && n.metric) out.add(n.metric);
    if (n.op === "per_year") walk(n.of);
    if (n.op === "div" || n.op === "mul" || n.op === "add" || n.op === "sub") n.args.forEach(walk);
  };
  walk(f);
  return [...out];
}

function matches(r: Row, w?: Where): boolean {
  if (!w) return true;
  const v = r[w.field];
  if ("eq" in w && !looseEq(v, w.eq)) return false;
  if ("ne" in w && looseEq(v, w.ne)) return false;
  if (w.in && !w.in.some((x) => looseEq(v, x))) return false;
  if (w.gte !== undefined && !(num(v) !== null && num(v)! >= w.gte)) return false;
  if (w.lte !== undefined && !(num(v) !== null && num(v)! <= w.lte)) return false;
  return true;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (typeof b === "boolean") return toBool(a) === b;
  if (typeof b === "number") return num(a) === b;
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

export function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return ["true", "yes", "y", "1"].includes(String(v ?? "").trim().toLowerCase());
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function inputValue(ctx: FormulaContext, key: string, mode?: "latest" | "avg"): number {
  const byYear = ctx.inputs[key] ?? {};
  if (ctx.year && mode === undefined) {
    const v = byYear[ctx.year] ?? byYear[""];
    if (v === undefined) throw new NoValue(`extended profile "${key}" missing for ${ctx.year}`);
    return v;
  }
  if (byYear[""] !== undefined && Object.keys(byYear).length === 1) return byYear[""];
  const vals = ctx.years.map((y) => byYear[y]).filter((v): v is number => v !== undefined);
  if (!vals.length) {
    if (byYear[""] !== undefined) return byYear[""];
    throw new NoValue(`extended profile "${key}" is missing`);
  }
  if (mode === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
  // latest (default outside per_year): the last year that has a value
  for (let i = ctx.years.length - 1; i >= 0; i--) {
    const v = byYear[ctx.years[i]];
    if (v !== undefined) return v;
  }
  return vals[vals.length - 1];
}

function ev(f: Formula, ctx: FormulaContext): number {
  switch (f.op) {
    case "const":
      return f.value;
    case "count":
      return rowsIn(ctx, f.metric).filter((r) => matches(r, f.where)).length;
    case "sum":
      return rowsIn(ctx, f.metric)
        .filter((r) => matches(r, f.where))
        .reduce((a, r) => a + (num(r[f.field]) ?? 0), 0);
    case "avg": {
      const vals = rowsIn(ctx, f.metric)
        .filter((r) => matches(r, f.where))
        .map((r) => num(r[f.field]))
        .filter((v): v is number => v !== null);
      if (!vals.length) throw new NoValue(`no values for ${f.field}`);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    case "count_distinct": {
      const s = new Set(
        rowsIn(ctx, f.metric)
          .filter((r) => matches(r, f.where))
          .map((r) => String(r[f.field] ?? "").trim().toLowerCase())
          .filter((v) => v !== ""),
      );
      return s.size;
    }
    case "input":
      return inputValue(ctx, f.key, f.year);
    case "years":
      return ctx.years.length;
    case "per_year": {
      const vals: number[] = [];
      const missing: string[] = [];
      for (const y of ctx.years) {
        try {
          vals.push(ev(f.of, { ...ctx, year: y }));
        } catch (e) {
          if (!(e instanceof NoValue)) throw e;
          missing.push(`${y}: ${e.message}`);
        }
      }
      // A year that cannot be computed makes the whole metric unreliable; report it.
      if (missing.length) throw new NoValue(missing.join("; "));
      if (!vals.length) throw new NoValue("cycle has no academic years");
      const total = vals.reduce((a, b) => a + b, 0);
      return f.agg === "sum" ? total : total / vals.length;
    }
    case "div": {
      const a = ev(f.args[0], ctx);
      const b = ev(f.args[1], ctx);
      if (b === 0) throw new NoValue(ctx.year ? `division by zero in ${ctx.year}` : "division by zero");
      return a / b;
    }
    case "mul":
      return ev(f.args[0], ctx) * ev(f.args[1], ctx);
    case "add":
      return ev(f.args[0], ctx) + ev(f.args[1], ctx);
    case "sub":
      return ev(f.args[0], ctx) - ev(f.args[1], ctx);
    case "checked": {
      const r = ctx.rows[0];
      if (!r) throw new NoValue("nothing ticked yet");
      return Object.values(r).filter((v) => toBool(v)).length;
    }
    case "choice": {
      const r = ctx.rows[0];
      const key = r ? String(r[f.field] ?? "").trim().toUpperCase() : "";
      if (!key) throw new NoValue("no option selected");
      const p = ctx.optionPoints?.[key];
      if (p === undefined) throw new NoValue(`unknown option ${key}`);
      return p;
    }
    default:
      throw new FormulaError(`unknown op ${(f as { op: string }).op}`);
  }
}

/** Check a formula tree at seed time so a bad framework file fails loudly, not at runtime. */
export function validateFormula(
  f: Formula,
  env: { columns: Set<string>; inputs: Set<string>; where: string; metricColumns?: Map<string, Set<string>> },
): void {
  const fail = (msg: string) => {
    throw new FormulaError(`${env.where}: ${msg}`);
  };
  // The columns an aggregate reads: its own metric's, or the named metric's.
  const columnsOf = (metric?: string): Set<string> => {
    if (!metric) return env.columns;
    const cols = env.metricColumns?.get(metric);
    if (!cols) fail(`reads rows of unknown metric ${metric}`);
    return cols!;
  };
  const walk = (n: Formula, inPerYear: boolean): void => {
    if (!n || typeof n !== "object" || typeof (n as { op?: unknown }).op !== "string") fail("formula node must have an op");
    const checkWhere = (w: Where | undefined, cols: Set<string>) => {
      if (w && !cols.has(w.field)) fail(`where uses unknown column ${w.field}`);
    };
    switch (n.op) {
      case "const":
        if (typeof n.value !== "number") fail("const needs a numeric value");
        return;
      case "count":
        return checkWhere(n.where, columnsOf(n.metric));
      case "sum":
      case "avg":
      case "count_distinct": {
        const cols = columnsOf(n.metric);
        if (!cols.has(n.field)) fail(`${n.op} uses unknown column ${n.field}`);
        return checkWhere(n.where, cols);
      }
      case "input":
        if (!env.inputs.has(n.key)) fail(`unknown extended-profile input ${n.key}`);
        return;
      case "per_year":
        if (inPerYear) fail("per_year cannot be nested");
        if (n.agg !== "avg" && n.agg !== "sum") fail("per_year agg must be avg or sum");
        return walk(n.of, true);
      case "div":
      case "mul":
      case "add":
      case "sub":
        if (!Array.isArray(n.args) || n.args.length !== 2) fail(`${n.op} needs two args`);
        walk(n.args[0], inPerYear);
        walk(n.args[1], inPerYear);
        return;
      case "years":
      case "checked":
        return;
      case "choice":
        if (!columnsOf().has(n.field)) fail(`choice uses unknown column ${n.field}`);
        return;
      default:
        fail(`unknown op ${(n as { op: string }).op}`);
    }
  };
  walk(f, false);
}

/** Indicative score points for a value given the metric's bands. */
export function pointsFor(value: number | null, bands?: { min?: number; max?: number; points: number }[], lowerIsBetter = false): number | null {
  if (value === null || !bands?.length) return null;
  for (const b of bands) {
    if (lowerIsBetter ? b.max !== undefined && value <= b.max : b.min !== undefined && value >= b.min) return b.points;
  }
  return 0;
}
