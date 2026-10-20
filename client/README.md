# NAAC Assistant — Client

The web app for NAAC Assistant. A college's IQAC team uses it to prepare AQAR and SSR reports
one metric at a time: enter and check data, write narratives, track completeness, and export
reports. It is a single-page app (and installable PWA) that talks to the [server](../server/README.md)
over its JSON API.

## Features

| Screen | Route | What it does |
|---|---|---|
| Sign in | `/` | Passwordless sign-in: enter an email address, then open the link that arrives. |
| My reports | `/` | Lists your reports and the ones shared with you. |
| New report | `/reports/new` | Creates an AQAR (one year) or SSR (five years) on a chosen NAAC framework. Can carry forward an earlier report. |
| Dashboard | `/c/:cycleId` | Completeness for each criterion and metric, plus the estimated CGPA range. |
| Metric | `/c/:cycleId/m/:metricId` | Plain-language explanation, a data table with validation, Excel template and import, evidence uploads, collection links, and examples and benchmarks from peers. |
| Narrative | inside Metric | Guided fields in NAAC's format, a live draft, a word-limit counter, autosave, and version history with restore. |
| Profile | `/c/:cycleId/profile` | Extended-profile numbers for each year, and the college's details. |
| Data workbook | `/c/:cycleId/workbook` | Download every metric in one `.xlsx` (or in NAAC's template layout) and upload it back. |
| Review | `/c/:cycleId/review` | Accept or reject submissions that came in through collection links. |
| Checklist | `/c/:cycleId/checklist` | Rule-based review flags to fix before submitting. |
| CGPA | `/c/:cycleId/cgpa` | Estimated CGPA range, broken down by criterion and key indicator. |
| Trends | `/c/:cycleId/trends` | Year-over-year sparklines across the college's AQARs, with drops highlighted. |
| Search | `/c/:cycleId/search` | One search across explainers, the FAQ, manual sections, reference material and your own data. |
| Export | `/c/:cycleId/export` | Word, PDF, Excel or an evidence ZIP, for the whole report or chosen criteria and metrics. |
| Settings | `/c/:cycleId/settings` | Owner only: rename or delete the report, share it by email, and fill an SSR from AQARs. |
| Collect | `/collect/:token` | Public page where a department fills in one metric without an account. |

## Tech stack

| Concern | Choice |
|---|---|
| UI | React 18 (function components and hooks) |
| Routing | React Router 6 |
| Language | TypeScript (strict) |
| Build and dev server | Vite 8 with `@vitejs/plugin-react` |
| Styling | Plain CSS with design tokens (`src/styles/tokens.css`) |
| API calls | A small `fetch` wrapper (`src/api.ts`). No state-management library. |
| PWA | Web app manifest and icon in `public/` |

## Project structure

```
client/
  index.html           HTML shell
  public/              Static files copied as-is (manifest, icon)
  src/
    main.tsx           Entry point
    App.tsx            Layout, navigation and routes
    api.ts             API wrapper (fetch, errors, API base URL) and response types
    env.d.ts           Types for the VITE_ build settings
    pages/             One file per screen, plus shared UI parts (ui.tsx, Icon.tsx)
    styles.css         App styles
    styles/tokens.css  Colours, spacing and type scale
  vite.config.ts       Dev server and the /api proxy
```

## Getting started

Requirements: Node.js 20 or newer, and the [server](../server/README.md) running on port 8080.

```bash
npm ci
```

```bash
npm run dev
```

Open http://localhost:5173. In development, Vite passes every `/api` request on to the server at
`http://localhost:8080`. If the server runs on another port, set `API_PORT`, for example
`API_PORT=8081 npm run dev`. The sign-in link is printed in the server's terminal when no SMTP
server is configured.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Starts the Vite dev server with hot reload on port 5173 |
| `npm run build` | Type-checks, then builds the production bundle into `dist/` |
| `npm run preview` | Serves the built `dist/` locally |
| `npm run typecheck` | Type-checks without building |

## Configuration

Settings are read **at build time** (they are written into the bundle). See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | empty | The API's origin, e.g. `https://api.example.in`. Leave it empty when the API is on the same origin as the app. |
| `API_PORT` | `8080` | Development only: the port the `/api` proxy forwards to |

## Deployment

### Served by the server (simplest)

Build the client, and the server serves `client/dist` on the same origin. This is what the Docker
image at the repository root does.

```bash
npm run build
```

### On its own host or CDN

1. Build with the API's address:

   ```bash
   VITE_API_URL=https://api.example.in npm run build
   ```

2. Publish `dist/`. On hosts that build from this folder, the build command is
   `npm ci && npm run build` and the output folder is `dist`.
3. Send every unknown path to `index.html`, so that links like `/c/<id>/workbook` load the app.
4. On the server, set `APP_URL` to this app's URL. The API then accepts calls from it.

Prefer subdomains of one domain (`app.example.in` and `api.example.in`); sign-in then works in
every browser. Unrelated domains need `COOKIE_SAMESITE=none` on the server. Safari and strict
privacy settings in other browsers block that kind of cookie, so users may not stay signed in there.

A proxy can also serve the app and the API on one domain (`/api` goes to the server, everything
else to the static files). In that case leave `VITE_API_URL` empty.

## Conventions

- Make every API call through `api` in `src/api.ts`. It adds the API base URL, sends the session
  cookie and turns error responses into `ApiError`.
- For plain links and downloads that go to the API (`<a href>`), wrap the path in `apiUrl(...)` so
  they still work when the API is on another origin.
- Response types in `src/api.ts` mirror the server's responses. Update them when the API changes.
