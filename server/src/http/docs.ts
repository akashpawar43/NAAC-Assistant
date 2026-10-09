// OpenAPI (Swagger) documentation, generated from the same Zod schemas the handlers validate with.
//
// Route schemas here are for documentation only. Requests are still validated by `parse()` inside
// each handler, so validation errors keep the API's own format ({ error, message, details }).
import { createHash, timingSafeEqual } from "node:crypto";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifyRequest, FastifySchema } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { SESSION_COOKIE, cookieName } from "./helpers.js";

export const API_DOCS_PATH = "/api/docs";

interface RouteDoc {
  summary: string;
  description?: string;
  body?: z.ZodType;
  querystring?: z.ZodType;
  /** No session needed (sign-in, health, public collection links). */
  isPublic?: boolean;
  /** The route takes a multipart file upload in the field `file`. */
  upload?: { fields?: Record<string, string> };
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Coerced and transformed inputs have no exact JSON Schema; "any" keeps them documented loosely.
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return rest;
}

function uploadSchema(fields: Record<string, string> = {}): Record<string, unknown> {
  const extra = Object.fromEntries(Object.entries(fields).map(([k, description]) => [k, { type: "string", description }]));
  return {
    type: "object",
    required: ["file"],
    properties: { ...extra, file: { type: "string", format: "binary" } },
  };
}

/** Route options that document a route in the OpenAPI spec. */
export function docs(d: RouteDoc): { schema: FastifySchema } {
  const schema: FastifySchema = { summary: d.summary };
  if (d.description) schema.description = d.description;
  if (d.isPublic) schema.security = [];
  if (d.querystring) schema.querystring = jsonSchema(d.querystring);
  if (d.body) schema.body = jsonSchema(d.body);
  if (d.upload) {
    schema.consumes = ["multipart/form-data"];
    schema.body = uploadSchema(d.upload.fields);
  }
  return { schema };
}

/** Puts every route registered after this call in a plugin under one Swagger tag. */
export function tagRoutes(app: FastifyInstance, tag: string): void {
  app.addHook("onRoute", (route) => {
    route.schema = { ...route.schema, tags: [tag] };
  });
}

const TAGS = [
  { name: "Auth", description: "Health check, magic-link sign-in and the signed-in user" },
  { name: "Frameworks", description: "NAAC frameworks and their metric definitions" },
  { name: "Colleges", description: "A workspace's members and reports" },
  { name: "Reports", description: "One report (cycle): dashboard, settings, profile, insights, workbooks" },
  { name: "Metrics", description: "One metric in a report: rows, import, narrative, evidence" },
  { name: "Collection links", description: "Department links, submissions and the public collection pages" },
  { name: "Sharing", description: "Sharing a report with another person" },
  { name: "Exports", description: "Word, PDF, Excel and evidence ZIP exports" },
  { name: "Search", description: "Search, peer examples and benchmarks" },
];

const DOCS_REALM = 'Basic realm="NAAC Assistant API docs", charset="UTF-8"';
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10_000;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** Constant-time comparison (both sides hashed to the same length first). */
const same = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

export const isDocsPath = (url: string) => {
  const path = url.split("?")[0];
  return path === API_DOCS_PATH || path.startsWith(`${API_DOCS_PATH}/`);
};

/**
 * Whether a request reaches the docs. The router decodes the URL before matching (so
 * /api/%64ocs/json is served by the /api/docs/json route), so the check uses the route that
 * matched, plus the decoded path for anything the router answers without a route.
 */
function isDocsRequest(req: FastifyRequest): boolean {
  if (isDocsPath(req.routeOptions?.url ?? "")) return true;
  const raw = req.url.split("?")[0];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escapes: the router will not match a docs route with them either.
  }
  return isDocsPath(raw) || isDocsPath(decoded.replace(/\/{2,}/g, "/"));
}

/** The user and password from an `Authorization: Basic …` header, or null. */
export function basicCredentials(header: string | undefined): { user: string; pass: string } | null {
  const m = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header?.trim() ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * Puts HTTP Basic authentication in front of everything under /api/docs: the Swagger UI, its
 * static files and the OpenAPI JSON. Wrong credentials are counted per IP; after MAX_FAILURES in
 * FAILURE_WINDOW_MS that IP gets 429 (even with the right password) until the window ends, so
 * the password cannot be guessed at the speed of the global rate limit.
 */
function protectDocs(app: FastifyInstance, cfg: Config): void {
  const failures = new Map<string, { count: number; until: number }>();
  app.addHook("onRequest", async (req, reply) => {
    if (!isDocsRequest(req)) return;
    const now = Date.now();
    const seen = failures.get(req.ip);
    if (seen && seen.until <= now) failures.delete(req.ip);
    const f = failures.get(req.ip);
    if (f && f.count >= MAX_FAILURES) {
      reply.header("Retry-After", Math.ceil((f.until - now) / 1000));
      return reply.status(429).send({ error: "too_many_attempts", message: "Too many wrong passwords. Try again later." });
    }
    const c = basicCredentials(req.headers.authorization);
    // Both comparisons always run, so the time taken does not reveal which part was wrong.
    const userOk = c ? same(c.user, cfg.apiDocsUser) : false;
    const passOk = c ? same(c.pass, cfg.apiDocsPassword) : false;
    if (userOk && passOk) {
      // The spec and UI are for this person only: never cached by a shared proxy.
      reply.header("Cache-Control", "no-store");
      return;
    }
    if (c) {
      if (failures.size >= MAX_TRACKED_IPS) for (const [ip, v] of failures) if (v.until <= now) failures.delete(ip);
      const next = { count: (f?.count ?? 0) + 1, until: f?.until ?? now + FAILURE_WINDOW_MS };
      failures.set(req.ip, next);
      req.log.warn({ event: "docs.auth_failed", failures: next.count }, "API docs: wrong credentials");
    }
    return reply.status(401).header("WWW-Authenticate", DOCS_REALM).send({ error: "unauthorized", message: "API docs need a username and password" });
  });
}

/**
 * Collects route schemas into an OpenAPI 3.1 document and serves Swagger UI at /api/docs (the JSON
 * spec at /api/docs/json), behind HTTP Basic authentication. Must be registered before the routes
 * it documents, and only when a docs password is configured (config.docsEnabled).
 */
export async function registerApiDocs(app: FastifyInstance, cfg: Config): Promise<void> {
  if (!cfg.apiDocsPassword) throw new Error("registerApiDocs needs API_DOCS_PASSWORD");
  protectDocs(app, cfg);
  await app.register(swagger, {
    hideUntagged: true,
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "NAAC Assistant API",
        version: "1",
        description:
          "API for preparing NAAC AQAR and SSR reports. Sign in with `POST /auth/magic-link`, open the emailed link, " +
          `and the session cookie (\`${cookieName(SESSION_COOKIE, cfg.secureCookies)}\`) authenticates later requests. Errors look like ` +
          "`{ error, message, details? }`. Every response carries an `x-request-id` header that matches the server logs.",
      },
      servers: [{ url: cfg.publicUrl.replace(/\/$/, "") }],
      tags: TAGS,
      components: {
        securitySchemes: { session: { type: "apiKey", in: "cookie", name: cookieName(SESSION_COOKIE, cfg.secureCookies) } },
      },
      security: [{ session: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: API_DOCS_PATH });
}
