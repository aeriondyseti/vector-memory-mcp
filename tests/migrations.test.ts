import { describe, expect, test, beforeEach, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, backfillVectors } from "../server/core/migrations";
import { serializeVector } from "../server/core/sqlite-utils";
import { createMockEmbeddings, EMBEDDING_DIM } from "./utils/test-helpers";
import type { EmbeddingsService } from "../server/core/embeddings.service";

describe("runMigrations", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  test("creates expected tables on a fresh database", () => {
    runMigrations(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'table')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memories_vec");
    expect(tableNames).toContain("conversation_history");
    expect(tableNames).toContain("conversation_history_vec");

    // FTS5 tables are virtual tables; check sqlite_master for them
    const allEntries = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE name IN (
          'memories_fts', 'conversation_history_fts'
        )`,
      )
      .all() as Array<{ name: string }>;

    const allNames = allEntries.map((t) => t.name);
    expect(allNames).toContain("memories_fts");
    expect(allNames).toContain("conversation_history_fts");
  });

  test("memories table has expected columns", () => {
    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("content");
    expect(colNames).toContain("metadata");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("superseded_by");
    expect(colNames).toContain("usefulness");
    expect(colNames).toContain("access_count");
    expect(colNames).toContain("last_accessed");
  });

  test("conversation_history table has expected columns", () => {
    runMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info(conversation_history)")
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("content");
    expect(colNames).toContain("metadata");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("role");
    expect(colNames).toContain("message_index_start");
    expect(colNames).toContain("message_index_end");
    expect(colNames).toContain("project");
  });

  test("creates indexes on conversation_history", () => {
    runMigrations(db);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'conversation_history'`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_conversation_session_id");
    expect(indexNames).toContain("idx_conversation_project");
    expect(indexNames).toContain("idx_conversation_role");
    expect(indexNames).toContain("idx_conversation_created_at");
  });

  test("is idempotent — calling twice causes no errors", () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    // Verify tables still exist and are functional
    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM memories")
      .get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  test("is idempotent — schema unchanged after second call", () => {
    runMigrations(db);

    const schemaFirst = db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();

    runMigrations(db);

    const schemaSecond = db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();

    expect(schemaSecond).toEqual(schemaFirst);
  });
});

describe("backfillVectors", () => {
  let db: Database;
  let embeddings: EmbeddingsService;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    embeddings = createMockEmbeddings();
  });

  test("handles empty database — no errors", async () => {
    await expect(backfillVectors(db, embeddings)).resolves.toBeUndefined();

    // embed should not have been called
    expect(embeddings.embedBatch).not.toHaveBeenCalled();
  });

  test("detects and fills missing memory vectors", async () => {
    // Insert a memory row WITHOUT a corresponding vector
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("mem-1", "TypeScript is great", '{"type":"note"}', now, now);

    // Confirm no vector exists yet
    const beforeCount = db
      .prepare("SELECT COUNT(*) as cnt FROM memories_vec")
      .get() as { cnt: number };
    expect(beforeCount.cnt).toBe(0);

    await backfillVectors(db, embeddings);

    // Vector should now exist
    const afterCount = db
      .prepare("SELECT COUNT(*) as cnt FROM memories_vec")
      .get() as { cnt: number };
    expect(afterCount.cnt).toBe(1);

    const row = db
      .prepare("SELECT id, vector FROM memories_vec WHERE id = ?")
      .get("mem-1") as { id: string; vector: Buffer };
    expect(row.id).toBe("mem-1");
    expect(row.vector.byteLength).toBe(EMBEDDING_DIM * 4); // float32 = 4 bytes

    expect(embeddings.embedBatch).toHaveBeenCalledTimes(1);
  });

  test("detects and fills missing conversation vectors", async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO conversation_history
       (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("conv-1", "Hello world", "{}", now, "sess-1", "user", 0, 1, "/project");

    const beforeCount = db
      .prepare("SELECT COUNT(*) as cnt FROM conversation_history_vec")
      .get() as { cnt: number };
    expect(beforeCount.cnt).toBe(0);

    await backfillVectors(db, embeddings);

    const afterCount = db
      .prepare("SELECT COUNT(*) as cnt FROM conversation_history_vec")
      .get() as { cnt: number };
    expect(afterCount.cnt).toBe(1);

    const row = db
      .prepare("SELECT id, vector FROM conversation_history_vec WHERE id = ?")
      .get("conv-1") as { id: string; vector: Buffer };
    expect(row.id).toBe("conv-1");
    expect(row.vector.byteLength).toBe(EMBEDDING_DIM * 4);
  });

  test("is a no-op when all vectors are present", async () => {
    const now = Date.now();
    const fakeVec = serializeVector(new Array(EMBEDDING_DIM).fill(0.5));

    // Insert memory with its vector
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("mem-1", "Already embedded content", '{"type":"note"}', now, now);

    db.prepare(
      `INSERT INTO memories_vec (id, vector) VALUES (?, ?)`,
    ).run("mem-1", fakeVec);

    await backfillVectors(db, embeddings);

    // embedBatch should not have been called
    expect(embeddings.embedBatch).not.toHaveBeenCalled();

    // Vector should be unchanged
    const row = db
      .prepare("SELECT vector FROM memories_vec WHERE id = ?")
      .get("mem-1") as { vector: Buffer };
    expect(Buffer.from(row.vector).equals(fakeVec)).toBe(true);
  });

  test("skips waypoints with zero vectors", async () => {
    const now = Date.now();

    // Insert a waypoint memory (type = "waypoint") without a vector
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("wp-1", "Waypoint: checkpoint alpha", '{"type":"waypoint"}', now, now);

    await backfillVectors(db, embeddings);

    // embedBatch should NOT have been called (waypoints get zero vectors, not real embeddings)
    expect(embeddings.embedBatch).not.toHaveBeenCalled();

    // The vector should exist but be all zeros
    const row = db
      .prepare("SELECT vector FROM memories_vec WHERE id = ?")
      .get("wp-1") as { vector: Buffer };
    expect(row).toBeDefined();

    const floats = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength / 4,
    );
    expect(floats.length).toBe(EMBEDDING_DIM);
    expect(floats.every((v) => v === 0)).toBe(true);
  });

  test("backfills mixed waypoints and regular memories in one pass", async () => {
    const now = Date.now();

    // A waypoint
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("wp-1", "Waypoint content", '{"type":"waypoint"}', now, now);

    // A regular memory
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("mem-1", "Regular memory content", '{"type":"note"}', now, now);

    // A second regular memory
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("mem-2", "Another memory", '{}', now, now);

    await backfillVectors(db, embeddings);

    // All three should have vectors
    const vecCount = db
      .prepare("SELECT COUNT(*) as cnt FROM memories_vec")
      .get() as { cnt: number };
    expect(vecCount.cnt).toBe(3);

    // embedBatch called once with the 2 non-waypoint texts
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(1);
    const callArgs = (embeddings.embedBatch as ReturnType<typeof import("bun:test").mock>).mock.calls[0];
    expect(callArgs[0]).toHaveLength(2);

    // Waypoint vector should be all zeros
    const wpRow = db
      .prepare("SELECT vector FROM memories_vec WHERE id = ?")
      .get("wp-1") as { vector: Buffer };
    const wpFloats = new Float32Array(
      wpRow.vector.buffer,
      wpRow.vector.byteOffset,
      wpRow.vector.byteLength / 4,
    );
    expect(wpFloats.every((v) => v === 0)).toBe(true);

    // Regular memory vectors should be non-zero (random from mock)
    const memRow = db
      .prepare("SELECT vector FROM memories_vec WHERE id = ?")
      .get("mem-1") as { vector: Buffer };
    const memFloats = new Float32Array(
      memRow.vector.buffer,
      memRow.vector.byteOffset,
      memRow.vector.byteLength / 4,
    );
    expect(memFloats.some((v) => v !== 0)).toBe(true);
  });

  test("backfills both memories and conversations simultaneously", async () => {
    const now = Date.now();

    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("mem-1", "Memory content", '{}', now, now);

    db.prepare(
      `INSERT INTO conversation_history
       (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("conv-1", "Conversation content", "{}", now, "sess-1", "user", 0, 1, "/project");

    await backfillVectors(db, embeddings);

    const memVecCount = db
      .prepare("SELECT COUNT(*) as cnt FROM memories_vec")
      .get() as { cnt: number };
    expect(memVecCount.cnt).toBe(1);

    const convVecCount = db
      .prepare("SELECT COUNT(*) as cnt FROM conversation_history_vec")
      .get() as { cnt: number };
    expect(convVecCount.cnt).toBe(1);

    // embedBatch called twice: once for memories, once for conversations
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(2);
  });

  test("handles zero-length vectors as missing (re-embeds them)", async () => {
    const now = Date.now();

    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("mem-1", "Content with empty vector", '{}', now, now);

    // Insert an empty blob (length 0) — the backfill should treat this as missing
    db.prepare(
      `INSERT INTO memories_vec (id, vector) VALUES (?, ?)`,
    ).run("mem-1", Buffer.alloc(0));

    await backfillVectors(db, embeddings);

    // Should have been re-embedded
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(1);

    const row = db
      .prepare("SELECT vector FROM memories_vec WHERE id = ?")
      .get("mem-1") as { vector: Buffer };
    expect(row.vector.byteLength).toBe(EMBEDDING_DIM * 4);
  });
});
