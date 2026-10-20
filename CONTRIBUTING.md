# Contributing

Setup and running the app are in [README.md](README.md). This page covers how changes get in.

## Branches

`main` is always releasable. Work on a short-lived branch cut from `main` and merge it back through a pull request.

| Prefix | For | Example |
|---|---|---|
| `feat/` | new behaviour | `feat/ssr-from-aqars-preview` |
| `fix/` | a bug fix | `fix/workbook-import-blank-sheet` |
| `refactor/` | no behaviour change | `refactor/split-workspace-service` |
| `chore/` | tooling, dependencies, CI | `chore/add-helmet` |
| `docs/` | documentation only | `docs/contributing` |

Use lowercase words joined by hyphens. Keep one topic per branch.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, in the imperative mood and under 72 characters.

```
feat(narrative): keep one version per editing session
fix(import): report errors by spreadsheet row number
refactor(workspace): split service by area
```

- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.
- Scopes are optional; use the area you touched (`server`, `client`, or a feature such as `import` or `sharing`).
- Mark a breaking change with `!` (`feat(api)!: ...`) and explain it in the body.
- Never commit secrets (`.env`), generated output (`dist/`) or local data (`data/`).

## Before every push

```bash
npm run check
```

This typechecks the server and client, runs the server tests, and builds the client. Push only when it passes.

The tests use the made-up frameworks in `server/demo/frameworks`. A change to the framework file format
should come with a matching change there, so the tests keep covering every kind of metric.

## Pull requests

- Keep them small and focused. Put a refactor in its own PR, not inside a feature.
- Say what changed, why, and how you tested it, including anything you could not test.
- Add or update tests for the behaviour you changed. For a bug fix, first write a test that fails without the fix.
- Update the README or `server/README.md` when setup, behaviour or the API changes.
