import type { Database } from "bun:sqlite";
import type { EmbeddingsService } from "./embeddings.service";
import { serializeVector } from "./sqlite-utils";

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

/**
 * Backfill missing vectors in memories_vec and conversation_history_vec.
 *
 * After the vec0-to-BLOB migration, existing rows may lack vector embeddings.
 * This re-embeds their content and inserts into the _vec tables.
 * Idempotent: skips rows that already have vectors. Fast no-op when fully backfilled.
 */
export async function backfillVectors(
  db: Database,
  embeddings: EmbeddingsService,
): Promise<void> {
  // Quick gap check: if no rows are missing vectors, skip the expensive backfill
  const hasMemories = db.prepare("SELECT 1 FROM memories LIMIT 1").get();
  const hasConvos = db.prepare("SELECT 1 FROM conversation_history LIMIT 1").get();

  if (!hasMemories && !hasConvos) return;

  const memoryGap = hasMemories && db.prepare(
    `SELECT 1 FROM memories m LEFT JOIN memories_vec v ON m.id = v.id
     WHERE v.id IS NULL OR length(v.vector) = 0 LIMIT 1`,
  ).get();

  const convoGap = hasConvos && db.prepare(
    `SELECT 1 FROM conversation_history c LEFT JOIN conversation_history_vec v ON c.id = v.id
     WHERE v.id IS NULL OR length(v.vector) = 0 LIMIT 1`,
  ).get();

  if (!memoryGap && !convoGap) return;

  // ── Memories ──────────────────────────────────────────────────────
  const missingMemories = db
    .prepare(
      `SELECT m.id, m.content, json_extract(m.metadata, '$.type') AS type
       FROM memories m
       LEFT JOIN memories_vec v ON m.id = v.id
       WHERE v.id IS NULL OR length(v.vector) = 0`,
    )
    .all() as Array<{ id: string; content: string; type: string | null }>;

  if (missingMemories.length > 0) {
    console.error(
      `[vector-memory-mcp] Backfilling vectors for ${missingMemories.length} memories...`,
    );

    const insertVec = db.prepare(
      "INSERT OR REPLACE INTO memories_vec (id, vector) VALUES (?, ?)",
    );

    const zeroVector = serializeVector(
      new Array(embeddings.dimension).fill(0),
    );

    // Separate waypoints from content that needs embedding
    const toEmbed = missingMemories.filter((r) => r.type !== "waypoint");
    const waypoints = missingMemories.filter((r) => r.type === "waypoint");

    // Batch embed all non-waypoint content
    const vectors = toEmbed.length > 0
      ? await embeddings.embedBatch(toEmbed.map((r) => r.content))
      : [];

    db.exec("BEGIN");
    try {
      for (const row of waypoints) {
        insertVec.run(row.id, zeroVector);
      }
      for (let i = 0; i < toEmbed.length; i++) {
        insertVec.run(toEmbed[i].id, serializeVector(vectors[i]));
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    console.error(
      `[vector-memory-mcp] Backfilled ${missingMemories.length} memory vectors`,
    );
  }

  // ── Conversation history ──────────────────────────────────────────
  const missingConvos = db
    .prepare(
      `SELECT c.id, c.content
       FROM conversation_history c
       LEFT JOIN conversation_history_vec v ON c.id = v.id
       WHERE v.id IS NULL OR length(v.vector) = 0`,
    )
    .all() as Array<{ id: string; content: string }>;

  if (missingConvos.length > 0) {
    console.error(
      `[vector-memory-mcp] Backfilling vectors for ${missingConvos.length} conversation chunks...`,
    );

    const insertConvoVec = db.prepare(
      "INSERT OR REPLACE INTO conversation_history_vec (id, vector) VALUES (?, ?)",
    );

    // Batch embed in chunks of 32
    const BATCH_SIZE = 32;
    db.exec("BEGIN");
    try {
      for (let i = 0; i < missingConvos.length; i += BATCH_SIZE) {
        const batch = missingConvos.slice(i, i + BATCH_SIZE);
        const vecs = await embeddings.embedBatch(batch.map((r) => r.content));
        for (let j = 0; j < batch.length; j++) {
          insertConvoVec.run(batch[j].id, serializeVector(vecs[j]));
        }

        if ((i + BATCH_SIZE) % 100 < BATCH_SIZE) {
          console.error(
            `[vector-memory-mcp]   ...${Math.min(i + BATCH_SIZE, missingConvos.length)}/${missingConvos.length} conversation chunks`,
          );
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    console.error(
      `[vector-memory-mcp] Backfilled ${missingConvos.length} conversation vectors`,
    );
  }
}
