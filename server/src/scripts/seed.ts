// Re-applies migrations and server/content/ (FAQ, manual, metric explainers) to the database.
// Frameworks are imported separately: npm run import-frameworks -- <dir>.
import { bootstrap } from "../bootstrap.js";

const { db } = await bootstrap();
await db.close();
