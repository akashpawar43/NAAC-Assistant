// Imports framework files into the database. Frameworks are data, not part of the app: they are
// validated here (nothing is written if any file is invalid) and again by every server at start-up.
//
// Usage: npm run import-frameworks -- <dir>
//   <dir> holds the framework files (*.yaml) and, optionally, metric_equivalence.json.
//   The database is DATABASE_URL (or the local PGlite folder when it is empty), as for the server.
//   Restart running servers afterwards: they keep frameworks in memory.
import { resolve } from "node:path";
import { openDb, withStartupLock } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { importFrameworks, readFrameworkDir, seedEquivalence } from "../services/frameworks.js";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npm run import-frameworks -- <dir with framework *.yaml files>");
  process.exit(2);
}

const cfg = loadConfig();
// npm runs scripts in server/; a relative <dir> means relative to where the command was typed.
const from = process.env.INIT_CWD ?? process.cwd();
const files = readFrameworkDir(resolve(from, dir));
const db = await openDb(cfg);
try {
  console.log(`Importing ${files.length} framework file(s) into ${db.kind === "pg" ? "PostgreSQL (DATABASE_URL)" : `PGlite (${cfg.pgliteDir})`}`);
  await withStartupLock(db, console.log, async (t) => {
    await importFrameworks(t, files, { contentDir: cfg.contentDir, log: console.log });
    await seedEquivalence(t, resolve(from, dir), console.log);
  });
  console.log("Done. Restart running servers to load the new frameworks.");
} finally {
  await db.close();
}
