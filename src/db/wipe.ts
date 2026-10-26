import "dotenv/config";

import { assertWipeAuthorized, resolveDatabasePath, wipeDatabase } from "./wipe-core.js";

function main() {
  assertWipeAuthorized(process.argv.slice(2));
  const databasePath = resolveDatabasePath(process.env.DATABASE_URL ?? "./data/ab-ignite.db");
  const result = wipeDatabase(databasePath);
  console.log(`Cleared ${result.clearedTables} application tables at ${databasePath}. Drizzle schema and migration history were preserved.`);
  console.log("Run npm run db:seed to recreate the admin and learning catalogue.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database wipe failed.");
  process.exitCode = 1;
}
