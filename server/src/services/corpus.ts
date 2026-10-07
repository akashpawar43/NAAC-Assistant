// Read-only queries over the shared NAAC corpus: peer examples, benchmarks, search.
import type { Db } from "../db/client.js";
import { parseQuery } from "../domain/search-query.js";
import { badRequest } from "./errors.js";

export const PEER_MIN_CONFIDENCE = 0.7;
const GRADE_RANK: Record<string, number> = { "A++": 8, "A+": 7, A: 6, "B++": 5, "B+": 4, B: 3, C: 2, D: 1 };
const METRIC_RE = /^[1-7]\.\d{1,2}\.\d{1,2}$/;

export interface PeerFilter {
  type?: string;
  state?: string;
  min_grade?: string;
  q?: string;
  limit?: number;
  /** The report's framework: match the same question in any framework, not just the bare ID. */
  framework?: string;
}

/**
 * SQL condition selecting chunks that answer the metric's question. With a framework, that is
 * the metric itself plus its equivalents in other frameworks (IDs differ across frameworks);
 * without one, chunks with the same ID. The metric ID must be parameter $1.
 */
function metricScope(params: unknown[], framework?: string): string {
  if (!framework) return "ch.metric_id = $1";
  params.push(framework);
  const fw = `$${params.length}`;
  return `(ch.framework, ch.metric_id) IN (
      SELECT ${fw}::text, $1::text
      UNION SELECT b_framework, b_metric FROM metric_equivalence WHERE a_framework = ${fw} AND a_metric = $1
      UNION SELECT a_framework, a_metric FROM metric_equivalence WHERE b_framework = ${fw} AND b_metric = $1)`;
}

function gradeRank(g?: string): number {
  if (!g) return 0;
  const r = GRADE_RANK[g.toUpperCase()];
  if (r === undefined) throw badRequest(`Unknown grade ${g}`);
  return r;
}

export class Corpus {
  constructor(private readonly db: Db) {}

  /**
   * Best SSR excerpts for a metric. Ranking: score that college got for the metric's criterion
   * (from its grade sheet), then key-indicator score, then CGPA. Only high-confidence segments.
   */
  async peerExamples(metricId: string, f: PeerFilter) {
    if (!METRIC_RE.test(metricId)) throw badRequest("metric id must look like 3.3.1");
    const [crit, ki] = [metricId.split(".")[0], metricId.split(".").slice(0, 2).join(".")];
    const params: unknown[] = [metricId, PEER_MIN_CONFIDENCE, gradeRank(f.min_grade), crit, ki];
    const scope = metricScope(params, f.framework);
    let where = "";
    if (f.type) {
      params.push(f.type);
      where += ` AND nc.institution_type = $${params.length}`;
    }
    if (f.state) {
      params.push(f.state);
      where += ` AND lower(nc.state) = lower($${params.length})`;
    }
    let rankExpr = "0";
    const pq = f.q ? parseQuery(f.q) : null;
    if (pq?.tsquery) {
      params.push(pq.tsquery);
      where += ` AND ch.tsv @@ to_tsquery('english', $${params.length})`;
      rankExpr = `ts_rank(ch.tsv, to_tsquery('english', $${params.length}))`;
    }
    params.push(Math.min(f.limit ?? 5, 20));
    const rows = (
      await this.db.query(
        `SELECT ch.id, ch.metric_id, ch.source_metric_id, ch.title, ch.page_from, ch.page_to, left(ch.text, 4000) AS excerpt,
                ch.response_value, ch.response_text, ch.confidence,
                nc.name AS college, nc.state, nc.institution_type, d.grade, to_char(d.iiqa_date, 'YYYY') AS ssr_year, d.source_url,
                gs.cgpa, cs.gpa AS criterion_gpa, ks.gpa AS ki_gpa,
                ${rankExpr} AS text_rank
         FROM ssr_chunk ch
         JOIN ssr_doc d ON d.sha256 = ch.doc_sha
         JOIN naac_college nc ON nc.key = d.college_key
         LEFT JOIN grade_sheet gs ON gs.assessment_id = d.assessment_id
         LEFT JOIN criterion_score cs ON cs.assessment_id = d.assessment_id AND cs.criterion = $4
         LEFT JOIN ki_score ks ON ks.assessment_id = d.assessment_id AND ks.ki_id = $5
         WHERE ${scope} AND ch.confidence >= $2 AND d.is_latest AND d.grade_rank >= $3 ${where}
         ORDER BY ${pq?.tsquery ? "text_rank DESC," : ""} cs.gpa DESC NULLS LAST, ks.gpa DESC NULLS LAST, gs.cgpa DESC NULLS LAST, d.grade_rank DESC, ch.confidence DESC
         LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const tables = rows.length
      ? (
          await this.db.query<{ chunk_id: number; page_no: number; columns: string[]; rows: string[][] }>(
            `SELECT ch.id AS chunk_id, t.page_no, t.columns, t.rows FROM ssr_table t
             JOIN ssr_chunk ch ON ch.doc_sha = t.doc_sha AND t.metric_id = ch.metric_id
             WHERE ch.id = ANY($1::bigint[]) ORDER BY t.page_no LIMIT 50`,
            [rows.map((r) => r.id)],
          )
        ).rows
      : [];
    return rows.map((r) => ({
      ...r,
      tables: tables.filter((t) => t.chunk_id === r.id).map((t) => ({ page: t.page_no, columns: t.columns, rows: t.rows.slice(0, 15) })),
      citation: `${r.college} (${r.state}), SSR${r.ssr_year ? ` ${r.ssr_year}` : ""}, pages ${r.page_from}-${r.page_to}${r.source_metric_id ? `, numbered ${r.source_metric_id} in that SSR` : ""}`,
    }));
  }

  /** Distribution of the value colleges reported for a metric ("Response:" in their SSR). */
  async benchmark(metricId: string, f: PeerFilter, yours?: number | null) {
    if (!METRIC_RE.test(metricId)) throw badRequest("metric id must look like 3.3.1");
    const params: unknown[] = [metricId, PEER_MIN_CONFIDENCE, gradeRank(f.min_grade)];
    const scope = metricScope(params, f.framework);
    let where = "";
    if (f.type) {
      params.push(f.type);
      where += ` AND nc.institution_type = $${params.length}`;
    }
    if (f.state) {
      params.push(f.state);
      where += ` AND lower(nc.state) = lower($${params.length})`;
    }
    const r = (
      await this.db.query<{ n: number; p25: number | null; median: number | null; p75: number | null; p90: number | null }>(
        `SELECT count(*)::int AS n,
                percentile_cont(0.25) WITHIN GROUP (ORDER BY ch.response_value) AS p25,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY ch.response_value) AS median,
                percentile_cont(0.75) WITHIN GROUP (ORDER BY ch.response_value) AS p75,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY ch.response_value) AS p90
         FROM ssr_chunk ch JOIN ssr_doc d ON d.sha256 = ch.doc_sha JOIN naac_college nc ON nc.key = d.college_key
         WHERE ${scope} AND ch.confidence >= $2 AND ch.response_value IS NOT NULL AND d.is_latest AND d.grade_rank >= $3 ${where}`,
        params,
      )
    ).rows[0];
    let percentile: number | null = null;
    if (yours !== undefined && yours !== null && r.n > 0) {
      params.push(yours);
      const below = (
        await this.db.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM ssr_chunk ch JOIN ssr_doc d ON d.sha256 = ch.doc_sha JOIN naac_college nc ON nc.key = d.college_key
           WHERE ${scope} AND ch.confidence >= $2 AND ch.response_value IS NOT NULL AND d.is_latest AND d.grade_rank >= $3 ${where}
             AND ch.response_value < $${params.length}`,
          params,
        )
      ).rows[0].c;
      percentile = Math.round((below / r.n) * 100);
    }
    const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
    return {
      metric_id: metricId,
      sample_size: r.n,
      p25: round(r.p25),
      median: round(r.median),
      p75: round(r.p75),
      p90: round(r.p90),
      yours: yours ?? null,
      your_percentile: percentile,
      note: "Values are what colleges reported in their SSRs (all years, framework versions may differ). Indicative only.",
    };
  }

  async filters() {
    const [states, types] = await Promise.all([
      this.db.query<{ state: string }>("SELECT DISTINCT state FROM naac_college WHERE state IS NOT NULL AND state <> '' ORDER BY state"),
      this.db.query<{ institution_type: string }>("SELECT DISTINCT institution_type FROM naac_college WHERE institution_type IS NOT NULL ORDER BY institution_type"),
    ]);
    return { states: states.rows.map((r) => r.state), types: types.rows.map((r) => r.institution_type), grades: Object.keys(GRADE_RANK) };
  }

  async stats() {
    return (
      await this.db.query(
        `SELECT (SELECT count(*)::int FROM naac_college) AS colleges, (SELECT count(*)::int FROM ssr_doc WHERE kind = 'ssr') AS ssrs,
                (SELECT count(*)::int FROM ssr_chunk WHERE confidence >= $1) AS peer_chunks, (SELECT count(*)::int FROM grade_sheet) AS grade_sheets`,
        [PEER_MIN_CONFIDENCE],
      )
    ).rows[0];
  }
}

export type SearchScope = "help" | "manual" | "peers" | "mine";

/**
 * "Search NAAC": one box over help (explainers + FAQ), manual sections, peer SSR excerpts and
 * the college's own rows/narratives. Results are grouped by source and always carry a citation.
 */
export async function search(db: Db, q: string, scopes: SearchScope[], mine?: { collegeId: string; cycleId: string }) {
  const pq = parseQuery(q);
  const out: Record<string, unknown[]> = {};
  const metricPrefix = pq.metricId ? pq.metricId + "%" : null;

  if (scopes.includes("help") || scopes.includes("manual")) {
    const kinds = [...(scopes.includes("help") ? ["explainer", "faq"] : []), ...(scopes.includes("manual") ? ["manual"] : [])];
    const params: unknown[] = [kinds];
    const conds: string[] = [];
    let rank = "0";
    if (pq.tsquery) {
      params.push(pq.tsquery);
      conds.push(`tsv @@ to_tsquery('english', $${params.length})`);
      rank = `ts_rank(tsv, to_tsquery('english', $${params.length}))`;
    }
    if (metricPrefix) {
      params.push(metricPrefix);
      conds.push(`metric_id LIKE $${params.length}`);
      // An exact metric ID beats any text match.
      rank = `(CASE WHEN metric_id LIKE $${params.length} THEN 10 ELSE 0 END) + ${rank}`;
    }
    if (conds.length) {
      const rows = (
        await db.query(
          `SELECT id, kind, metric_id, title, ts_headline('english', body, ${pq.tsquery ? `to_tsquery('english', $2)` : "plainto_tsquery('english', '')"}, 'MaxFragments=2, MinWords=8, MaxWords=30') AS snippet, source, ${rank} AS rank
           FROM help_article WHERE kind = ANY($1::text[]) AND (${conds.join(" OR ")}) ORDER BY rank DESC, metric_id LIMIT 20`,
          params,
        )
      ).rows;
      out.help = rows.filter((r) => r.kind !== "manual");
      out.manual = rows.filter((r) => r.kind === "manual");
    }
    // Typo tolerance: when nothing matched, fall back to trigram similarity on titles.
    if (!out.help?.length && !out.manual?.length && pq.terms.length) {
      out.help = (
        await db.query(
          `SELECT id, kind, metric_id, title, left(body, 200) AS snippet, source, similarity(title, $2) AS rank
           FROM help_article WHERE kind = ANY($1::text[]) AND similarity(title, $2) > 0.15 ORDER BY rank DESC LIMIT 10`,
          [kinds, pq.terms.join(" ")],
        )
      ).rows;
    }
  }

  if (scopes.includes("peers") && (pq.tsquery || metricPrefix)) {
    const params: unknown[] = [PEER_MIN_CONFIDENCE];
    const conds: string[] = ["ch.confidence >= $1", "d.is_latest"];
    let rank = "0";
    if (pq.tsquery) {
      params.push(pq.tsquery);
      conds.push(`ch.tsv @@ to_tsquery('english', $${params.length})`);
      rank = `ts_rank(ch.tsv, to_tsquery('english', $${params.length}))`;
    }
    if (metricPrefix) {
      params.push(metricPrefix);
      conds.push(`ch.metric_id LIKE $${params.length}`);
    }
    out.peers = (
      await db.query(
        `SELECT ch.id, ch.metric_id, ch.title, ch.page_from, ch.page_to, nc.name AS college, nc.state, d.grade, d.source_url,
                ${pq.tsquery ? `ts_headline('english', left(ch.text, 20000), to_tsquery('english', $2), 'MaxFragments=2, MinWords=8, MaxWords=35')` : "left(ch.text, 300)"} AS snippet,
                ${rank} AS rank
         FROM ssr_chunk ch JOIN ssr_doc d ON d.sha256 = ch.doc_sha JOIN naac_college nc ON nc.key = d.college_key
         WHERE ${conds.join(" AND ")}
         ORDER BY rank DESC, d.grade_rank DESC LIMIT 15`,
        params,
      )
    ).rows;
  }

  if (scopes.includes("mine") && mine && (pq.tsquery || metricPrefix)) {
    const params: unknown[] = [mine.collegeId, mine.cycleId];
    let cond = "";
    if (pq.tsquery) {
      params.push(pq.tsquery);
      cond = `to_tsvector('english', src.text) @@ to_tsquery('english', $${params.length})`;
    }
    if (metricPrefix) {
      params.push(metricPrefix);
      cond = cond ? `(${cond} OR src.metric_id LIKE $${params.length})` : `src.metric_id LIKE $${params.length}`;
    }
    out.mine = (
      await db.query(
        `SELECT src.metric_id, src.kind, left(src.text, 300) AS snippet FROM (
           SELECT e.metric_id, 'row' AS kind, r.data::text AS text FROM metric_row r JOIN metric_entry e ON e.id = r.entry_id
             WHERE r.college_id = $1 AND e.cycle_id = $2
           UNION ALL
           SELECT e.metric_id, 'narrative' AS kind, n.text FROM narrative_field n JOIN metric_entry e ON e.id = n.entry_id
             WHERE n.college_id = $1 AND e.cycle_id = $2
         ) src WHERE ${cond} LIMIT 20`,
        params,
      )
    ).rows;
  }
  return { query: q, metric_id: pq.metricId ?? null, results: out };
}
