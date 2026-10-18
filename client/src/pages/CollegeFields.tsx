import { useEffect, useState } from "react";
import { api } from "../api";

export interface CollegeValues {
  college_name: string;
  state: string;
  institution_type: string;
  aishe_id: string;
}

export const emptyCollege: CollegeValues = { college_name: "", state: "", institution_type: "Affiliated College", aishe_id: "" };

// Used when the NAAC corpus is not loaded yet; otherwise the corpus's own spellings are used so
// the peer-example filters match.
const FALLBACK_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
  "Jammu And Kashmir", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
  "Orissa", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
];
const TYPES = ["Affiliated College", "Autonomous College", "University", "Standalone"];

/** College name, state, type and AISHE ID; place inside a .form-grid. */
export function CollegeFields({ value, onChange }: { value: CollegeValues; onChange: (v: CollegeValues) => void }) {
  const [states, setStates] = useState<string[]>(FALLBACK_STATES);
  useEffect(() => {
    api
      .get<{ states: string[] }>("/api/v1/corpus/filters")
      .then((f) => f.states.length && setStates(f.states))
      .catch(() => undefined);
  }, []);
  const set = (k: keyof CollegeValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <label className="full">
        College name
        <span className="req" aria-hidden="true">
          *
        </span>
        <input required maxLength={300} value={value.college_name} onChange={set("college_name")} placeholder="e.g. ABC College of Arts and Science" />
      </label>
      <label>
        State
        <select value={value.state} onChange={set("state")}>
          <option value="">Not set</option>
          {states.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Institution type
        <select value={value.institution_type} onChange={set("institution_type")}>
          <option value="">Not set</option>
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        AISHE ID <span className="muted">(optional)</span>
        <input maxLength={50} value={value.aishe_id} onChange={set("aishe_id")} placeholder="C-12345" />
      </label>
      <p className="hint" style={{ margin: 0, alignSelf: "end", paddingBottom: 6 }}>
        State and type are used to show peer examples and benchmarks from similar colleges.
      </p>
    </>
  );
}
