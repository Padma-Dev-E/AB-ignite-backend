import Database from "better-sqlite3";
import { existsSync, renameSync } from "node:fs";

const sourcePath = "/dev-data/ab-ignite.db";
const targetPath = "/app/data/ab-ignite.db";
const temporaryPath = `${targetPath}.importing`;

if (existsSync(targetPath)) {
  console.log("Docker database already exists; preserving it.");
} else {
  if (!existsSync(sourcePath)) throw new Error("Development database is missing; import stopped.");
  if (existsSync(temporaryPath)) throw new Error("An incomplete database import exists; inspect it before retrying.");

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(temporaryPath);
  } finally {
    source.close();
  }

  const imported = new Database(temporaryPath, { readonly: true, fileMustExist: true });
  try {
    if (imported.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("Imported database failed SQLite integrity check.");
    }
  } finally {
    imported.close();
  }

  renameSync(temporaryPath, targetPath);
  console.log("Development database copied into the Docker volume via SQLite online backup.");
}
