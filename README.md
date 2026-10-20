# NAAC Assistant

A web app where a college's IQAC team collects AQAR/SSR data all year, metric by metric.
The app checks completeness, calculates metric values, shows how accredited colleges
answered each metric, and exports AQAR/SSR-ready Excel.

**In the app.** Calculations are declarative formulas, narratives are templates
filled from structured fields, search is Postgres full-text search, and the review
checklist is rules.

```
client/      React + Vite PWA (TypeScript)
server/      Fastify API (TypeScript); Postgres in production, embedded PGlite in dev/tests
  content/   FAQ, optional NAAC manual sections and longer metric explainers (searchable)
  demo/      Two made-up frameworks to try the app with (not NAAC frameworks)
```

`client/` and `server/` are independent npm projects, each with its own `package.json` and
`package-lock.json`, so either can be installed, built and deployed from its own folder. The root
`package.json` only holds shortcut scripts that run them (`npm run dev`, `build`, `test`, ...).

**Frameworks are data, not code.** A framework (metric IDs, titles, data templates, formulas,
score bands, rules) is a YAML file imported into the database with `npm run import-frameworks`;
the server validates it on import and again at every start-up. The NAAC frameworks themselves and
the reference data behind peer examples and benchmarks are not part of this repository. The
`server/demo/frameworks` files show the format.

## Run it locally

Needs Node 20+ (tested on Node 24). No database install: dev uses PGlite in `./data/pgdata`.

Installs both projects from their lockfiles (same as `npm ci` in `server/` and in `client/`):

```bash
npm run setup
```

```bash
npm run build --prefix client
```

```bash
npm run dev
```

The database starts without frameworks (`/api/v1/ready` says so). Import the demo ones, then
restart the server:

```bash
npm run import-frameworks -- server/demo/frameworks
```

`import-frameworks` writes to the database the server uses: `DATABASE_URL`, or the local PGlite
folder when it is empty.

Open http://localhost:8080 and enter any email. Anyone can sign up: the account is created
when the emailed link is opened, and each user gets a private workspace for their reports.
Without `SMTP_*` in `.env`, the link is printed in the server log instead of emailed (any
SMTP provider's free tier works for real email).
For frontend work, also run `npm run dev:client` and use http://localhost:5173.

## Features

| Area | What it does |
|---|---|
| Accounts | Open sign-up with magic links (no passwords). Each user has a private workspace; nobody else can see their reports, and the tests cover cross-user access. The database keeps workspace membership and roles (`iqac_admin`, `dept_editor`, `viewer`) so a report can later be shared, but the UI does not expose sharing yet. |
| Reports | AQAR (one year) or SSR (five years) for any college the user names, with state, institution type and AISHE ID stored on the report. These drive the peer-example and benchmark filters. Reports can be renamed, edited or deleted. Carry-forward copies narratives, checklist/choice answers and non-yearly inputs from an earlier report. |
| Extended profile | Per-year base numbers (students, teachers, expenditure ...) that formulas divide by. |
| Metric workspace | Plain-language explanation, data table with validation (types, academic years, duplicates), Excel template download, and import that validates every row before anything is saved, with errors reported by real spreadsheet row number. |
| Calculation | `server/src/domain/formula.ts`: a JSON formula tree from the framework YAML, checked when the framework is loaded and never `eval`'d. Missing inputs or division by zero give "no value" plus the reason, never a wrong number. |
| Narratives | Guided fields in NAAC's format (for example the 7-part best-practice format), a Nunjucks template, optional facts pulled from the college's own computed values, and a word-limit counter. Always labelled as a draft. Saves automatically 2 s after typing stops, and asks before closing a tab with unsaved text. **History** keeps one version per editing session (saves by the same person within 5 minutes merge), up to 50 per metric; any version can be viewed and restored, and restoring is itself a new version. |
| Data workbook | One `.xlsx` with every data metric on its own sheet, pre-filled with current rows, plus the extended profile. Upload it back: every sheet is checked and errors are reported by sheet and row; saving is all or nothing in one transaction. **Replace** makes each sheet the metric's data (for the edited download); **Add** appends (for files returned by departments). A sheet with no data rows never clears a metric. |
| NAAC data templates | For the 2023 affiliated framework, data is entered as records in the columns of NAAC's official data-template workbook, and values are calculated from those records. Export it in NAAC's own layout (same sheets, headers, yearly blocks), or import NAAC's workbook filled in by hand. |
| SSR from AQARs | An SSR can be filled from the same college's AQARs (matched by AISHE ID, else by name) whose year falls inside the SSR: data rows, empty extended-profile cells, and the latest narratives and answers where the SSR has none. It never overwrites or deletes, skips rows the SSR already has (by the metric's unique columns), and shows a preview first; running it twice adds nothing. |
| Sharing | Share one report by email as **editor** (all data, profile, evidence, workbook import) or **viewer** (read and export). A share never opens the owner's other reports or workspace, and only the owner can rename, delete, re-share or fill the report from AQARs. Recipients get an email and see it under "Shared with me". An access-matrix test covers every role and action. |
| Collection links | A link for one data metric that a department can fill **without an account**, by typing rows or uploading the template. The token is random, stored only as a hash, shown once, expires after 1–60 days and can be closed. The public page shows only the metric's form, never existing data. Submissions wait under **Review submissions** until the owner or an editor accepts them (re-checked against current data; two clicks cannot accept twice). Limits: 20 requests per minute per IP, 500 rows per submission, 20 submissions per link. |
| Estimated CGPA | An indicative **range** (never one number) on the dashboard, with a breakdown page by criterion and key indicator and the reason for every open part. Key-indicator and metric weights come from the framework. Narratives, the student survey and counts without a published band count as 0 at the low end and 4 at the high end. Shown on NAAC's seven-point grade scale. |
| Trends | The same college's **AQARs** over the years: one sparkline per metric, the latest change, and drops of 10% or more listed first (red ▼ plus the percentage). SSRs are left out because their values average five years. Someone a report was shared with sees only that report. |
| Evidence | Upload per metric (PDF/JPG/PNG/XLSX/DOCX, 10 MB, PDF signature checked); missing required documents are flagged. |
| Review checklist | Rules from the framework file: no data, missing evidence, missing years, low score band, drop vs previous cycle, narrative too short or too long. |
| Search NAAC | One box over metric explainers, FAQ, manual sections, peer SSR excerpts and the college's own data. Metric IDs jump to the metric. NAAC synonyms are expanded (IQAC, MoU, FDP, ICT ...), with a trigram fallback for typos. Every result names its source. |
| Peer examples | When reference data is loaded: excerpts from accredited colleges' SSRs for the same metric, filtered by state, institution type and grade, and ranked by the score that college got for that criterion (from its NAAC grade sheet). Tables from the SSR are shown alongside. Only high-confidence segments are shown. |
| Benchmark | When reference data is loaded: distribution (p25/median/p75/p90) of the values colleges reported for a metric, and where your value sits. |
| Export | Four formats from one shared model, so they always agree: **Word** (.docx, editable, in NAAC order with cover, summary, extended profile, data tables, narratives and evidence links), **PDF** (same layout, A4, page numbers), **Excel** (summary plus one sheet per data metric with every row), and an **evidence ZIP** (proofs in `Criterion / Metric / Document type` folders, plus `_index.csv` listing missing documents). Every format can be limited to chosen criteria, chosen metrics, or statuses (for example "partial + not started" as a to-do list); each metric page also has one-click exports of that metric. Endpoints: `GET /api/v1/cycles/:id/export.{docx,pdf,xlsx}` and `/evidence.zip`, with `?criteria=3,5&metrics=5.2.1&status=partial,empty`. |


## Production deploy

```bash
cp .env.example .env
```

Set `PUBLIC_URL`, `SMTP_*`, and `POSTGRES_PASSWORD`, put your domain in `Caddyfile`, then run:

```bash
docker compose up -d --build
```

Then import your frameworks into the database (from a checkout with `DATABASE_URL` set to the
production database) and restart the app:

```bash
npm run import-frameworks -- <folder with framework *.yaml files>
```

`docker-compose.yml` runs Postgres 17, the app, Caddy (automatic TLS) and a daily
`pg_dump` kept for 14 days. A 4 GB VM is enough for 10 to 50 colleges.

### Hosting the client separately

By default the server also serves the built client, so both share one origin. To host the client
elsewhere (a static host or CDN) and the API on its own:

| Where | Setting | Example |
|---|---|---|
| Server `.env` | `PUBLIC_URL`: the API's URL (sign-in links point here) | `https://api.example.in` |
| Server `.env` | `APP_URL`: the client's URL (sign-in lands here; collection links, CORS) | `https://app.example.in` |
| Client build | `VITE_API_URL`: the API's origin (see `client/.env.example`) | `https://api.example.in` |

```bash
VITE_API_URL=https://api.example.in npm run build --prefix client
```

A host that builds from the `client/` folder alone runs `npm ci && npm run build` there and
publishes `dist`. Upload `client/dist` and route every unknown path to `index.html` (it is a single-page app).

- **Prefer subdomains of one domain** (`app.` and `api.example.in`). The session cookie stays
  `SameSite=Lax` and works in every browser.
- **Unrelated domains** (e.g. `*.vercel.app` + `*.onrender.com`) need `COOKIE_SAMESITE=none` and an
  https `PUBLIC_URL`. That cookie is a third-party cookie, which Safari and privacy settings in
  other browsers block, so sign-in may not stick there.
- With `APP_URL` set, the API allows browser calls (CORS with credentials) only from that origin
  and rejects POST/PUT/PATCH/DELETE carrying any other `Origin`.

## Tests

```bash
npm test
```

| Suite | Covers |
|---|---|
| Server (vitest, in-memory PGlite, demo frameworks) | Formula engine, validation, completeness, checklist, narratives, query parsing, framework import and start-up checks, and API flows: magic link, tenant isolation, roles, idempotent row creation, Excel round trip, data-template workbooks, evidence checks, export, carry-forward, sharing, collection links, peers, benchmark, search, and that no response exposes formulas or score bands |

## Known limits and next steps

- **Add manual text.** Put NAAC manual text in `server/content/manual/` and longer explainers in `server/content/explainers/`.
- **Security notes:** server logs redact tokens in URLs (sign-in and collection links). Remove any `console.log` of sign-in links before real users sign in. A collection-link submission stuck in "accepting" (if the server stops mid-accept) stays out of the queue until reset in the database.
- **Not built yet:** WhatsApp reminders, Hindi/Marathi UI, evidence uploads through collection links, and an S3/R2 `FileStore` (the interface is ready).
