// Fastify app: plugins, auth hook, error handling, then the /api/v1 route modules in routes/.
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { docsEnabled, originOf, type Config } from "./config.js";
import type { Db } from "./db/client.js";
import { registerApiDocs } from "./http/docs.js";
import { SESSION_COOKIE, cookieName } from "./http/helpers.js";
import type { FileStore } from "./infra/file-store.js";
import type { Mailer } from "./infra/mailer.js";
import { authRoutes } from "./routes/auth.js";
import { collectionLinkRoutes } from "./routes/collection-links.js";
import { collegeRoutes } from "./routes/colleges.js";
import { cycleRoutes } from "./routes/cycles.js";
import { exportRoutes } from "./routes/exports.js";
import { frameworkRoutes } from "./routes/frameworks.js";
import { metricRoutes } from "./routes/metrics.js";
import { searchRoutes } from "./routes/search.js";
import type { RouteDeps } from "./routes/shared.js";
import { sharingRoutes } from "./routes/sharing.js";
import { userForSession } from "./services/auth.js";
import { Collection } from "./services/collection.js";
import { Corpus } from "./services/corpus.js";
import { AppError, forbidden } from "./services/errors.js";
import type { FrameworkRegistry } from "./services/frameworks.js";
import { Workspace } from "./services/workspace.js";

export interface AppDeps {
  cfg: Config;
  db: Db;
  frameworks: FrameworkRegistry;
  files: FileStore;
  mailer: Mailer;
  /** The shared pino logger (infra/logger.ts), typed as Fastify sees it. */
  logger: FastifyBaseLogger;
}

const API_PREFIX = "/api/v1";
const ROUTE_MODULES = [
  authRoutes,
  frameworkRoutes,
  collegeRoutes,
  cycleRoutes,
  metricRoutes,
  collectionLinkRoutes,
  sharingRoutes,
  exportRoutes,
  searchRoutes,
];

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// A proxy's request id is reused so one id follows a request end to end; anything odd gets a new one.
const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_RE = /^[\w.-]{1,64}$/;
const STATIC_FILE_RE = /\.(js|mjs|css|map|html|png|jpe?g|gif|svg|ico|webp|webmanifest|json|txt|woff2?|ttf)$/i;
const HSTS_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * When the client is served from another origin (APP_URL), lets it call the API with the session
 * cookie (CORS with credentials). In every deployment, rejects state-changing requests from any
 * other origin: SameSite=Lax does not stop a sibling subdomain (same site) and SameSite=None stops
 * nothing. Browsers send Origin on every POST/PUT/PATCH/DELETE; when it is missing (very old
 * browsers), Sec-Fetch-Site still identifies a request made by another site. Clients that send
 * neither (curl, server-to-server) are not browsers and carry no ambient cookie, so they pass.
 */
async function registerCrossOrigin(app: FastifyInstance, cfg: Config): Promise<void> {
  const appOrigin = originOf(cfg.appUrl);
  const apiOrigin = originOf(cfg.publicUrl);
  const sameOrigin = appOrigin === apiOrigin;

  if (!sameOrigin) {
    await app.register(cors, {
      // A list, so only a matching Origin gets CORS headers (a plain string is sent to every caller).
      origin: [appOrigin],
      credentials: true,
      methods: ["GET", "HEAD", ...UNSAFE_METHODS],
      // Export downloads read the file name from Content-Disposition.
      exposedHeaders: ["Content-Disposition", REQUEST_ID_HEADER],
      maxAge: 600,
    });
  }
  app.addHook("onRequest", async (req) => {
    if (!UNSAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin) {
      if (origin !== appOrigin && origin !== apiOrigin) throw forbidden("Requests from this origin are not allowed");
      return;
    }
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site" || (site === "same-site" && sameOrigin)) throw forbidden("Requests from this origin are not allowed");
  });
}

/**
 * Security headers on every response. The CSP allows only this origin: the built client has no
 * inline scripts or styles (React's style props go through the CSSOM, which style-src does not
 * restrict), and the one data: URL is a CSS background image. HSTS and upgrade-insecure-requests
 * only make sense over HTTPS, and would break plain-http local development.
 */
async function registerSecurityHeaders(app: FastifyInstance, cfg: Config): Promise<void> {
  const https = cfg.publicUrl.startsWith("https://");
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    // Not includeSubDomains: a college's other subdomains may still be served over plain HTTP.
    strictTransportSecurity: https ? { maxAge: HSTS_MAX_AGE_S, includeSubDomains: false } : false,
    // Collection-link URLs carry a token, so no page ever sends its URL on as a referrer.
    referrerPolicy: { policy: "no-referrer" },
  });
}

/** Serves the built React app (client/dist), with index.html for client-side routes. */
async function serveClient(app: FastifyInstance, clientDist: string): Promise<void> {
  // Hashed assets never change, so browsers may cache them forever; index.html must always be
  // revalidated so a new build's asset names are picked up.
  await app.register(fastifyStatic, {
    root: clientDist,
    setHeaders: (res, path) =>
      res.header("Cache-Control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache"),
  });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0];
    if (path.startsWith("/api/")) return reply.status(404).send({ error: "not_found", message: "No such endpoint" });
    // A missing file (e.g. an asset from an older build) is a 404, never the HTML page. Only real
    // file types count: app routes such as /m/7.3.1 also end in ".1".
    if (path.startsWith("/assets/") || STATIC_FILE_RE.test(path)) return reply.status(404).send("Not found");
    return reply.header("Cache-Control", "no-cache").sendFile("index.html");
  });
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { cfg, db, frameworks, files, logger } = deps;
  const app = Fastify({
    // Its serializers keep cookies, bodies and URL tokens out of the logs (infra/logger.ts).
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID_RE.test(id) ? id : randomUUID();
    },
    bodyLimit: 2 * 1024 * 1024,
    // Only the configured proxies may set X-Forwarded-For (TRUST_PROXY); otherwise any client
    // could pick its own IP and step around the per-IP rate limits.
    // A hop count n trusts the n nearest proxies (what proxy-addr does for a number).
    trustProxy: typeof cfg.trustProxy === "number" ? ((hops: number) => (_addr: string, i: number) => i < hops)(cfg.trustProxy) : cfg.trustProxy,
  });
  const ws = new Workspace(db, frameworks, files, { evidenceQuotaBytes: cfg.evidenceQuotaBytes });
  const routeDeps: RouteDeps = {
    ...deps,
    ws,
    corpus: new Corpus(db),
    collection: new Collection(db, frameworks, ws),
    appBase: cfg.appUrl.replace(/\/$/, ""),
  };

  await app.register(cookie);
  await registerSecurityHeaders(app, cfg);
  await registerCrossOrigin(app, cfg);
  await app.register(multipart, { limits: { fileSize: cfg.maxUploadBytes, files: 1, fields: 10 } });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    // A security event: a burst of these is someone probing or flooding (alert on it in the logs).
    onExceeded: (req, key) => req.log.warn({ event: "rate_limit.exceeded", route: req.routeOptions.url, key }, "rate limit exceeded"),
  });

  // Returned on every response, so a user's error report can be matched to the log lines.
  app.addHook("onRequest", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  app.decorateRequest("user", null);
  const sessionCookie = cookieName(SESSION_COOKIE, cfg.secureCookies);
  app.addHook("onRequest", async (req) => {
    req.user = await userForSession(db, req.cookies[sessionCookie], cfg.sessionIdleDays);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? "error", message: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong" });
  });

  // Route schemas (http/docs.ts) only document the API; handlers validate with Zod, so Fastify's
  // own validation stays off whether or not the docs are served.
  app.setValidatorCompiler(() => () => true);
  // Docs are served only when turned on AND password-protected (API_DOCS_PASSWORD).
  if (docsEnabled(cfg)) await registerApiDocs(app, cfg);

  // Registered after the hooks and error handler above, so every route module inherits them.
  for (const routes of ROUTE_MODULES) await app.register(routes, { ...routeDeps, prefix: API_PREFIX });

  if (existsSync(cfg.clientDist)) await serveClient(app, cfg.clientDist);

  return app;
}
