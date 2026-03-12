/**
 * LanceDB → SQLite (sqlite-vec) migration logic.
 *
 * This module is the shared core used by both the `migrate` subcommand
 * and the standalone `scripts/migrate-from-lancedb.ts` script.
 *
 * @deprecated Will be removed in the next major version once LanceDB
 *   support is dropped.
 */

import { existsSync, statSync } from "fs";
import { connectToDatabase } from "./db/connection.js";
import { serializeVector } from "./db/sqlite-utils.js";

// ── Helpers ─────────────────────────────────────────────────────────

function toEpochMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  return Date.now();
}

function toFloatArray(vec: unknown): number[] {
  if (Array.isArray(vec)) return vec;
  if (vec instanceof Float32Array) return Array.from(vec);
  // Arrow Vector objects have a .toArray() method that returns Float32Array
  if (vec && typeof (vec as any).toArray === "function") {
    return Array.from((vec as any).toArray());
  }
  if (ArrayBuffer.isView(vec)) return Array.from(new Float32Array((vec as DataView).buffer));
  return [];
}

// ── Detection ───────────────────────────────────────────────────────

/**
 * Check if a path is a LanceDB directory (i.e. needs migration).
 * Returns true if the path exists and is a directory.
 */
export function isLanceDbDirectory(dbPath: string): boolean {
  return existsSync(dbPath) && statSync(dbPath).isDirectory();
}

// ── Migration ───────────────────────────────────────────────────────

export interface MigrateOptions {
  /** Path to the LanceDB directory (source). */
  source: string;
  /** Path to the new SQLite file (target). */
  target: string;
}

export interface MigrateResult {
  memoriesMigrated: number;
  conversationChunksMigrated: number;
  outputSizeMB: string;
}

/**
 * Run the full LanceDB → SQLite migration.
 *
 * Dynamically imports @lancedb/lancedb so the cost is only paid
 * when the migration is actually invoked.
 */
export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const { source, target } = opts;

  // Validate source
  if (!existsSync(source)) {
    throw new Error(`Source not found: ${source}`);
  }
  if (!statSync(source).isDirectory()) {
    throw new Error(`Source is not a directory (expected LanceDB): ${source}`);
  }

  // Prevent overwriting
  if (existsSync(target)) {
    throw new Error(
      `Target already exists: ${target}\n   Delete it first or choose a different target path.`
    );
  }

  console.error(`📂 Source (LanceDB): ${source}`);
  console.error(`📄 Target (SQLite):  ${target}`);
  console.error();

  // Dynamic import — only loads LanceDB when migration is actually run
  const lancedb = await import("@lancedb/lancedb");

  // Open LanceDB
  const lanceDb = await lancedb.connect(source);
  const tableNames = await lanceDb.tableNames();
  console.error(`Found tables: ${tableNames.join(", ")}`);

  // Open SQLite (reuses shared connection setup: WAL, sqlite-vec, migrations)
  const sqliteDb = connectToDatabase(target);

  let memoriesMigrated = 0;
  let conversationChunksMigrated = 0;

  // ── Migrate memories ────────────────────────────────────────────
  if (tableNames.includes("memories")) {
    const memoriesTable = await lanceDb.openTable("memories");
    const totalMemories = await memoriesTable.countRows();
    console.error(`\n🧠 Migrating ${totalMemories} memories...`);

    const insertMain = sqliteDb.prepare(
      `INSERT OR REPLACE INTO memories
        (id, content, metadata, created_at, updated_at, superseded_by, usefulness, access_count, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertVec = sqliteDb.prepare(
      `INSERT INTO memories_vec (id, vector) VALUES (?, ?)`
    );
    const insertFts = sqliteDb.prepare(
      `INSERT INTO memories_fts (id, content) VALUES (?, ?)`
    );

    const BATCH_SIZE = 500;
    let offset = 0;

    while (true) {
      const rows = await memoriesTable.query().limit(BATCH_SIZE).offset(offset).toArray();
      if (rows.length === 0) break;

      const tx = sqliteDb.transaction(() => {
        for (const row of rows) {
          const vec = toFloatArray(row.vector);
          const createdAt = toEpochMs(row.created_at);
          const updatedAt = toEpochMs(row.updated_at);
          const lastAccessed = row.last_accessed != null ? toEpochMs(row.last_accessed) : null;

          insertMain.run(
            row.id,
            row.content,
            row.metadata ?? "{}",
            createdAt,
            updatedAt,
            row.superseded_by ?? null,
            row.usefulness ?? 0,
            row.access_count ?? 0,
            lastAccessed,
          );

          if (vec.length > 0) {
            insertVec.run(row.id, serializeVector(vec));
          }

          insertFts.run(row.id, row.content);
        }
      });

      tx();
      memoriesMigrated += rows.length;
      offset += BATCH_SIZE;

      if (totalMemories > BATCH_SIZE) {
        process.stderr.write(`   ${memoriesMigrated}/${totalMemories}\r`);
      }
    }

    console.error(`   ✅ ${memoriesMigrated} memories migrated`);
  }

  // ── Migrate conversation history ────────────────────────────────
  if (tableNames.includes("conversation_history")) {
    const convTable = await lanceDb.openTable("conversation_history");
    const totalConv = await convTable.countRows();
    console.error(`\n💬 Migrating ${totalConv} conversation chunks...`);

    const insertMain = sqliteDb.prepare(
      `INSERT OR REPLACE INTO conversation_history
        (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertVec = sqliteDb.prepare(
      `INSERT INTO conversation_history_vec (id, vector) VALUES (?, ?)`
    );
    const insertFts = sqliteDb.prepare(
      `INSERT INTO conversation_history_fts (id, content) VALUES (?, ?)`
    );

    const BATCH_SIZE = 500;
    let offset = 0;

    while (true) {
      const rows = await convTable.query().limit(BATCH_SIZE).offset(offset).toArray();
      if (rows.length === 0) break;

      const tx = sqliteDb.transaction(() => {
        for (const row of rows) {
          const vec = toFloatArray(row.vector);
          const createdAt = toEpochMs(row.created_at);

          insertMain.run(
            row.id,
            row.content,
            row.metadata ?? "{}",
            createdAt,
            row.session_id,
            row.role,
            row.message_index_start ?? 0,
            row.message_index_end ?? 0,
            row.project ?? "",
          );

          if (vec.length > 0) {
            insertVec.run(row.id, serializeVector(vec));
          }

          insertFts.run(row.id, row.content);
        }
      });

      tx();
      conversationChunksMigrated += rows.length;
      offset += BATCH_SIZE;

      if (totalConv > BATCH_SIZE) {
        process.stderr.write(`   ${conversationChunksMigrated}/${totalConv}\r`);
      }
    }

    console.error(`   ✅ ${conversationChunksMigrated} conversation chunks migrated`);
  }

  // ── Finalize ────────────────────────────────────────────────────
  sqliteDb.close();

  const { size } = statSync(target);
  const outputSizeMB = (size / 1024 / 1024).toFixed(2);

  return { memoriesMigrated, conversationChunksMigrated, outputSizeMB };
}

/**
 * Format a human-readable summary after migration completes.
 */
export function formatMigrationSummary(
  source: string,
  target: string,
  result: MigrateResult,
): string {
  return `
✅ Migration complete! (${result.outputSizeMB} MB)
   ${result.memoriesMigrated} memories, ${result.conversationChunksMigrated} conversation chunks

Next steps:
   1. Backup:   mv ${source} ${source}.lance-backup
   2. Activate: mv ${target} ${source}
   3. Restart your MCP server
`;
}
