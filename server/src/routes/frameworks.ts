// NAAC frameworks available for new reports, and what the screens need of one framework.
import type { FastifyPluginAsync } from "fastify";
import { docs, tagRoutes } from "../http/docs.js";
import { requireUser } from "../http/helpers.js";
import { clientFramework } from "../http/views.js";
import type { RouteDeps } from "./shared.js";

export const frameworkRoutes: FastifyPluginAsync<RouteDeps> = async (app, { frameworks }) => {
  tagRoutes(app, "Frameworks");

  app.get("/frameworks", docs({ summary: "List frameworks" }), async (req) => {
    requireUser(req);
    return frameworks.list().map((f) => ({
      id: f.id,
      name: f.name,
      version: f.version,
      applies_to: f.applies_to,
      verified: f.verified,
      institution_types: f.institution_types,
      // Records can be exported in NAAC's data-template workbook layout.
      naac_template: f.metrics.some((m) => m.naac_sheet),
    }));
  });

  app.get<{ Params: { fw: string } }>("/frameworks/:fw/metrics", docs({ summary: "A framework's extended-profile inputs and metrics" }), async (req) => {
    requireUser(req);
    return clientFramework(frameworks.get(req.params.fw));
  });
};
