// College workspace: cycles, extended profile, metric rows, narratives, evidence, dashboard.
// Tenant isolation: every query that touches college data filters by the college_id that
// came from a membership check (`collegeAccess` / `cycleAccess`), never from the request body.
//
// Each area lives in its own service under workspace/; this class only wires them together and
// keeps one object for the routes to call.
import type { Db } from "../db/client.js";
import type { FileStore } from "../infra/file-store.js";
import type { FrameworkRegistry } from "./frameworks.js";
import { AccessGate } from "./workspace/access.js";
import { Cycles } from "./workspace/cycles.js";
import { Entries } from "./workspace/entries.js";
import { Evaluation } from "./workspace/evaluation.js";
import { Evidence } from "./workspace/evidence.js";
import { MetricData } from "./workspace/metric-data.js";
import type { WorkspaceContext } from "./workspace/model.js";
import { Narratives } from "./workspace/narratives.js";
import { Sharing } from "./workspace/sharing.js";

export type { Access, CycleAccess, CycleRow, InputValue, ReportCollege, ShareRole, WorkbookReport } from "./workspace/model.js";
export { sameCollege } from "./workspace/model.js";

export class Workspace {
  private readonly access: AccessGate;
  private readonly entries: Entries;
  private readonly cycles: Cycles;
  private readonly sharing: Sharing;
  private readonly data: MetricData;
  private readonly narratives: Narratives;
  private readonly evidence: Evidence;
  private readonly evaluation: Evaluation;

  constructor(db: Db, frameworks: FrameworkRegistry, files: FileStore, opts: { evidenceQuotaBytes?: number } = {}) {
    this.access = new AccessGate(db);
    this.entries = new Entries(db, frameworks);
    const ctx: WorkspaceContext = {
      db,
      frameworks,
      files,
      access: this.access,
      entries: this.entries,
      evidenceQuotaBytes: opts.evidenceQuotaBytes ?? Number.POSITIVE_INFINITY,
    };
    this.evaluation = new Evaluation(ctx);
    this.cycles = new Cycles(ctx, this.evaluation);
    this.sharing = new Sharing(ctx);
    this.data = new MetricData(ctx);
    this.narratives = new Narratives(ctx);
    this.evidence = new Evidence(ctx);
  }

  // Arrow properties read the services when called, so they may be declared before the constructor runs.

  readonly collegeAccess: AccessGate["collegeAccess"] = (...args) => this.access.collegeAccess(...args);
  readonly cycleAccess: AccessGate["cycleAccess"] = (...args) => this.access.cycleAccess(...args);
  readonly auditLog: AccessGate["auditLog"] = (...args) => this.access.auditLog(...args);

  readonly listMembers: Sharing["listMembers"] = (...args) => this.sharing.listMembers(...args);
  readonly addMember: Sharing["addMember"] = (...args) => this.sharing.addMember(...args);
  readonly removeMember: Sharing["removeMember"] = (...args) => this.sharing.removeMember(...args);
  readonly listShares: Sharing["listShares"] = (...args) => this.sharing.listShares(...args);
  readonly shareReport: Sharing["shareReport"] = (...args) => this.sharing.shareReport(...args);
  readonly unshareReport: Sharing["unshareReport"] = (...args) => this.sharing.unshareReport(...args);
  readonly sharedWithMe: Sharing["sharedWithMe"] = (...args) => this.sharing.sharedWithMe(...args);

  readonly listCycles: Cycles["listCycles"] = (...args) => this.cycles.listCycles(...args);
  readonly createCycle: Cycles["createCycle"] = (...args) => this.cycles.createCycle(...args);
  readonly updateCycle: Cycles["updateCycle"] = (...args) => this.cycles.updateCycle(...args);
  readonly deleteCycle: Cycles["deleteCycle"] = (...args) => this.cycles.deleteCycle(...args);
  readonly carryForward: Cycles["carryForward"] = (...args) => this.cycles.carryForward(...args);
  readonly planSsrFromAqars: Cycles["planSsrFromAqars"] = (...args) => this.cycles.planSsrFromAqars(...args);
  readonly fillSsrFromAqars: Cycles["fillSsrFromAqars"] = (...args) => this.cycles.fillSsrFromAqars(...args);

  readonly getInputs: Entries["getInputs"] = (...args) => this.entries.getInputs(...args);
  readonly setInputs: MetricData["setInputs"] = (...args) => this.data.setInputs(...args);
  readonly rowsByMetric: MetricData["rowsByMetric"] = (...args) => this.data.rowsByMetric(...args);
  readonly importWorkbook: MetricData["importWorkbook"] = (...args) => this.data.importWorkbook(...args);
  readonly metricDetail: MetricData["metricDetail"] = (...args) => this.data.metricDetail(...args);
  readonly addRows: MetricData["addRows"] = (...args) => this.data.addRows(...args);
  readonly updateRow: MetricData["updateRow"] = (...args) => this.data.updateRow(...args);
  readonly deleteRow: MetricData["deleteRow"] = (...args) => this.data.deleteRow(...args);
  readonly importRows: MetricData["importRows"] = (...args) => this.data.importRows(...args);
  readonly assign: MetricData["assign"] = (...args) => this.data.assign(...args);

  readonly saveNarrative: Narratives["saveNarrative"] = (...args) => this.narratives.saveNarrative(...args);
  readonly narrativeVersions: Narratives["narrativeVersions"] = (...args) => this.narratives.narrativeVersions(...args);
  readonly narrativeVersion: Narratives["narrativeVersion"] = (...args) => this.narratives.narrativeVersion(...args);
  readonly restoreNarrativeVersion: Narratives["restoreNarrativeVersion"] = (...args) => this.narratives.restoreNarrativeVersion(...args);
  readonly previewNarrative: Narratives["previewNarrative"] = (...args) => this.narratives.previewNarrative(...args);

  readonly addEvidence: Evidence["addEvidence"] = (...args) => this.evidence.addEvidence(...args);
  readonly getEvidence: Evidence["getEvidence"] = (...args) => this.evidence.getEvidence(...args);
  readonly deleteEvidence: Evidence["deleteEvidence"] = (...args) => this.evidence.deleteEvidence(...args);

  readonly evaluateAll: Evaluation["evaluateAll"] = (...args) => this.evaluation.evaluateAll(...args);
  readonly cgpa: Evaluation["cgpa"] = (...args) => this.evaluation.cgpa(...args);
  readonly dashboard: Evaluation["dashboard"] = (...args) => this.evaluation.dashboard(...args);
  readonly reviewChecklist: Evaluation["reviewChecklist"] = (...args) => this.evaluation.reviewChecklist(...args);
  readonly trends: Evaluation["trends"] = (...args) => this.evaluation.trends(...args);
}
