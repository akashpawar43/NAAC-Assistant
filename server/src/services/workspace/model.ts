// Shapes shared by the workspace services, and the dependencies each of them is built from.
import type { Db } from "../../db/client.js";
import type { FileStore } from "../../infra/file-store.js";
import type { Role } from "../auth.js";
import type { FrameworkRegistry } from "../frameworks.js";
import type { AccessGate } from "./access.js";
import type { Entries } from "./entries.js";

export type InputValue = { key: string; year?: string; value: number | null };
export type ShareRole = "editor" | "viewer";

export interface WorkbookReport {
  committed: boolean;
  mode: "append" | "replace";
  error_count: number;
  sheets: {
    metric_id: string;
    title: string;
    in_file: number;
    existing: number;
    valid: number;
    /** What saving would do to this metric. */
    action: "replace" | "add" | "unchanged" | "error";
    errors: { row?: number; field?: string; message: string }[];
  }[];
  profile: { values: number; errors: { row: number; message: string }[] };
  ignored_sheets: string[];
}

export interface Access {
  userId: string;
  collegeId: string;
  role: Role;
}

export interface CycleRow {
  id: string;
  college_id: string;
  framework_id: string;
  kind: "AQAR" | "SSR";
  label: string;
  years: string[];
  previous_cycle_id: string | null;
  created_at: string;
  college_name: string;
  state: string | null;
  institution_type: string | null;
  aishe_id: string | null;
}

/** The institution a report is about. Drives the peer-example and benchmark filters. */
export interface ReportCollege {
  college_name: string;
  state?: string | null;
  institution_type?: string | null;
  aishe_id?: string | null;
}

export interface CycleAccess extends Access {
  cycle: CycleRow;
}

/** Two reports are about the same college: same AISHE ID when both have one, else the same name. */
export function sameCollege(a: CycleRow, b: CycleRow): boolean {
  return a.aishe_id && b.aishe_id
    ? a.aishe_id.trim().toLowerCase() === b.aishe_id.trim().toLowerCase()
    : a.college_name.trim().toLowerCase() === b.college_name.trim().toLowerCase();
}

/** What every workspace service is built from; `access` and `entries` are shared, not per service. */
export interface WorkspaceContext {
  db: Db;
  frameworks: FrameworkRegistry;
  files: FileStore;
  access: AccessGate;
  entries: Entries;
  /** Total evidence bytes one workspace may store. */
  evidenceQuotaBytes: number;
}
