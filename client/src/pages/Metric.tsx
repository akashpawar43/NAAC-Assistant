import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiUrl, type Cycle } from "../api";
import { Icon } from "./Icon";
import { BenchmarkTab } from "./metric/BenchmarkTab";
import { DataTab } from "./metric/DataTab";
import { EvidenceTab } from "./metric/EvidenceTab";
import { PeersTab } from "./metric/PeersTab";
import { useMetric } from "./metric/useMetric";
import { Menu, Notice, PageError, PageHeader, PageLoading, Severity, StatusChip, Tabs, formatValue } from "./ui";

type Tab = "data" | "evidence" | "peers" | "benchmark";

export function MetricPage({ cycle }: { cycle: Cycle }) {
  const { metricId = "" } = useParams();
  const { detail: d, error, reload: load } = useMetric(cycle.id, metricId);
  const [tab, setTab] = useState<Tab>("data");

  useEffect(() => setTab("data"), [cycle.id, metricId]);

  if (error && !d) return <PageError message={error} onRetry={() => void load()} />;
  if (!d) return <PageLoading />;
  const m = d.metric;
  const issues = d.flags.filter((f) => f.rule !== "missing_evidence" && f.rule !== "no_data");
  const issueCount = d.missing.length + issues.length;
  const exportUrl = (f: string) => `/api/v1/cycles/${cycle.id}/export.${f}?metrics=${m.id}`;

  return (
    <main className="page">
      <PageHeader
        crumbs={
          <>
            <Link to={`/c/${cycle.id}`}>Dashboard</Link>
            <span className="sep">/</span>
            <span>Criterion {m.criterion}</span>
            <span className="sep">/</span>
            <span className="truncate" style={{ maxWidth: 420 }}>
              {m.key_indicator} {m.key_indicator_title}
            </span>
          </>
        }
        eyebrow={<span className="metric-id">{m.id}</span>}
        title={m.title}
        actions={
          <Menu label="Export metric" icon="download">
            <a href={apiUrl(exportUrl("docx"))}>
              <Icon name="file" />
              Word (.docx)
            </a>
            <a href={apiUrl(exportUrl("pdf"))}>
              <Icon name="file" />
              PDF
            </a>
            <a href={apiUrl(exportUrl("xlsx"))}>
              <Icon name="workbook" />
              Excel (.xlsx)
            </a>
          </Menu>
        }
      />
      <div className="metric-head">
        <div className="stack">
          <p className="prose">{m.explain}</p>
          {m.verified === false && <Notice kind="warn">Formula is an indicative reading of the manual; verify before relying on it.</Notice>}
          {issueCount > 0 && (
            <details className="panel" open={d.status !== "complete"}>
              <summary>
                <Icon name="chevronRight" className="chev" />
                What is missing
                <span className="tag">{issueCount}</span>
              </summary>
              <ul className="missing-list">
                {d.missing.map((x) => (
                  <li key={x}>
                    <Icon name="circle" size={14} />
                    <span>{x}</span>
                  </li>
                ))}
                {issues.map((f) => (
                  <li key={f.rule}>
                    <Severity s={f.severity} />
                    <span>
                      {f.message} {f.detail && <span className="muted">({f.detail})</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <aside className="valuebox" aria-label="Value">
          <div className="row-between">
            <span className="stat-label">{m.type === "qualitative" || m.type === "external" ? "Status" : "Value"}</span>
            <StatusChip status={d.status} />
          </div>
          {m.type !== "qualitative" && m.type !== "external" && (
            <>
              <div className="stat-value">{formatValue(d.computed.value, m.unit)}</div>
              {d.computed.reason && <p className="small warn">{d.computed.reason}</p>}
              {(d.computed.points !== null || d.previous_value !== null) && (
                <div className="facts">
                  {d.computed.points !== null && (
                    <div className="row-between">
                      <span>Indicative points</span>
                      <span className="num strong">{d.computed.points} / 4</span>
                    </div>
                  )}
                  {d.previous_value !== null && (
                    <div className="row-between">
                      <span>Previous cycle</span>
                      <span className="num">{formatValue(d.previous_value, m.unit)}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "data", label: m.type === "qualitative" ? "Narrative" : "Data" },
          { id: "evidence", label: "Evidence", count: d.evidence.length },
          { id: "peers", label: "How others wrote it" },
          ...(m.type === "quantitative" ? [{ id: "benchmark" as Tab, label: "Benchmark" }] : []),
        ]}
      />
      {tab === "data" && <DataTab cycle={cycle} d={d} onChange={load} />}
      {tab === "evidence" && <EvidenceTab cycle={cycle} d={d} onChange={load} />}
      {tab === "peers" && <PeersTab cycle={cycle} metricId={m.id} />}
      {tab === "benchmark" && <BenchmarkTab cycle={cycle} metricId={m.id} unit={m.unit} />}
    </main>
  );
}
