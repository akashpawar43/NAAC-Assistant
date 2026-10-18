import { useEffect, useState } from "react";
import { api, type Cycle } from "../../api";

interface Filters {
  states: string[];
  types: string[];
  grades: string[];
}

/** Filters start from the report's own state and institution type ("colleges like mine"). */
export function usePeerFilters(cycle: Cycle) {
  const [filters, setFilters] = useState<Filters | null>(null);
  const [f, setF] = useState({ state: cycle.state ?? "", type: cycle.institution_type ?? "", min_grade: "A" });
  const withCurrent = (list: string[] | undefined, cur: string) =>
    cur && !(list ?? []).some((x) => x.toLowerCase() === cur.toLowerCase()) ? [cur, ...(list ?? [])] : (list ?? []);
  useEffect(() => {
    api.get<Filters>("/api/v1/corpus/filters").then(setFilters, () => setFilters(null));
  }, []);
  const ui = (
    <>
      <select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} aria-label="State">
        <option value="">All states</option>
        {withCurrent(filters?.states, f.state).map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Institution type">
        <option value="">All institution types</option>
        {withCurrent(filters?.types, f.type).map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <select value={f.min_grade} onChange={(e) => setF({ ...f, min_grade: e.target.value })} aria-label="Grade">
        <option value="">Any grade</option>
        {["A++", "A+", "A", "B++", "B+", "B"].map((g) => (
          <option key={g} value={g}>
            {g} or better
          </option>
        ))}
      </select>
    </>
  );
  return { f, ui };
}
