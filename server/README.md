# NAAC Assistant — Server

The API behind NAAC Assistant. A college's IQAC team uses it to collect AQAR and SSR data
all year, one metric at a time. The server stores the data, checks it, calculates metric values,
estimates the CGPA range, and exports reports in NAAC's formats. In a single-container deployment,
it also serves the built [client](../client/README.md).

**The app uses.** Calculations are formulas written as data, narratives are templates filled
from structured fields, search is PostgreSQL full-text search, and the review checklist is a set
of rules.

## Features

| Area | What the API provides |
|---|---|
| Accounts | Passwordless sign-in with magic links sent by email. Each user gets a private workspace. Roles: `iqac_admin`, `dept_editor`, `viewer`. |
| Reports | AQAR (one year) or SSR (five years) reports, each tied to a NAAC framework. Rename, edit or delete. Carry forward narratives, answers and inputs from an earlier report. |
| Extended profile | Base numbers for each year (students, teachers, expenditure, ...) that formulas use. |
| Metric data | Row-level data entry checked by validation rules (types, academic years, duplicates). Excel templates, and imports that check every row before saving anything. |
| Calculation | A safe formula engine (`src/domain/formula.ts`). Formulas are JSON trees taken from the framework YAML, checked when loaded, and never passed to `eval`. Missing inputs give "no value" plus the reason, never a wrong number. |
| Narratives | Guided fields in NAAC's format, rendered with Nunjucks. Word-limit checks, autosave, and a version history with restore. |
| Data workbook | A single `.xlsx` with every data metric, for download and upload. Uploads save all-or-nothing, in Replace or Add mode. Also supports NAAC's official data-template layout (2023 affiliated framework). |
| SSR from AQARs | Fills an SSR from the same college's AQARs. It never overwrites, shows a preview first, and running it twice adds nothing. |
| Sharing | Share one report by email as editor or viewer. |
| Collection links | Public links, no account needed, where a department fills in one metric. Tokens are stored only as hashes, links expire, and submissions wait for review. Rate limits apply. |
| Estimated CGPA | An indicative range broken down by criterion and key indicator, on NAAC's seven-point scale. |
| Trends | Year-over-year change per metric across a college's AQARs. Drops of 10% or more are flagged. |
| Evidence | File uploads per metric (PDF, JPG, PNG, XLSX, DOCX; up to 10 MB). Missing required documents are flagged. |
| Review checklist | Rule-based checks: no data, missing evidence, missing years, low score band, drop compared with the previous cycle, narrative length. |
| Search | One search across metric explainers, the FAQ, manual sections, reference material and the college's own data. Understands NAAC synonyms and tolerates typos. |
| Peer examples and benchmarks | How accredited institutions answered a metric, and where your value sits (p25, median, p75, p90). Only available once the optional reference dataset is loaded. |
| Export | Word (.docx), PDF, Excel and an evidence ZIP, all built from one report model so they always match. |

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20+ (tested on Node 24), ES modules |
| Language | TypeScript (strict) |
| HTTP | Fastify 5 with `@fastify/cookie`, `@fastify/cors`, `@fastify/multipart`, `@fastify/rate-limit` and `@fastify/static` |
| Validation | Zod |
| Database | PostgreSQL 17 in production. Embedded [PGlite](https://pglite.dev) for development and tests, so there is nothing to install. |
| Documents | ExcelJS (xlsx), docx (Word), pdfmake (PDF), archiver (zip), Nunjucks (narrative templates) |
| Email | Nodemailer (any SMTP server). Without SMTP, emails are written to the log in development. |
| Logging | pino: structured logs with request IDs; readable output in development (pino-pretty), JSON lines in production |
| API docs | OpenAPI 3.1 generated from the Zod schemas (`@fastify/swagger`), with Swagger UI (`@fastify/swagger-ui`) |
| Config files | YAML (`yaml`) for frameworks and help content |
| Tests | Vitest with an in-memory PGlite database |

## Project structure

```
server/
  src/
    main.ts            Entry point: start-up, then listen
    bootstrap.ts       Connect, run migrations, seed frameworks and help content
    config.ts          All settings, read from environment variables
    app.ts             Fastify app: plugins, auth hook, error handling, registers the route modules
    routes/            /api/v1 endpoints, one Fastify plugin per area (auth, frameworks, colleges,
                       cycles, metrics, collection-links, sharing, exports, search)
    http/              Helpers shared by routes (validation, sign-in check, file responses) and the
                       OpenAPI/Swagger setup (docs.ts)
    domain/            Pure business logic (formulas, validation, metric state, CGPA, trends, narratives)
    services/          Use cases that touch the database (workspace, auth, collection, reports, exports)
    infra/             Adapters: file storage, email and the logger
    db/                Database client, migration runner and SQL migrations
    scripts/           One-off commands (seed, import-frameworks)
  content/             Help content: FAQ, manual sections, longer metric explainers
  demo/frameworks/     Two made-up frameworks (not NAAC's) for trying the app and for the tests
```

The server reads `.env` (settings) from the **repository root**, one folder up. It is optional,
since real environment variables can be used instead.

Frameworks (metric definitions) live in the database. Import framework files with
`npm run import-frameworks -- <dir>` (for example `demo/frameworks`) and restart the server; until
then `/api/v1/ready` answers 503 with `frameworks: "missing"`.

## Getting started

Requirements: Node.js 20 or newer. You don't need a database for development.

```bash
npm ci
```

Copy the example settings at the repository root and adjust them if needed:

```bash
cp ../.env.example ../.env
```

Start the API with auto-reload on http://localhost:8080:

```bash
npm run dev
```

Open http://localhost:8080 and sign in with any email address. If `SMTP_HOST` is empty, the
sign-in link is printed in this terminal. To get the web UI on the same port, first build the
client once (`npm ci && npm run build` in `../client`). For UI work, run the client's dev server
instead (see the [client README](../client/README.md)).

### Production build

```bash
npm run build
```

```bash
npm start
```

`npm run build` compiles to `dist/` and copies the SQL migrations into it. `npm start` runs `dist/main.js`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Starts the API with `tsx watch` (reloads when a file changes); Swagger UI at `/api/docs` when `API_DOCS_PASSWORD` is set |
| `npm run build` | Compiles TypeScript to `dist/` and copies the migrations |
| `npm start` | Runs the compiled server |
| `npm run typecheck` | Type-checks without writing output |
| `npm test` | Runs all tests (Vitest, in-memory database) |
| `npm run seed` | Re-applies migrations and help content (FAQ, manual sections) to the configured database |
| `npm run import-frameworks -- <dir>` | Validates the framework files in `<dir>` and imports them (and `metric_equivalence.json`) into the configured database; nothing is written if any file is invalid. Restart the server afterwards. |

## Configuration

Settings come from environment variables, or from the `.env` file at the repository root. Real
environment variables win over the file. The server refuses to start if a setting is invalid.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the HTTP server listens on |
| `PUBLIC_URL` | `http://localhost:8080` | The API's public URL. Sign-in links and links in exported reports point here. |
| `APP_URL` | same as `PUBLIC_URL` | Where the client is served. Set it only when the client is on another origin. |
| `COOKIE_SAMESITE` | `lax` | `lax`, `strict` or `none`. Use `none` only when the client and API are on unrelated domains; it requires an `https` `PUBLIC_URL`. |
| `DATABASE_URL` | empty | PostgreSQL connection string. If empty, the embedded PGlite database is used. |
| `PGLITE_DIR` | `./data/pgdata` | Where PGlite stores its data, relative to the repository root |
| `FILES_DIR` | `./data/files` | Where evidence uploads and exports are stored |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | empty, `587` | SMTP server for sign-in and sharing emails |
| `MAIL_FROM` | `NAAC Assistant <no-reply@localhost>` | Sender address |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `SESSION_IDLE_DAYS` | `14` | A sign-in also ends after this many days without use |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Which peers may set `X-Forwarded-For` (used for per-IP rate limits): addresses, CIDRs or those keywords, a hop count, or `true`/`false`. Set it to your proxy's addresses if it has a public IP |
| `EVIDENCE_QUOTA_MB` | `2048` | Total evidence storage per workspace |
| `LOG_LEVEL` | `info` (`silent` in tests) | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `LOG_FORMAT` | `pretty`; `json` in production | `pretty` for a terminal, `json` (one object per line) for log collectors |
| `API_DOCS` | `true`; `false` in production | Serve Swagger UI and the OpenAPI spec at `/api/docs` (only when `API_DOCS_PASSWORD` is set) |
| `API_DOCS_USER`, `API_DOCS_PASSWORD` | `docs`, empty | HTTP Basic credentials for everything under `/api/docs`. Without a password the docs are not served. The password must be at least 12 characters; 10 wrong attempts lock an IP out for 15 minutes |

**Managed PostgreSQL** (e.g. Aiven) needs SSL with certificate checks: add
`?sslmode=verify-full&sslrootcert=./ca.pem` to `DATABASE_URL`, using the CA certificate from the provider's
console. (`uselibpqcompat=true&sslmode=require` encrypts but does not verify the server; the app logs a
warning for it.) Connect as a role limited to the app's tables rather than the provider's admin user, and
keep production credentials out of development setups.

**In production** (`NODE_ENV=production`, as in the Docker image) `SMTP_HOST` is required: without it
sign-in links would be written to the log, so the server refuses to start.

## Database

- Migrations are plain SQL files in `src/db/migrations/`, applied in order at every start-up. To
  change the schema, add a new numbered file. Never edit a migration that has already been applied.
- Start-up runs migrations and seeding in one transaction that holds a Postgres advisory lock, so several
  instances starting at once (e.g. two containers) take turns instead of colliding.
- Framework definitions and help content are written into the database at every start-up, so
  editing a YAML or Markdown file only needs a restart (or `npm run seed`).

## API documentation (Swagger)

The docs are password protected. Set `API_DOCS_PASSWORD` (at least 12 characters, e.g. from
`openssl rand -base64 24`) and optionally `API_DOCS_USER` (default `docs`), then open
http://localhost:8080/api/docs: the browser asks for that username and password. Without a password the
docs are not served at all, and the server logs a warning. The raw OpenAPI 3.1 spec is at
`/api/docs/json` (same password, e.g. `curl -u docs:<password> …/api/docs/json`). After 10 wrong
passwords an IP is locked out of the docs for 15 minutes. To try authenticated endpoints, sign in in the
same browser first: the session cookie is sent along.

- The spec is built from the same Zod schemas the handlers validate with (`docs()` in `src/http/docs.ts`),
  so it stays in step with the code. Each route module tags its routes (`tagRoutes`).
- Route schemas only document. Validation still happens in the handlers with Zod, so error responses
  keep the API's format whether or not the docs are served.
- A test checks that every route is documented with a tag and a summary.
- Off by default in production. Set `API_DOCS=true` to serve them there.

## Logging

One pino logger (`src/infra/logger.ts`) is used for requests, start-up, emails in development, and the scripts.

- **Request IDs:** every request gets an ID, logged with each line about it as `reqId` and returned in the
  `x-request-id` response header. A well-formed `x-request-id` sent by a proxy is reused, so one ID
  follows a request end to end.
- **No secrets in logs:** only method, URL, client IP and status are logged for a request. Cookies,
  authorization headers and bodies are never logged, and sign-in and collection-link tokens are
  removed from URLs.
- **Failures:** a failed start-up, an uncaught exception or an unhandled promise rejection is logged at
  `fatal`, then the process exits with code 1 so a process manager can restart it.
- **Format:** readable in development; JSON lines in production, ready for any log collector.

## API overview

All endpoints are under `/api/v1`. They return JSON, and errors look like `{ error, message, details? }`.

| Group | Examples |
|---|---|
| Health | `GET /health` (liveness: the process is up), `GET /ready` (readiness: database reachable and migrations applied; 503 otherwise) |
| Auth | `POST /auth/magic-link`, `GET /auth/verify`, `POST /auth/logout`, `GET /me` |
| Frameworks | `GET /frameworks`, `GET /frameworks/:fw/metrics` |
| Reports | `GET/POST /colleges/:collegeId/cycles`, `GET/PATCH/DELETE /cycles/:cycleId`, `PUT /cycles/:cycleId/inputs` |
| Metric data | `GET /cycles/:cycleId/metrics/:metricId`, `POST/PUT/DELETE .../rows`, `POST .../import`, `GET .../template.xlsx` |
| Narratives | `PUT .../narrative`, `GET .../narrative/versions`, `POST .../narrative/versions/:id/restore` |
| Workbooks | `GET /cycles/:cycleId/workbook.xlsx`, `POST /cycles/:cycleId/workbook/import`, and the same pair for `naac-workbook` |
| Evidence | `POST .../evidence`, `GET /cycles/:cycleId/evidence/:evidenceId` |
| Insights | `GET /cycles/:cycleId/cgpa`, `GET .../trends`, `GET .../review-checklist` |
| Sharing | `GET/POST /cycles/:cycleId/shares`, `GET /shared-reports` |
| Collection links | `POST .../collection-links`, `GET /cycles/:cycleId/submissions`, public `GET/POST /collect/:token/...` |
| Export | `GET /cycles/:cycleId/export.{xlsx,docx,pdf}`, `GET /cycles/:cycleId/evidence.zip` |
| Search and reference | `GET /search`, `GET /metrics/:metricId/peer-examples`, `GET /metrics/:metricId/benchmark` |

## Tests

```bash
npm test
```

Each test run starts its own in-memory database, so tests need no setup and never touch your data.
One extra test needs a real PostgreSQL: it starts several instances at once against one database.
It is skipped unless `TEST_DATABASE_URL` is set. It works in a temporary schema that it drops
afterwards:

```bash
TEST_DATABASE_URL=postgres://user:pass@host:5432/db npm test
```

The suites cover:

- the formula engine and validation;
- completeness, the checklist, narratives, CGPA and trends;
- every official framework file;
- API flows: sign-in, tenant isolation, roles and sharing, imports and exports, collection links, and calls from a client on another origin;
- configuration checks.

## Deployment

### Docker (API and client in one container)

The `Dockerfile` and `docker-compose.yml` at the repository root build the client and the server
from their own lockfiles. They run PostgreSQL, the app, Caddy (automatic TLS) and a daily database
backup:

```bash
docker compose up -d --build
```

### Server on its own

Copy `server/`, then:

```bash
npm ci --omit=dev
```

```bash
npm run build
```

```bash
NODE_ENV=production node dist/main.js
```

If the client is hosted on a different domain, set `APP_URL` to the client's URL. The API then
allows browser calls with the session cookie (CORS with credentials) only from that origin, and
rejects state-changing requests that come from any other origin. Subdomains of one domain
(`app.example.in` and `api.example.in`) work with the default `COOKIE_SAMESITE=lax`.

## Security notes

- Sign-in tokens and collection-link tokens are random and stored only as hashes. Request logs hide them.
- Session cookies are `HttpOnly`. They are `Secure` whenever `PUBLIC_URL` uses `https`.
- All SQL is parameterized, and every request body and query string is validated with Zod.
- Uploads are restricted by type and size, and a PDF must actually be a PDF.
- Sign-in, public collection links, search and exports are rate-limited.
