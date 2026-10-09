// Search across help, manual and reference material, plus peer examples and benchmarks for a metric.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { docs, tagRoutes } from "../http/docs.js";
import { parse, requireUser } from "../http/helpers.js";
import { search, type SearchScope } from "../services/corpus.js";
import type { RouteDeps } from "./shared.js";

const PeerQuery = z.object({
  type: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  min_grade: z.string().max(4).optional(),
  q: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  cycle_id: z.string().optional(),
  framework: z.string().max(64).optional(),
});

const SearchQuery = z.object({
  q: z.string().min(1).max(300),
  scope: z.string().optional().describe("Comma-separated: help, manual, peers, mine (default: all)"),
  cycle_id: z.string().optional().describe("Needed for the `mine` scope"),
});

export const searchRoutes: FastifyPluginAsync<RouteDeps> = async (app, { db, ws, corpus }) => {
  tagRoutes(app, "Search");

  app.get<{ Params: { metricId: string } }>(
    "/metrics/:metricId/peer-examples",
    { ...docs({ summary: "How accredited institutions answered this metric", querystring: PeerQuery }), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      requireUser(req);
      return corpus.peerExamples(req.params.metricId, parse(PeerQuery, req.query));
    },
  );

  app.get<{ Params: { metricId: string } }>(
    "/metrics/:metricId/benchmark",
    docs({ summary: "Distribution of reported values, and where yours sits", querystring: PeerQuery }),
    async (req) => {
      const u = requireUser(req);
      const q = parse(PeerQuery, req.query);
      let yours: number | null = null;
      if (q.cycle_id) {
        const a = await ws.cycleAccess(u.id, q.cycle_id);
        const r = await db.query<{ computed_value: number | null }>(
          "SELECT computed_value FROM metric_entry WHERE cycle_id = $1 AND metric_id = $2 AND college_id = $3",
          [a.cycle.id, req.params.metricId, a.collegeId],
        );
        yours = r.rows[0]?.computed_value ?? null;
      }
      return corpus.benchmark(req.params.metricId, q, yours);
    },
  );

  app.get("/corpus/filters", docs({ summary: "Filter values (states, institution types) for reference data" }), async (req) => {
    requireUser(req);
    return corpus.filters();
  });

  app.get("/corpus/stats", docs({ summary: "Counts for the loaded reference data" }), async (req) => {
    requireUser(req);
    return corpus.stats();
  });

  app.get("/search", { ...docs({ summary: "Search help, manual, reference material and your data", querystring: SearchQuery }), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const u = requireUser(req);
    const q = parse(SearchQuery, req.query);
    const all: SearchScope[] = ["help", "manual", "peers", "mine"];
    const scopes = (q.scope ? q.scope.split(",") : all).filter((s): s is SearchScope => all.includes(s as SearchScope));
    let mine: { collegeId: string; cycleId: string } | undefined;
    if (q.cycle_id && scopes.includes("mine")) {
      const a = await ws.cycleAccess(u.id, q.cycle_id);
      mine = { collegeId: a.collegeId, cycleId: a.cycle.id };
    }
    return search(db, q.q, scopes, mine);
  });
};
