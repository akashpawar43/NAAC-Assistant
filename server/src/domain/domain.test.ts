import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, FormulaError, pointsFor, validateFormula, type Formula } from "./formula.js";
import { parseFramework } from "./framework.js";
import { checklist, compute, status, type EntryState } from "./metric-state.js";
import { renderDraft, wordCount } from "./narrative.js";
import { parseQuery } from "./search-query.js";
import { academicYears, normalizeDate, normalizeYear, validateRows } from "./validation.js";

const FW_PATH = new URL("../../demo/frameworks/demo_college.yaml", import.meta.url);
const fw = parseFramework(readFileSync(FW_PATH, "utf8"));
const metric = (id: string) => fw.metrics.find((m) => m.id === id)!;
const years = academicYears("2023-24", 5);

describe("framework seed", () => {
  it("parses and validates every metric formula", () => {
    expect(fw.metrics.length).toBeGreaterThan(10);
    expect(fw.criteria.map((c) => c.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(metric("3.3.1").type).toBe("quantitative");
    expect(metric("7.2.1").narrative?.fields.map((f) => f.key)).toContain("evidence");
  });

  it("rejects an unquoted comma that would silently cut a label short", () => {
    const bad = readFileSync(FW_PATH, "utf8").replace('label: "Alumni, including former staff"', "label: Alumni, including former staff");
    expect(() => parseFramework(bad)).toThrow(/including former staff/);
  });

  it("rejects a formula with an unknown column", () => {
    const bad = readFileSync(FW_PATH, "utf8").replace("{op: sum, field: amount_lakhs}", "{op: sum, field: nope}");
    expect(() => parseFramework(bad)).toThrow(/unknown column nope/);
  });
});

describe("formula engine", () => {
  const inputs = {
    teachers_fulltime: { "2019-20": 40, "2020-21": 40, "2021-22": 50, "2022-23": 50, "2023-24": 60 },
    students_enrolled: Object.fromEntries(years.map((y) => [y, 1000])),
    outgoing_students: Object.fromEntries(years.map((y) => [y, 200])),
    computers_for_students: { "": 100 },
  };

  it("3.3.1 papers per teacher uses UGC-CARE rows and average teachers", () => {
    const rows = [
      ...Array.from({ length: 48 }, (_, i) => ({ academic_year: years[i % 5], ugc_care: true })),
      { academic_year: "2023-24", ugc_care: false },
    ];
    const r = evaluate(metric("3.3.1").formula as Formula, { rows, years, inputs });
    expect(r.value).toBe(1); // 48 / avg(40,40,50,50,60)=48
  });

  it("per_year averages yearly percentages (5.2.1 placements)", () => {
    const rows = years.flatMap((y, i) => Array.from({ length: (i + 1) * 20 }, () => ({ academic_year: y })));
    const r = evaluate(metric("5.2.1").formula as Formula, { rows, years, inputs });
    // yearly: 10%,20%,30%,40%,50% -> avg 30
    expect(r.value).toBe(30);
  });

  it("reports missing extended profile instead of guessing", () => {
    const r = evaluate(metric("5.2.1").formula as Formula, { rows: [], years, inputs: {} });
    expect(r.value).toBeNull();
    expect(r.reason).toMatch(/outgoing_students/);
  });

  it("division by zero gives no value", () => {
    const r = evaluate({ op: "div", args: [{ op: "const", value: 1 }, { op: "count" }] }, { rows: [], years, inputs });
    expect(r).toEqual({ value: null, reason: "division by zero" });
  });

  it("ratio uses the latest year and non-yearly inputs", () => {
    expect(evaluate(metric("4.3.2").formula as Formula, { rows: [], years, inputs }).value).toBe(10);
    expect(evaluate(metric("2.2.1").formula as Formula, { rows: [], years, inputs }).value).toBe(16.67);
  });

  it("checklist and choice metrics", () => {
    expect(compute(metric("1.4.1"), state({ rows: [{ students: true, teachers: true, employers: false, alumni: "yes" }] }))).toMatchObject({ value: 3, points: 3 });
    expect(compute(metric("1.4.2"), state({ rows: [{ option: "b" }] }))).toMatchObject({ value: 3, points: 3 });
  });

  it("where filters with eq/ne and count_distinct", () => {
    const rows = [
      { academic_year: "2023-24", teacher: "A", qualification: "PhD" },
      { academic_year: "2023-24", teacher: "a ", qualification: "Other" },
      { academic_year: "2023-24", teacher: "B", qualification: "NET" },
    ];
    expect(evaluate({ op: "count", where: { field: "qualification", ne: "Other" } }, { rows, years, inputs }).value).toBe(2);
    expect(evaluate({ op: "count_distinct", field: "teacher" }, { rows, years, inputs }).value).toBe(2);
  });

  it("validateFormula rejects unknown ops and nested per_year", () => {
    const env = { columns: new Set(["x"]), inputs: new Set(["k"]), where: "t" };
    expect(() => validateFormula({ op: "eval" } as unknown as Formula, env)).toThrow(FormulaError);
    expect(() =>
      validateFormula({ op: "per_year", agg: "avg", of: { op: "per_year", agg: "avg", of: { op: "count" } } }, env),
    ).toThrow(/nested/);
  });

  it("bands", () => {
    const b = metric("5.2.1").bands;
    expect(pointsFor(80, b)).toBe(4);
    expect(pointsFor(12, b)).toBe(1);
    expect(pointsFor(null, b)).toBeNull();
    expect(pointsFor(15, metric("2.2.1").bands, true)).toBe(4);
    expect(pointsFor(45, metric("2.2.1").bands, true)).toBe(1);
  });

  function state(p: Partial<EntryState>): EntryState {
    return { rows: [], narrative: {}, evidenceKeys: [], years, inputs, ...p };
  }
});

describe("validation", () => {
  const cols = metric("5.2.1").template!.columns;

  it("normalizes years and dates", () => {
    expect(normalizeYear("2023-2024")).toBe("2023-24");
    expect(normalizeYear("2023/24")).toBe("2023-24");
    expect(normalizeYear("2023-25")).toBeNull();
    expect(normalizeYear("1999-00")).toBe("1999-00");
    expect(normalizeDate("31-01-2024")).toBe("2024-01-31");
    expect(normalizeDate("2024-02-30")).toBeNull();
    expect(academicYears("2023-24", 2)).toEqual(["2022-23", "2023-24"]);
  });

  it("collects all errors with row numbers and keeps valid rows", () => {
    const res = validateRows(
      cols,
      [
        { academic_year: "2023-24", student: "Asha", outcome: "placed", employer_or_institution: "TCS", package_lpa: "3.6" },
        { academic_year: "2015-16", student: "Ravi", outcome: "Placed", employer_or_institution: "X" },
        { academic_year: "2023-24", student: "asha", outcome: "Higher education", employer_or_institution: "IIT" },
        { academic_year: "2023-24", student: "Meera", outcome: "Retired", employer_or_institution: "" },
      ],
      { years, unique: ["academic_year", "student"], firstRowNumber: 2 },
    );
    expect(res.rows).toEqual([
      { academic_year: "2023-24", student: "Asha", outcome: "Placed", employer_or_institution: "TCS", package_lpa: 3.6 },
    ]);
    expect(res.errors.map((e) => [e.row, e.field])).toEqual([
      [3, "academic_year"],
      [4, undefined],
      [5, "outcome"],
      [5, "employer_or_institution"],
    ]);
  });

  it("checks uniqueness against existing rows", () => {
    const res = validateRows(cols, [{ academic_year: "2023-24", student: "Asha", outcome: "Placed", employer_or_institution: "Y" }], {
      years,
      unique: ["academic_year", "student"],
      existing: [{ academic_year: "2023-24", student: "ASHA" }],
    });
    expect(res.errors[0].message).toMatch(/Duplicate/);
  });
});

describe("status and checklist", () => {
  const inputs = { outgoing_students: Object.fromEntries(years.map((y) => [y, 100])) };
  const m = metric("5.2.1");
  const base: EntryState = { rows: [], narrative: {}, evidenceKeys: [], years, inputs };

  it("a data-table metric with no rows has no value (not 0)", () => {
    expect(compute(metric("1.2.1"), base)).toMatchObject({ value: null, reason: "No rows entered yet" });
    expect(checklist(fw, metric("5.2.1"), base, compute(metric("5.2.1"), base)).map((f) => f.rule)).not.toContain("below_band");
  });

  it("empty -> partial -> complete", () => {
    expect(status(m, base, compute(m, base)).status).toBe("empty");
    const rows = years.map((y) => ({ academic_year: y }));
    const s1 = { ...base, rows };
    expect(status(m, s1, compute(m, s1))).toMatchObject({ status: "partial" });
    const s2 = { ...s1, evidenceKeys: ["data_template", "offer_letters"] };
    expect(status(m, s2, compute(m, s2))).toEqual({ status: "complete", missing: [] });
  });

  it("flags missing years, low band and drop vs previous cycle", () => {
    const s = { ...base, rows: [{ academic_year: "2023-24" }], previousValue: 40 };
    const flags = checklist(fw, m, s, compute(m, s)).map((f) => f.rule);
    expect(flags).toEqual(expect.arrayContaining(["missing_evidence", "missing_years"]));
    const full = { ...base, rows: years.map((y) => ({ academic_year: y })), previousValue: 40 };
    const f2 = checklist(fw, m, full, compute(m, full)).map((f) => f.rule);
    expect(f2).toEqual(expect.arrayContaining(["below_band", "drop_vs_previous"]));
  });

  it("qualitative metric needs required fields and minimum words", () => {
    const q = metric("7.2.1");
    const s = { ...base, narrative: { title: "Green campus" } };
    const st = status(q, s, compute(q, s));
    expect(st.status).toBe("partial");
    expect(st.missing.join(" ")).toMatch(/Objectives/);
    expect(checklist(fw, q, s, compute(q, s)).map((f) => f.rule)).toContain("narrative_short");
  });
});

describe("narrative drafts", () => {
  it("renders the best-practice template with facts", () => {
    const d = renderDraft({
      template: fw.narrative_templates.best_practice,
      fields: { title: "Earn while you learn", objectives: "Support students", context: "c", practice: "p", evidence: "e", problems: "none" },
      facts: ["5.2.1: 62% placed"],
    });
    expect(d.text).toContain("Practice: Earn while you learn");
    expect(d.text).toContain("From our data: 5.2.1: 62% placed.");
    expect(d.words).toBe(wordCount(d.text));
  });

  it("does not execute anything in field text", () => {
    const d = renderDraft({ template: "{{ fields.response }}", fields: { response: "{{ 7*7 }} {% raw %}" } });
    expect(d.text).toBe("{{ 7*7 }} {% raw %}");
  });
});

describe("search query parsing", () => {
  it("extracts metric IDs", () => {
    expect(parseQuery("3.3.1").metricId).toBe("3.3.1");
    expect(parseQuery("3.3.1").tsquery).toBeNull();
    expect(parseQuery("examples for 5.2 placement").metricId).toBe("5.2");
  });

  it("expands synonyms and escapes everything else", () => {
    const q = parseQuery("IQAC meetings");
    expect(q.tsquery).toBe("(iqac | (internal <-> quality <-> assurance <-> cell)) & meetings:*");
    expect(parseQuery("'); drop table x; --").tsquery).toBe("drop:* & table:*");
    expect(parseQuery("faculty development programme").tsquery).toContain("fdp");
  });
});
