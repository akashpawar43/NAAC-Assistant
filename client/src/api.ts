// Thin fetch wrapper for the /api/v1 endpoints.

// Empty when the API is on the same origin as the app (production default, and Vite's dev proxy).
// Set VITE_API_URL (e.g. https://api.example.in) at build time when the API is hosted elsewhere.
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

/** Absolute URL for an API path; use for links and downloads that bypass `api`. */
export const apiUrl = (path: string) => API_BASE + path;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(apiUrl(url), {
    method,
    // Sends the session cookie to the API even when it is on another origin.
    credentials: "include",
    headers: isForm || body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.details);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>("POST", url, body, headers),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ---------------------------------------------------------------- types (mirrors the server)

export type Role = "iqac_admin" | "dept_editor" | "viewer";
export interface Me {
  user: { id: string; email: string; name: string | null };
  memberships: { college_id: string; college_name: string; role: Role; department: string | null; owned: boolean }[];
}
export interface Cycle {
  id: string;
  kind: "AQAR" | "SSR";
  label: string;
  years: string[];
  framework_id: string;
  previous_cycle_id: string | null;
  college_name: string;
  state: string | null;
  institution_type: string | null;
  aishe_id: string | null;
  /** How the signed-in user reaches this report: their own, or shared with them. */
  access: Access;
  /** Set for reports shared with the user. */
  owner_email?: string | null;
}

export type Access = "owner" | "editor" | "viewer";
export const canEdit = (c: Pick<Cycle, "access">) => c.access === "owner" || c.access === "editor";
export interface Column {
  key: string;
  label: string;
  type: "text" | "int" | "number" | "year" | "date" | "enum" | "bool";
  required?: boolean;
  options?: string[];
}
export interface MetricDef {
  id: string;
  type: "quantitative" | "qualitative" | "checklist" | "choice" | "external";
  title: string;
  explain: string;
  unit?: string;
  criterion: string;
  key_indicator: string;
  key_indicator_title: string;
  verified?: boolean;
  /** The columns a row of this metric has. */
  columns: Column[];
  items?: { key: string; label: string }[];
  options?: { key: string; label: string }[];
  narrative?: { word_limit: number; min_words: number; fields: { key: string; label: string; type: "text" | "longtext"; required?: boolean }[] };
  evidence: { key: string; label: string; required?: boolean }[];
  /** Calculated from another metric's records (one NAAC data-template sheet serves both). */
  data_from?: string;
}
export interface Flag {
  metric_id: string;
  rule: string;
  severity: "high" | "medium" | "low";
  message: string;
  detail?: string;
}
export interface MetricDetail {
  metric: MetricDef;
  columns: Column[];
  entry_id: string | null;
  assigned_to: string | null;
  rows: { id: string; data: Record<string, unknown> }[];
  narrative: Record<string, string>;
  narrative_words: number;
  evidence: { id: string; evidence_key: string; filename: string; bytes: number; created_at: string }[];
  computed: { value: number | null; points: number | null; reason?: string; unit?: string };
  status: "empty" | "partial" | "complete";
  missing: string[];
  flags: Flag[];
  previous_value: number | null;
  can_edit: boolean;
}
export interface Dashboard {
  cycle: Cycle;
  framework: { id: string; name: string; version: string; verified: boolean };
  role: Role;
  readiness_pct: number;
  cgpa: { available: boolean; min: number; max: number; grade_min: string; grade_max: string; calculated_share: number };
  counts: { empty: number; partial: number; complete: number };
  inputs: Record<string, Record<string, number>>;
  criteria: {
    id: string;
    title: string;
    key_indicators: { id: string; title: string }[];
    metrics: { id: string; title: string; type: string; status: string; value: number | null; unit: string | null; points: number | null; assigned_to: string | null }[];
  }[];
}
export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  department: string | null;
}

/** "SSR 2024-25" — the kind is added only when the label does not already start with it. */
export const cycleName = (c: Pick<Cycle, "kind" | "label">) => (c.label.toUpperCase().startsWith(c.kind) ? c.label : `${c.kind} ${c.label}`);
