import type { Database } from "bun:sqlite";

/**
 * Pre-migration step: remove vec0 virtual table entries from sqlite_master
 * and drop their shadow tables using the sqlite3 CLI.
 *
 * Must run BEFORE bun:sqlite opens the database because:
 *  - bun:sqlite cannot modify sqlite_master (no writable_schema support)
 *  - DROP TABLE on a virtual table requires the extension module to be loaded
 *  - SQLite 3.51+ has defensive mode on by default, requiring .dbconfig override
 *
 * Safe to call on any database — it's a no-op if there are no vec0 tables.
 */
export function removeVec0Tables(dbPath: string): void {
  const result = Bun.spawnSync({
    cmd: ["sqlite3", dbPath],
    stdin: new TextEncoder().encode(
      [
        ".dbconfig defensive off",
        ".dbconfig writable_schema on",
        // Drop shadow tables (regular tables, no extension needed)
        "DROP TABLE IF EXISTS memories_vec_rowids;",
        "DROP TABLE IF EXISTS memories_vec_chunks;",
        "DROP TABLE IF EXISTS memories_vec_info;",
        "DROP TABLE IF EXISTS memories_vec_vector_chunks00;",
        "DROP TABLE IF EXISTS memories_vec_migration_tmp;",
        "DROP TABLE IF EXISTS conversation_history_vec_rowids;",
        "DROP TABLE IF EXISTS conversation_history_vec_chunks;",
        "DROP TABLE IF EXISTS conversation_history_vec_info;",
        "DROP TABLE IF EXISTS conversation_history_vec_vector_chunks00;",
        "DROP TABLE IF EXISTS conversation_history_vec_migration_tmp;",
        // Remove orphaned vec0 virtual table entries from schema
        "DELETE FROM sqlite_master WHERE sql LIKE '%vec0%';",
      ].join("\n"),
    ),
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    if (!stderr.includes("unable to open database")) {
      throw new Error(`vec0 cleanup failed: ${stderr}`);
    }
  }
}

/**
 * Run all schema migrations. Safe to call on every startup (uses IF NOT EXISTS).
 *
 * IMPORTANT: Call removeVec0Tables(dbPath) before opening the database
 * with bun:sqlite if the database may contain vec0 virtual tables.
 */
export function runMigrations(db: Database): void {
  // -- Memories --
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      content       TEXT NOT NULL,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      superseded_by TEXT,
      usefulness    REAL NOT NULL DEFAULT 0.0,
      access_count  INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories_vec (
      id     TEXT PRIMARY KEY,
      vector BLOB NOT NULL
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      content
    )
  `);

  // -- Conversation History --
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id                  TEXT PRIMARY KEY,
      content             TEXT NOT NULL,
      metadata            TEXT NOT NULL DEFAULT '{}',
      created_at          INTEGER NOT NULL,
      session_id          TEXT NOT NULL,
      role                TEXT NOT NULL,
      message_index_start INTEGER NOT NULL,
      message_index_end   INTEGER NOT NULL,
      project             TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_history_vec (
      id     TEXT PRIMARY KEY,
      vector BLOB NOT NULL
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_history_fts USING fts5(
      id UNINDEXED,
      content
    )
  `);

  // -- Indexes --
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_session_id ON conversation_history(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_project ON conversation_history(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_role ON conversation_history(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_created_at ON conversation_history(created_at)`);
}
