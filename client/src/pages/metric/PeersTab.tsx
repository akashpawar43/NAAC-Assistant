import { useEffect, useState } from "react";
import { api, ApiError, qs, type Cycle } from "../../api";
import { Icon } from "../Icon";
import { EmptyState, Loading, Notice } from "../ui";
import { usePeerFilters } from "./usePeerFilters";

interface Peer {
  id: number;
  college: string;
  state: string;
  grade: string;
  citation: string;
  excerpt: string;
  response_text: string | null;
  criterion_gpa: number | null;
  source_url: string | null;
  tables: { page: number; columns: string[]; rows: string[][] }[];
}

/** Only http(s) links are rendered: a javascript: or data: URL in the reference data would run on click. */
function isWebUrl(u: string | null): u is string {
  if (!u) return false;
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

export function PeersTab({ cycle, metricId }: { cycle: Cycle; metricId: string }) {
  const { f, ui } = usePeerFilters(cycle);
  const [q, setQ] = useState("");
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setPeers(null);
    setErr(null);
    const t = setTimeout(
      () =>
        api
          .get<Peer[]>(`/api/v1/metrics/${metricId}/peer-examples${qs({ ...f, q, framework: cycle.framework_id })}`)
          .then(setPeers, (e) => setErr(e instanceof ApiError ? e.message : "Could not load examples")),
      250,
    );
    return () => clearTimeout(t);
  }, [metricId, f.state, f.type, f.min_grade, q]);
  return (
    <section>
      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" />
          <input placeholder="Words to look for, e.g. mentoring" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Words to look for" />
        </div>
        {ui}
      </div>
      <p className="small muted" style={{ marginBottom: 16 }}>
        Excerpts from public SSRs, ranked by the score the college got for this criterion. Use them to see the expected depth of an answer. Do not copy
        them.
      </p>
      {err && <Notice kind="error">{err}</Notice>}
      {peers === null && !err && <Loading label="Finding examples…" />}
      {peers?.length === 0 && (
        <div className="panel">
          <EmptyState icon="search" title="No matching excerpts">
            Try fewer filters. The corpus of accredited colleges' SSRs may not be loaded yet.
          </EmptyState>
        </div>
      )}
      {peers?.map((p) => (
        <article key={p.id} className="panel peer">
          <div className="peer-meta">
            <span className="strong">{p.college}</span>
            <span className="muted">{p.state}</span>
            <span className="tag accent">Grade {p.grade}</span>
            {p.criterion_gpa !== null && <span className="tag">Criterion score {p.criterion_gpa}</span>}
          </div>
          {p.response_text && (
            <div className="small">
              <span className="muted">Reported value:</span> {p.response_text}
            </div>
          )}
          <pre className="excerpt">{p.excerpt}</pre>
          {p.tables.map((t, i) => (
            <div key={i} className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {t.columns.map((c, j) => (
                      <th key={j}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="xsmall muted">
            Source: {p.citation}
            {isWebUrl(p.source_url) && (
              <>
                {" "}
                ·{" "}
                <a href={p.source_url} target="_blank" rel="noreferrer noopener">
                  NAAC link
                </a>{" "}
                (may expire)
              </>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
