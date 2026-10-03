import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planFromAqars, type AqarSource, type CycleData } from "./aqar-merge.js";
import { parseFramework } from "./framework.js";

const fw = parseFramework(readFileSync(new URL("../../demo/frameworks/demo_college.yaml", import.meta.url), "utf8"));
const YEARS = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"];
const empty = (): CycleData => ({ rowsByMetric: new Map(), narrativeByMetric: new Map(), inputs: {} });

function aqar(year: string, over: Partial<CycleData> = {}, label = `AQAR ${year}`): AqarSource {
  return { cycleId: `c-${label}`, label, year, ...empty(), ...over };
}
const placement = (year: string, student: string) => ({ academic_year: year, student, outcome: "Placed", employer_or_institution: "TCS" });

describe("planFromAqars", () => {
  it("copies each AQAR's rows, profile values and the latest narrative into an empty SSR", () => {
    const plan = planFromAqars(YEARS, fw.metrics, empty(), [
      aqar("2023-24", {
        rowsByMetric: new Map([["5.2.1", [placement("2023-24", "A")]]]),
        inputs: { outgoing_students: { "2023-24": 100 }, classrooms_seminar_halls: { "": 20 } },
        narrativeByMetric: new Map([["7.3.1", { area: "Old", description: "older text" }]]),
      }),
      aqar("2024-25", {
        rowsByMetric: new Map([["5.2.1", [placement("2024-25", "B")]], ["1.4.1", [{ students: true }]]]),
        inputs: { outgoing_students: { "2024-25": 120 }, classrooms_seminar_halls: { "": 25 } },
        narrativeByMetric: new Map([["7.3.1", { area: "New", description: "newer text" }]]),
      }),
    ]);
    expect(plan.sources.map((s) => s.year)).toEqual(["2023-24", "2024-25"]);
    expect(plan.yearsWithoutAqar).toEqual(["2020-21", "2021-22", "2022-23"]);
    expect(plan.rows).toEqual([{ metricId: "5.2.1", add: [placement("2023-24", "A"), placement("2024-25", "B")], duplicates: 0 }]);
    expect(plan.inputs).toEqual(
      expect.arrayContaining([
        { key: "outgoing_students", year: "2023-24", value: 100 },
        { key: "outgoing_students", year: "2024-25", value: 120 },
        { key: "classrooms_seminar_halls", year: "", value: 25 }, // non-yearly: latest AQAR
      ]),
    );
    expect(plan.answers.find((a) => a.metricId === "7.3.1")).toMatchObject({ fromLabel: "AQAR 2024-25", narrative: { area: "New" } });
    expect(plan.answers.find((a) => a.metricId === "1.4.1")?.rows).toEqual([{ students: true }]);
  });

  it("never overwrites the SSR and is idempotent", () => {
    const ssr: CycleData = {
      rowsByMetric: new Map([["5.2.1", [placement("2024-25", "B")]], ["1.4.1", [{ students: false }]]]),
      narrativeByMetric: new Map([["7.3.1", { area: "Mine", description: "written in SSR" }]]),
      inputs: { outgoing_students: { "2024-25": 999 } },
    };
    const plan = planFromAqars(YEARS, fw.metrics, ssr, [
      aqar("2024-25", {
        rowsByMetric: new Map([["5.2.1", [placement("2024-25", "b "), placement("2024-25", "C")]], ["1.4.1", [{ students: true }]]]),
        narrativeByMetric: new Map([["7.3.1", { area: "AQAR", description: "x" }]]),
        inputs: { outgoing_students: { "2024-25": 120 } },
      }),
    ]);
    // "b " matches "B" on the unique key (year + student), so only C is new.
    expect(plan.rows).toEqual([{ metricId: "5.2.1", add: [placement("2024-25", "C")], duplicates: 1 }]);
    expect(plan.inputs).toEqual([]);
    expect(plan.answers).toEqual([]);
  });

  it("uses only the first AQAR given for a year and ignores rows tagged with other years", () => {
    const plan = planFromAqars(YEARS, fw.metrics, empty(), [
      aqar("2024-25", { rowsByMetric: new Map([["5.2.1", [placement("2024-25", "Newest")]]]) }, "AQAR 2024-25 v2"),
      aqar("2024-25", { rowsByMetric: new Map([["5.2.1", [placement("2024-25", "Older copy")]]]) }, "AQAR 2024-25 v1"),
      aqar("2023-24", { rowsByMetric: new Map([["5.2.1", [placement("2019-20", "Stray")]]]) }),
      aqar("2018-19", { rowsByMetric: new Map([["5.2.1", [placement("2018-19", "Outside SSR")]]]) }),
    ]);
    expect(plan.sources.map((s) => s.label)).toEqual(["AQAR 2023-24", "AQAR 2024-25 v2"]);
    expect(plan.rows[0].add.map((r) => r.student)).toEqual(["Newest"]);
  });
});
