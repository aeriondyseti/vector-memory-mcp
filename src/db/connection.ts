import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { runMigrations } from "./migrations.js";

/**
 * Open (or create) a SQLite database at the given path
 * and run schema migrations.
 */
export function connectToDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // WAL mode for concurrent read performance
  db.exec("PRAGMA journal_mode=WAL");

  // Ensure schema is up to date
  runMigrations(db);

  return db;
}
