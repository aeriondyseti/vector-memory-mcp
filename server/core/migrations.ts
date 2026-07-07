import type { Database } from "bun:sqlite";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import type { EmbeddingsService } from "./embeddings.service";
import { normalizeProject } from "./project";
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
      last_accessed INTEGER,
      project       TEXT,
      pinned        INTEGER NOT NULL DEFAULT 0,
      archived      INTEGER NOT NULL DEFAULT 0,
      confidence    TEXT,
      importance    TEXT,
      expires_at    INTEGER,
      quality_score REAL,
      episode_id    TEXT,
      sequence_number INTEGER,
      preceding_memory_id TEXT
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

  // -- Conversation index state (replaces conversation_index_state.json) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_index_state (
      session_id       TEXT PRIMARY KEY,
      file_path        TEXT NOT NULL,
      project          TEXT NOT NULL,
      last_modified    INTEGER NOT NULL,
      chunk_count      INTEGER NOT NULL,
      message_count    INTEGER NOT NULL,
      indexed_at       INTEGER NOT NULL,
      first_message_at INTEGER NOT NULL,
      last_message_at  INTEGER NOT NULL
    )
  `);

  // -- Versioned migrations (non-idempotent schema changes) --
  runVersionedMigrations(db);

  // -- Indexes --
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_session_id ON conversation_history(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_project ON conversation_history(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_role ON conversation_history(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversation_created_at ON conversation_history(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_episode_id ON memories(episode_id)`);
}

/** Current schema version. Bump when adding a versioned migration below. */
const SCHEMA_VERSION = 2;

function getUserVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | null;
  return row?.user_version ?? 0;
}

/** Add a column to `memories` only if it does not already exist. */
function addColumnIfMissing(db: Database, column: string, ddl: string): void {
  const columns = db
    .prepare("PRAGMA table_info(memories)")
    .all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE memories ADD COLUMN ${ddl}`);
  }
}

/**
 * Non-idempotent migrations (e.g. ALTER TABLE) gated by PRAGMA user_version.
 *
 * Concurrency-safe for multiple processes opening the same database: the
 * version is re-checked inside BEGIN IMMEDIATE, so the loser of a startup
 * race blocks on busy_timeout, then sees the bumped version and no-ops.
 *
 * Each step is applied in order and the version is bumped incrementally so a
 * database at any prior version catches up to SCHEMA_VERSION.
 */
function runVersionedMigrations(db: Database): void {
  if (getUserVersion(db) >= SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    let version = getUserVersion(db);

    if (version < 1) {
      // v1: project column on memories (fresh databases get it via CREATE
      // TABLE above; pre-existing databases need the ALTER).
      addColumnIfMissing(db, "project", "project TEXT");

      // Backfill from metadata where a project was recorded (waypoints).
      // Values are stored raw — they may be legacy display names rather than
      // canonical paths; consolidation re-stamps them with the real project.
      db.exec(`
        UPDATE memories
        SET project = json_extract(metadata, '$.project')
        WHERE project IS NULL
          AND json_extract(metadata, '$.project') IS NOT NULL
      `);

      db.exec("PRAGMA user_version = 1");
      version = 1;
    }

    if (version < 2) {
      // v2: extended memory attribute columns (pinning, archiving, confidence/
      // importance, TTL, quality score, episodic chains). All nullable or
      // defaulted so existing rows remain valid; feature behavior layers on top.
      addColumnIfMissing(db, "pinned", "pinned INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "archived", "archived INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "confidence", "confidence TEXT");
      addColumnIfMissing(db, "importance", "importance TEXT");
      addColumnIfMissing(db, "expires_at", "expires_at INTEGER");
      addColumnIfMissing(db, "quality_score", "quality_score REAL");
      addColumnIfMissing(db, "episode_id", "episode_id TEXT");
      addColumnIfMissing(db, "sequence_number", "sequence_number INTEGER");
      addColumnIfMissing(
        db,
        "preceding_memory_id",
        "preceding_memory_id TEXT",
      );

      db.exec("PRAGMA user_version = 2");
      version = 2;
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Repair legacy `conversation_history.project` values.
 *
 * Rows indexed before the cwd-based parser carry lossy dash-decoded project
 * values (no leading slash; any dash in a directory name decoded as "/").
 * This re-derives the true project from each session file's `cwd` field.
 * Rows whose session file is gone get a best-effort "/" prefix so they gain
 * the canonical-path invariant and are not re-scanned on every startup.
 *
 * Identifies legacy rows by the missing leading slash, so it converges to a
 * no-op once all rows are repaired.
 */
export async function repairConversationProjects(
  db: Database,
  dbPath: string,
): Promise<void> {
  const legacy = db
    .prepare(
      "SELECT DISTINCT session_id FROM conversation_history WHERE project NOT LIKE '/%'",
    )
    .all() as Array<{ session_id: string }>;

  if (legacy.length === 0) return;

  // session_id -> file_path, from the index state table or the legacy JSON
  const filePaths = new Map<string, string>();
  const stateRows = db
    .prepare("SELECT session_id, file_path FROM conversation_index_state")
    .all() as Array<{ session_id: string; file_path: string }>;
  for (const row of stateRows) filePaths.set(row.session_id, row.file_path);

  if (filePaths.size === 0) {
    try {
      const raw = await readFile(
        join(dirname(dbPath), "conversation_index_state.json"),
        "utf-8",
      );
      const entries = JSON.parse(raw) as Array<{
        sessionId: string;
        filePath: string;
      }>;
      for (const e of entries) filePaths.set(e.sessionId, e.filePath);
    } catch {
      // No legacy state file — fall through to best-effort repair
    }
  }

  console.error(
    `[vector-memory-mcp] Repairing project values for ${legacy.length} legacy sessions...`,
  );

  const updateExact = db.prepare(`
    UPDATE conversation_history
    SET project = ?, metadata = json_set(metadata, '$.project', ?)
    WHERE session_id = ?
  `);
  const updateBestEffort = db.prepare(`
    UPDATE conversation_history
    SET project = '/' || project
    WHERE session_id = ? AND project NOT LIKE '/%'
  `);
  const updateState = db.prepare(
    "UPDATE conversation_index_state SET project = ? WHERE session_id = ?",
  );

  for (const { session_id } of legacy) {
    const filePath = filePaths.get(session_id);
    const cwd = filePath ? await readSessionCwd(filePath) : null;
    if (cwd) {
      const project = normalizeProject(cwd);
      updateExact.run(project, project, session_id);
      updateState.run(project, session_id);
    } else {
      updateBestEffort.run(session_id);
    }
  }
}

/** Read the first `cwd` value from a Claude Code session JSONL file. */
async function readSessionCwd(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const entry = JSON.parse(line) as { cwd?: unknown };
      if (typeof entry.cwd === "string" && entry.cwd.length > 0) {
        return entry.cwd;
      }
    } catch {
      // malformed line — keep scanning
    }
  }
  return null;
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

    // Batch embed in chunks of 32. Embedding happens OUTSIDE the write
    // transaction and each batch commits separately — holding the write lock
    // across model inference would block every other process sharing the db.
    const BATCH_SIZE = 32;
    for (let i = 0; i < missingConvos.length; i += BATCH_SIZE) {
      const batch = missingConvos.slice(i, i + BATCH_SIZE);
      const vecs = await embeddings.embedBatch(batch.map((r) => r.content));

      db.exec("BEGIN");
      try {
        for (let j = 0; j < batch.length; j++) {
          insertConvoVec.run(batch[j].id, serializeVector(vecs[j]));
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }

      if ((i + BATCH_SIZE) % 100 < BATCH_SIZE) {
        console.error(
          `[vector-memory-mcp]   ...${Math.min(i + BATCH_SIZE, missingConvos.length)}/${missingConvos.length} conversation chunks`,
        );
      }
    }

    console.error(
      `[vector-memory-mcp] Backfilled ${missingConvos.length} conversation vectors`,
    );
  }
}
