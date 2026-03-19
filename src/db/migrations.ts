import type { Database } from "bun:sqlite";

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

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      id TEXT PRIMARY KEY,
      vector float[384]
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
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_history_vec USING vec0(
      id TEXT PRIMARY KEY,
      vector float[384]
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
