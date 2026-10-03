import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimateCgpa, estimateMetric, gradeFor, type MetricInput } from "./cgpa.js";
import { parseFramework } from "./framework.js";

const fw = parseFramework(readFileSync(new URL("../../demo/frameworks/demo_college.yaml", import.meta.url), "utf8"));
const metric = (id: string) => fw.metrics.find((m) => m.id === id)!;
const input = (id: string, over: Partial<MetricInput> = {}): MetricInput => ({ m: metric(id), value: null, points: null, hasData: false, ...over });

describe("gradeFor", () => {
  it("follows NAAC's seven-point scale at the boundaries", () => {
    expect([4, 3.51, 3.5, 3.26, 3.25, 3.01, 3, 2.76, 2.75, 2.51, 2.5, 2.01, 2, 1.51, 1.5, 0].map(gradeFor)).toEqual([
      "A++", "A++", "A+", "A+", "A", "A", "B++", "B++", "B+", "B+", "B", "B", "C", "C", "D", "D",
    ]);
  });
});

describe("estimateMetric", () => {
  it("uses calculated points when a band exists, and widens to 0-4 when it cannot know", () => {
    expect(estimateMetric(input("5.2.1", { value: 80, points: 4, hasData: true }))).toMatchObject({ min: 4, max: 4, basis: "calculated" });
    expect(estimateMetric(input("3.1.1", { value: 25, points: null, hasData: true }))).toMatchObject({ min: 0, max: 4, basis: "no_benchmark" });
    expect(estimateMetric(input("5.2.1", { value: null, hasData: true }))).toMatchObject({ min: 0, max: 4, basis: "not_calculable" });
    expect(estimateMetric(input("5.2.1"))).toMatchObject({ min: 0, max: 0, basis: "no_data" });
    expect(estimateMetric(input("7.2.1", { hasData: true }))).toMatchObject({ min: 0, max: 4, basis: "peer_review" });
    expect(estimateMetric(input("7.2.1"))).toMatchObject({ min: 0, max: 0, basis: "no_data" });
    expect(estimateMetric(input("2.7.1"))).toMatchObject({ min: 0, max: 4, basis: "external" });
    expect(estimateMetric(input("1.4.2", { value: 3, points: 3, hasData: true }))).toMatchObject({ min: 3, max: 3 });
  });
});

describe("estimateCgpa", () => {
  it("an empty report is 0 except the student survey, which NAAC scores itself", () => {
    const e = estimateCgpa(fw, fw.metrics.map((m) => input(m.id)));
    expect(e.min).toBe(0);
    // Only the survey key indicator 2.7 (weight 100 of 1000) is open: 100 * 4 / 1000 = 0.4
    expect(e.max).toBe(0.4);
    expect(e.grade_min).toBe("D");
    expect(e.calculated_share).toBe(0); // nothing is calculated from data yet
  });

  it("all-4 data with written narratives gives 4.0 at best; weights follow the framework", () => {
    const all = fw.metrics.map((m) =>
      input(m.id, { value: m.formula ? 1 : null, points: m.bands || m.type === "choice" || m.type === "checklist" ? 4 : null, hasData: true }),
    );
    const e = estimateCgpa(fw, all);
    expect(e.max).toBe(4);
    expect(e.grade_max).toBe("A++");
    expect(e.min).toBeGreaterThan(0);
    expect(e.min).toBeLessThan(4);
    expect(e.criteria.reduce((a, c) => a + c.weight, 0)).toBe(1000);
    expect(e.criteria.find((c) => c.id === "2")!.weight).toBe(250);
    expect(e.calculated_share).toBeGreaterThan(0);
    expect(e.calculated_share).toBeLessThan(1);
  });

  it("is unavailable for a framework without key-indicator weights", () => {
    const noWeights = { ...fw, criteria: fw.criteria.map((c) => ({ ...c, key_indicators: c.key_indicators.map((k) => ({ ...k, weight: undefined })) })) };
    expect(estimateCgpa(noWeights, fw.metrics.map((m) => input(m.id))).available).toBe(false);
  });
});
