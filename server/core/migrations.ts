import type { Database } from "bun:sqlite";

/**
 * Check if a table exists and is a vec0 virtual table (from the old sqlite-vec schema).
 */
function isVec0Table(db: Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(tableName) as { sql: string } | null;
  return row?.sql?.toLowerCase().includes("vec0") ?? false;
}

/**
 * Migrate a vec0 virtual table to a plain BLOB table.
 * Copies id + vector data, drops the vec0 table and its shadow tables, then
 * creates the new plain table with the copied data.
 */
function migrateVec0ToBlob(db: Database, tableName: string): void {
  const tmpTable = `${tableName}_migration_tmp`;

  db.exec(`CREATE TABLE IF NOT EXISTS ${tmpTable} (id TEXT PRIMARY KEY, vector BLOB NOT NULL)`);
  db.exec(`INSERT OR IGNORE INTO ${tmpTable} (id, vector) SELECT id, vector FROM ${tableName}`);
  db.exec(`DROP TABLE ${tableName}`);
  db.exec(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY, vector BLOB NOT NULL)`);
  db.exec(`INSERT INTO ${tableName} (id, vector) SELECT id, vector FROM ${tmpTable}`);
  db.exec(`DROP TABLE ${tmpTable}`);
}

/**
 * Run all schema migrations. Safe to call on every startup (uses IF NOT EXISTS).
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

  // Migrate vec0 -> plain blob table if upgrading from sqlite-vec schema
  if (isVec0Table(db, "memories_vec")) {
    migrateVec0ToBlob(db, "memories_vec");
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories_vec (
        id     TEXT PRIMARY KEY,
        vector BLOB NOT NULL
      )
    `);
  }

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

  // Migrate vec0 -> plain blob table if upgrading from sqlite-vec schema
  if (isVec0Table(db, "conversation_history_vec")) {
    migrateVec0ToBlob(db, "conversation_history_vec");
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_history_vec (
        id     TEXT PRIMARY KEY,
        vector BLOB NOT NULL
      )
    `);
  }

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
