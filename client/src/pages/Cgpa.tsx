// Indicative CGPA: a range, never a single number, with the reason for every open part.
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { type Cycle } from "../api";
import { Icon } from "./Icon";
import { EmptyState, Notice, PageError, PageHeader, PageLoading, useApi } from "./ui";

type Basis = "calculated" | "no_data" | "no_benchmark" | "not_calculable" | "peer_review" | "external";

interface KeyIndicator {
  id: string;
  title: string;
  weight: number;
  min: number;
  max: number;
  metrics: { metric_id: string; min: number; max: number; basis: Basis }[];
}
interface Estimate {
  available: boolean;
  min: number;
  max: number;
  grade_min: string;
  grade_max: string;
  calculated_share: number;
  criteria: { id: string; title: string; weight: number; min: number; max: number; key_indicators: KeyIndicator[] }[];
}

const BASIS_TEXT: Record<Basis, string> = {
  calculated: "from your data",
  no_data: "no data yet (scores 0)",
  no_benchmark: "count without a published band (0–4)",
  not_calculable: "value missing an input (0–4)",
  peer_review: "narrative, scored by the peer team (0–4)",
  external: "scored by NAAC directly (0–4)",
};

/** Lower CGPA bound of each grade; drawn as faint ticks so the bar reads against the scale. */
const GRADE_TICKS = [
  { grade: "B", at: 2.01 },
  { grade: "B+", at: 2.51 },
  { grade: "B++", at: 2.76 },
  { grade: "A", at: 3.01 },
  { grade: "A+", at: 3.26 },
  { grade: "A++", at: 3.51 },
];

const fmt = (v: number) => v.toFixed(2);
export const cgpaText = (e: { min: number; max: number }) => (e.min === e.max ? fmt(e.min) : `${fmt(e.min)} – ${fmt(e.max)}`);
export const gradeText = (e: { grade_min: string; grade_max: string }) => (e.grade_min === e.grade_max ? e.grade_min : `${e.grade_min} to ${e.grade_max}`);

/** Floating bar from min to max on a 0–4 scale; a dot when the value is fixed. */
function RangeBar({ min, max, label, ticks = false, width = 240 }: { min: number; max: number; label: string; ticks?: boolean; width?: number }) {
  const [hover, setHover] = useState(false);
  const W = width;
  const H = ticks ? 30 : 18;
  const x = (v: number) => 4 + (v / 4) * (W - 8);
  const y = 9;
  return (
    <span className="range-bar" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <svg width={W} height={H} role="img" aria-label={`${label}: ${cgpaText({ min, max })} of 4`}>
        <line x1={x(0)} x2={x(4)} y1={y} y2={y} stroke="var(--grid)" strokeWidth={2} />
        {ticks &&
          GRADE_TICKS.map((t) => (
            <g key={t.grade}>
              <line x1={x(t.at)} x2={x(t.at)} y1={2} y2={16} stroke="var(--grid)" strokeWidth={1} />
              <text x={x(t.at)} y={28} fontSize={9} textAnchor="middle" fill="var(--text-muted)">
                {t.grade}
              </text>
            </g>
          ))}
        {max - min < 0.02 ? (
          <circle cx={x(min)} cy={y} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
        ) : (
          <rect x={x(min)} y={y - 5} width={Math.max(x(max) - x(min), 2)} height={10} rx={4} fill="var(--series-1)" />
        )}
      </svg>
      {hover && (
        <span className="tooltip" role="tooltip">
          {label}: {cgpaText({ min, max })} of 4
        </span>
      )}
    </span>
  );
}


/** Dashboard summary cell: the range, the likely grade and how much of it rests on the college's data. */
export function CgpaStat({ cycle, est }: { cycle: Cycle; est: Pick<Estimate, "available" | "min" | "max" | "grade_min" | "grade_max" | "calculated_share"> }) {
  if (!est.available) return null;
  return (
    <div className="stat">
      <div className="stat-label">Estimated CGPA · indicative</div>
      <div className="stat-value">
        {cgpaText(est)}
        <span className="unit">of 4</span>
      </div>
      <div className="stat-meta">
        Likely grade <span className="strong">{gradeText(est)}</span> · {Math.round(est.calculated_share * 100)}% of the weight from your data
      </div>
      <div className="stat-meta">
        <Link to={`/c/${cycle.id}/cgpa`}>See how it is worked out</Link>
      </div>
    </div>
  );
}

export function CgpaPage({ cycle }: { cycle: Cycle }) {
  const { data: e, error, reload } = useApi<Estimate>(`/api/v1/cycles/${cycle.id}/cgpa`);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <PageError message={error} onRetry={reload} />;
  if (!e) return <PageLoading />;
  if (!e.available)
    return (
      <main className="page narrow">
        <PageHeader title="Estimated CGPA" />
        <div className="panel">
          <EmptyState icon="gauge" title="No estimate for this framework">
            This framework has no key-indicator weights yet, so no estimate is possible.
          </EmptyState>
        </div>
      </main>
    );

  return (
    <main className="page">
      <PageHeader
        title="Estimated CGPA"
        description="An indicative range, worked out from the key-indicator weights and the values calculated from your data."
      />
      <section className="panel">
        <div className="row-between" style={{ alignItems: "flex-end" }}>
          <div>
            <div className="stat-label">Overall range</div>
            <div className="hero-figure">{cgpaText(e)}</div>
            <div className="secondary" style={{ marginTop: 4 }}>
              Likely grade <span className="strong">{gradeText(e)}</span> · {Math.round(e.calculated_share * 100)}% of the weight comes from values
              calculated from your data
            </div>
          </div>
        </div>
        <div style={{ marginTop: 24, overflowX: "auto" }}>
          <RangeBar min={e.min} max={e.max} label="Overall" ticks width={640} />
        </div>
        <div style={{ marginTop: 20 }}>
          <Notice>
            Indicative only. Key-indicator weights come from a real NAAC grade sheet for an affiliated college (2024); NAAC does not publish weights for
            individual metrics, so metrics count equally within a key indicator. Narratives, the student survey and counts without a published band
            cannot be estimated: the low end assumes they score 0, the high end 4. NAAC's scoring is moving to binary accreditation, so the grade scale
            may change.
          </Notice>
        </div>
      </section>

      <section className="section" style={{ marginTop: 32 }}>
        <div className="section-header">
          <h2>By criterion</h2>
          <span className="meta">Open a criterion to see its key indicators and metrics</span>
        </div>
        <div className="panel flush">
          <div className="scroll">
            <table className="list mid cgpa-table">
              <thead>
                <tr>
                  <th>Criterion</th>
                  <th className="num">Weight</th>
                  <th className="num">Range (0–4)</th>
                  <th className="hide-sm">
                    <span className="sr-only">Range bar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.criteria.map((c) => (
                  <Fragment key={c.id}>
                    <tr>
                      <td>
                        <button className="cgpa-toggle" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                          <Icon name="chevronRight" />
                          <span>
                            <span className="muted">{c.id}.</span> {c.title}
                          </span>
                        </button>
                      </td>
                      <td className="num secondary">{c.weight}</td>
                      <td className="num">{cgpaText(c)}</td>
                      <td className="hide-sm">
                        <RangeBar min={c.min} max={c.max} label={`Criterion ${c.id}`} />
                      </td>
                    </tr>
                    {open === c.id &&
                      c.key_indicators.map((k) => (
                        <tr key={k.id} className="sub">
                          <td style={{ verticalAlign: "top" }}>
                            <div>
                              <span className="mono muted">{k.id}</span> {k.title}
                            </div>
                            <ul className="small muted basis">
                              {k.metrics.map((m) => (
                                <li key={m.metric_id}>
                                  <Link to={`/c/${cycle.id}/m/${m.metric_id}`} className="mono">
                                    {m.metric_id}
                                  </Link>
                                  : {m.min === m.max ? `${m.min} points, ` : ""}
                                  {BASIS_TEXT[m.basis]}
                                </li>
                              ))}
                            </ul>
                          </td>
                          <td className="num secondary">{k.weight}</td>
                          <td className="num">{cgpaText(k)}</td>
                          <td className="hide-sm">
                            <RangeBar min={k.min} max={k.max} label={`Key indicator ${k.id}`} />
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}
