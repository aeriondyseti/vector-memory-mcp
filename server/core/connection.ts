import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { removeVec0Tables, runMigrations } from "./migrations.js";

/**
 * Open (or create) a SQLite database at the given path
 * and run schema migrations.
 */
export function connectToDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  // Remove orphaned vec0 virtual table entries before bun:sqlite opens the
  // database. bun:sqlite cannot modify sqlite_master, so this uses the
  // sqlite3 CLI while no other connection holds a lock.
  if (existsSync(dbPath)) {
    removeVec0Tables(dbPath);
  }

  const db = new Database(dbPath);

  // WAL mode for concurrent read performance
  db.exec("PRAGMA journal_mode=WAL");

  // Ensure schema is up to date
  runMigrations(db);

  return db;
}
