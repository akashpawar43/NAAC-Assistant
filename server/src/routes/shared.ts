// What every route module receives, and request shapes used by more than one of them.
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { FileStore } from "../infra/file-store.js";
import type { Mailer } from "../infra/mailer.js";
import type { Collection } from "../services/collection.js";
import type { Corpus } from "../services/corpus.js";
import type { FrameworkRegistry } from "../services/frameworks.js";
import type { Workspace } from "../services/workspace.js";

export interface RouteDeps {
  cfg: Config;
  db: Db;
  frameworks: FrameworkRegistry;
  files: FileStore;
  mailer: Mailer;
  ws: Workspace;
  corpus: Corpus;
  collection: Collection;
  /** APP_URL without a trailing slash: where links meant for people (sign-in landing, collection links) point. */
  appBase: string;
}

export type CycleParams = { Params: { cycleId: string } };
export type MetricParams = { Params: { cycleId: string; metricId: string } };

export const ReportCollegeFields = {
  college_name: z.string().min(1).max(300).optional(),
  state: z.string().max(200).nullish(),
  institution_type: z.string().max(200).nullish(),
  aishe_id: z.string().max(50).nullish(),
};
