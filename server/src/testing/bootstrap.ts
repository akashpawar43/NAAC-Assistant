// Test start-up: an in-memory database with the demo frameworks imported, as `npm run import-frameworks` would.
// The demo frameworks are made up (not NAAC frameworks), so the tests run without the private ones.
import { fileURLToPath } from "node:url";
import { bootstrap } from "../bootstrap.js";
import type { Config } from "../config.js";
import { FrameworkRegistry, importFrameworks, readFrameworkDir, seedEquivalence } from "../services/frameworks.js";

export const DEMO_FRAMEWORKS_DIR = fileURLToPath(new URL("../../demo/frameworks/", import.meta.url));

export async function bootstrapWithFrameworks(overrides: Partial<Config> = {}) {
  const boot = await bootstrap({ databaseUrl: "", pgliteDir: "", ...overrides }, () => {});
  await importFrameworks(boot.db, readFrameworkDir(DEMO_FRAMEWORKS_DIR), { contentDir: boot.cfg.contentDir });
  await seedEquivalence(boot.db, DEMO_FRAMEWORKS_DIR);
  return { ...boot, frameworks: await FrameworkRegistry.fromDb(boot.db) };
}
