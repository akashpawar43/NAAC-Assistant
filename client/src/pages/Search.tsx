import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs, type Cycle } from "../api";
import { Icon } from "./Icon";
import { EmptyState, Notice, PageHeader } from "./ui";

interface Hit {
  id?: string;
  kind?: string;
  metric_id?: string;
  title?: string;
  snippet: string;
  source?: string;
  college?: string;
  state?: string;
  grade?: string;
  page_from?: number;
  page_to?: number;
}
interface Result {
  metric_id: string | null;
  results: { help?: Hit[]; manual?: Hit[]; peers?: Hit[]; mine?: Hit[] };
}

// ts_headline wraps matches in <b>…</b>; render only that tag, everything else as text.
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<b>.*?<\/b>)/g);
  return (
    <span>
      {parts.map((p, i) => (p.startsWith("<b>") ? <mark key={i}>{p.slice(3, -4)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

// Help titles start with the metric ID, which is already shown as a link.
const stripId = (title: string, id?: string) => (id && title.startsWith(id + " ") ? title.slice(id.length + 1) : title);

export function SearchPage({ cycle }: { cycle: Cycle }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setParams({ q: text });
    try {
      setRes(await api.get<Result>(`/api/v1/search${qs({ q: text, cycle_id: cycle.id })}`));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (params.get("q")) void run(params.get("q")!);
  }, []);

  const groups: { key: keyof Result["results"]; title: string }[] = [
    { key: "help", title: "Metric help and FAQ" },
    { key: "manual", title: "NAAC manual" },
    { key: "mine", title: "Your college's data" },
    { key: "peers", title: "Accredited colleges' SSRs" },
  ];
  const r = res?.results ?? {};
  const empty = res && groups.every((g) => !r[g.key]?.length);

  return (
    <main className="page">
      <PageHeader
        title="Search NAAC"
        description="One search over metric help, the FAQ, the NAAC manual, your college's data and accredited colleges' SSRs. Every result names its source."
      />
      <form
        className="inline"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <div className="search-field">
          <Icon name="search" />
          <input
            aria-label="Search"
            placeholder="A metric (3.3.1) or words (best practices, IQAC meetings)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ height: 40 }}
            autoFocus
          />
        </div>
        <button className="btn primary lg" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Search
        </button>
      </form>
      {res?.metric_id && /^\d\.\d+\.\d+$/.test(res.metric_id) && (
        <div style={{ marginTop: 16 }}>
          <Notice icon="chevronRight">
            Go to metric{" "}
            <Link to={`/c/${cycle.id}/m/${res.metric_id}`} className="mono">
              {res.metric_id}
            </Link>
          </Notice>
        </div>
      )}
      {!res && !busy && (
        <p className="small muted" style={{ marginTop: 12 }}>
          NAAC terms are expanded (IQAC, MoU, FDP, ICT …) and small typos are tolerated.
        </p>
      )}
      {empty && (
        <div className="panel" style={{ marginTop: 24 }}>
          <EmptyState icon="search" title="Nothing found">
            This search only looks in the sources listed above; it does not guess an answer. Try fewer or different words.
          </EmptyState>
        </div>
      )}
      <div className="stack-lg" style={{ marginTop: 32 }}>
        {groups.map((g) =>
          r[g.key]?.length ? (
            <section key={g.key}>
              <div className="section-header">
                <h2>{g.title}</h2>
                <span className="meta">{r[g.key]!.length} results</span>
              </div>
              <div className="panel flush">
                {r[g.key]!.map((h, i) => (
                  <div key={i} className="hit">
                    <div className="hit-title">
                      {h.metric_id && (
                        <Link to={`/c/${cycle.id}/m/${h.metric_id}`} className="metric-id">
                          {h.metric_id}
                        </Link>
                      )}
                      <span>{stripId(h.title ?? h.college ?? "", h.metric_id)}</span>
                    </div>
                    <div className="snippet">
                      <Snippet html={h.snippet ?? ""} />
                    </div>
                    <div className="source">
                      {g.key === "peers"
                        ? `${h.college}, ${h.state}, grade ${h.grade}, SSR pages ${h.page_from}-${h.page_to}`
                        : g.key === "mine"
                          ? `Your ${h.kind}`
                          : h.source}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null,
        )}
      </div>
    </main>
  );
}
