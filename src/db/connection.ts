import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { runMigrations } from "./migrations.js";

/**
 * Open (or create) a SQLite database at the given path,
 * load the sqlite-vec extension, and run schema migrations.
 */
export function connectToDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // WAL mode for concurrent read performance
  db.exec("PRAGMA journal_mode=WAL");

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Ensure schema is up to date
  runMigrations(db);

  return db;
}
