import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFramework } from "./framework.js";
import { buildTrends, type ReportValues } from "./trends.js";

const fw = parseFramework(readFileSync(new URL("../../demo/frameworks/demo_college.yaml", import.meta.url), "utf8"));
const report = (label: string, year: string, values: Record<string, number | null>): ReportValues => ({
  cycleId: label,
  label,
  year,
  values: new Map(Object.entries(values)),
});

describe("buildTrends", () => {
  it("orders reports by year and flags a drop of 10% or more", () => {
    const t = buildTrends(fw.metrics, [
      report("AQAR 24-25", "2024-25", { "5.2.1": 54, "3.1.1": 10 }),
      report("AQAR 22-23", "2022-23", { "5.2.1": 70, "3.1.1": 10 }),
      report("AQAR 23-24", "2023-24", { "5.2.1": 60, "3.1.1": 9.5 }),
    ]);
    expect(t.reports.map((r) => r.label)).toEqual(["AQAR 22-23", "AQAR 23-24", "AQAR 24-25"]);
    const placement = t.metrics.find((m) => m.metric_id === "5.2.1")!;
    expect(placement).toMatchObject({ points: [70, 60, 54], change_pct: -10, dropped: true });
    expect(t.metrics.find((m) => m.metric_id === "3.1.1")).toMatchObject({ change_pct: 5.3, dropped: false });
  });

  it("for lower-is-better metrics a rise is the bad direction", () => {
    const t = buildTrends(fw.metrics, [report("a", "2023-24", { "2.2.1": 20 }), report("b", "2024-25", { "2.2.1": 25 })]);
    expect(t.metrics[0]).toMatchObject({ metric_id: "2.2.1", change_pct: 25, dropped: true, lower_is_better: true });
  });

  it("skips gaps, zero bases and metrics with no values", () => {
    const t = buildTrends(fw.metrics, [
      report("new", "2024-25", { "5.2.1": 50 }),
      report("mid", "2023-24", { "5.2.1": null, "3.3.1": 0 }),
      report("old", "2022-23", { "5.2.1": 40, "3.3.1": 0 }),
    ]);
    expect(t.reports.map((r) => r.label)).toEqual(["old", "mid", "new"]);
    expect(t.metrics.find((m) => m.metric_id === "5.2.1")).toMatchObject({ points: [40, null, 50], change_pct: 25, dropped: false });
    expect(t.metrics.find((m) => m.metric_id === "3.3.1")!.change_pct).toBeNull();
    expect(t.metrics.find((m) => m.metric_id === "1.2.1")).toBeUndefined();
  });
});
