/**
 * LanceDB -> SQLite migration logic.
 *
 * Reads LanceDB data in a child process (scripts/lancedb-extract.ts) to avoid
 * a native symbol collision between @lancedb/lancedb and bun:sqlite.
 * The extracted JSON is then written to SQLite in-process.
 *
 * @deprecated Will be removed in the next major version once LanceDB
 *   support is dropped.
 */

import { existsSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { connectToDatabase } from "./db/connection.js";
import { serializeVector } from "./db/sqlite-utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Detection ───────────────────────────────────────────────────────

export function isLanceDbDirectory(dbPath: string): boolean {
  return existsSync(dbPath) && statSync(dbPath).isDirectory();
}

// ── Types ───────────────────────────────────────────────────────────

export interface MigrateOptions {
  source: string;
  target: string;
}

export interface MigrateResult {
  memoriesMigrated: number;
  conversationChunksMigrated: number;
  outputSizeMB: string;
}

interface ExtractedData {
  memories: Array<{
    id: string;
    content: string;
    metadata: string;
    vector: number[];
    created_at: number;
    updated_at: number;
    last_accessed: number | null;
    superseded_by: string | null;
    usefulness: number;
    access_count: number;
  }>;
  conversations: Array<{
    id: string;
    content: string;
    metadata: string;
    vector: number[];
    created_at: number;
    session_id: string;
    role: string;
    message_index_start: number;
    message_index_end: number;
    project: string;
  }>;
}

// ── Migration ───────────────────────────────────────────────────────

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const { source, target } = opts;

  if (!existsSync(source)) {
    throw new Error(`Source not found: ${source}`);
  }
  if (!statSync(source).isDirectory()) {
    throw new Error(`Source is not a directory (expected LanceDB): ${source}`);
  }
  if (existsSync(target)) {
    throw new Error(
      `Target already exists: ${target}\n   Delete it first or choose a different target path.`
    );
  }

  console.error(`📂 Source (LanceDB): ${source}`);
  console.error(`📄 Target (SQLite):  ${target}`);
  console.error();

  // Phase 1: Extract data from LanceDB in a subprocess.
  // This avoids a native symbol collision between @lancedb/lancedb and bun:sqlite.
  const extractScript = resolve(__dirname, "..", "scripts", "lancedb-extract.ts");
  const proc = Bun.spawn(["bun", extractScript, source], {
    stdout: "pipe",
    stderr: "inherit",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`LanceDB extraction failed (exit code ${exitCode})`);
  }

  const data: ExtractedData = JSON.parse(output);

  // Phase 2: Write to SQLite (no LanceDB in this process).
  const sqliteDb = connectToDatabase(target);

  let memoriesMigrated = 0;
  let conversationChunksMigrated = 0;

  if (data.memories.length > 0) {
    console.error(`\n🧠 Writing ${data.memories.length} memories to SQLite...`);

    const insertMain = sqliteDb.prepare(
      `INSERT OR REPLACE INTO memories
        (id, content, metadata, created_at, updated_at, superseded_by, usefulness, access_count, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const deleteVec = sqliteDb.prepare(`DELETE FROM memories_vec WHERE id = ?`);
    const insertVec = sqliteDb.prepare(
      `INSERT INTO memories_vec (id, vector) VALUES (?, ?)`
    );
    const insertFts = sqliteDb.prepare(
      `INSERT OR REPLACE INTO memories_fts (id, content) VALUES (?, ?)`
    );

    const tx = sqliteDb.transaction(() => {
      for (const row of data.memories) {
        insertMain.run(
          row.id, row.content, row.metadata,
          row.created_at, row.updated_at,
          row.superseded_by, row.usefulness,
          row.access_count, row.last_accessed,
        );
        if (row.vector.length > 0) {
          deleteVec.run(row.id);
          insertVec.run(row.id, serializeVector(row.vector));
        }
        insertFts.run(row.id, row.content);
      }
    });
    tx();
    memoriesMigrated = data.memories.length;
    console.error(`   ✅ ${memoriesMigrated} memories migrated`);
  }

  if (data.conversations.length > 0) {
    console.error(`\n💬 Writing ${data.conversations.length} conversation chunks to SQLite...`);

    const insertMain = sqliteDb.prepare(
      `INSERT OR REPLACE INTO conversation_history
        (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const deleteVec = sqliteDb.prepare(`DELETE FROM conversation_history_vec WHERE id = ?`);
    const insertVec = sqliteDb.prepare(
      `INSERT INTO conversation_history_vec (id, vector) VALUES (?, ?)`
    );
    const insertFts = sqliteDb.prepare(
      `INSERT OR REPLACE INTO conversation_history_fts (id, content) VALUES (?, ?)`
    );

    const tx = sqliteDb.transaction(() => {
      for (const row of data.conversations) {
        insertMain.run(
          row.id, row.content, row.metadata,
          row.created_at, row.session_id, row.role,
          row.message_index_start, row.message_index_end, row.project,
        );
        if (row.vector.length > 0) {
          deleteVec.run(row.id);
          insertVec.run(row.id, serializeVector(row.vector));
        }
        insertFts.run(row.id, row.content);
      }
    });
    tx();
    conversationChunksMigrated = data.conversations.length;
    console.error(`   ✅ ${conversationChunksMigrated} conversation chunks migrated`);
  }

  sqliteDb.close();

  const { size } = statSync(target);
  const outputSizeMB = (size / 1024 / 1024).toFixed(2);

  return { memoriesMigrated, conversationChunksMigrated, outputSizeMB };
}

export function formatMigrationSummary(
  source: string,
  target: string,
  result: MigrateResult,
): string {
  return `
✅ Migration complete! (${result.outputSizeMB} MB)
   ${result.memoriesMigrated} memories, ${result.conversationChunksMigrated} conversation chunks

Next steps:
   1. Backup:   mv "${source}" "${source}.lance-backup"
   2. Activate: mv "${target}" "${source}"
   3. Restart your MCP server
`;
}
