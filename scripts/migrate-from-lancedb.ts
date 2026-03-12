#!/usr/bin/env bun
/**
 * Migration script: LanceDB → SQLite (sqlite-vec)
 *
 * Reads all data from an existing LanceDB directory and writes it into
 * a new SQLite database. Run once after upgrading to the sqlite-vec backend.
 *
 * Usage:
 *   bun scripts/migrate-from-lancedb.ts [--source <lancedb-dir>] [--target <sqlite-file>]
 *
 * Defaults:
 *   --source  .vector-memory/memories.db   (the old LanceDB directory)
 *   --target  .vector-memory/memories.db.sqlite  (new SQLite file)
 *
 * After verifying the migration:
 *   mv .vector-memory/memories.db .vector-memory/memories.db.lance-backup
 *   mv .vector-memory/memories.db.sqlite .vector-memory/memories.db
 */

import * as lancedb from "@lancedb/lancedb";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync, existsSync, statSync } from "fs";
import { dirname } from "path";
import { runMigrations } from "../src/db/migrations.js";
import { serializeVector } from "../src/db/sqlite-utils.js";

// ── CLI args ────────────────────────────────────────────────────────

function parseArgs(): { source: string; target: string } {
  const args = process.argv.slice(2);
  let source = ".vector-memory/memories.db";
  let target = ".vector-memory/memories.db.sqlite";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) source = args[++i];
    else if (args[i] === "--target" && args[i + 1]) target = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: bun scripts/migrate-from-lancedb.ts [options]

Options:
  --source <path>  LanceDB directory (default: .vector-memory/memories.db)
  --target <path>  SQLite output file (default: .vector-memory/memories.db.sqlite)
  --help           Show this help
`);
      process.exit(0);
    }
  }

  return { source, target };
}

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

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const { source, target } = parseArgs();

  // Validate source
  if (!existsSync(source)) {
    console.error(`❌ Source not found: ${source}`);
    process.exit(1);
  }
  if (!statSync(source).isDirectory()) {
    console.error(`❌ Source is not a directory (expected LanceDB): ${source}`);
    process.exit(1);
  }

  // Prevent overwriting
  if (existsSync(target)) {
    console.error(`❌ Target already exists: ${target}`);
    console.error(`   Delete it first or choose a different --target`);
    process.exit(1);
  }

  console.log(`📂 Source (LanceDB): ${source}`);
  console.log(`📄 Target (SQLite):  ${target}`);
  console.log();

  // Open LanceDB
  const lanceDb = await lancedb.connect(source);
  const tableNames = await lanceDb.tableNames();
  console.log(`Found tables: ${tableNames.join(", ")}`);

  // Open SQLite
  mkdirSync(dirname(target), { recursive: true });
  const sqliteDb = new Database(target);
  sqliteDb.exec("PRAGMA journal_mode=WAL");
  sqliteVec.load(sqliteDb);
  runMigrations(sqliteDb);

  // ── Migrate memories ──────────────────────────────────────────────

  if (tableNames.includes("memories")) {
    const memoriesTable = await lanceDb.openTable("memories");
    const totalMemories = await memoriesTable.countRows();
    console.log(`\n🧠 Migrating ${totalMemories} memories...`);

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

    // Stream in batches to handle large datasets
    const BATCH_SIZE = 500;
    let offset = 0;
    let migrated = 0;

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
      migrated += rows.length;
      offset += BATCH_SIZE;

      if (totalMemories > BATCH_SIZE) {
        process.stdout.write(`   ${migrated}/${totalMemories}\r`);
      }
    }

    console.log(`   ✅ ${migrated} memories migrated`);
  }

  // ── Migrate conversation history ──────────────────────────────────

  if (tableNames.includes("conversation_history")) {
    const convTable = await lanceDb.openTable("conversation_history");
    const totalConv = await convTable.countRows();
    console.log(`\n💬 Migrating ${totalConv} conversation chunks...`);

    const insertMain = sqliteDb.prepare(
      `INSERT OR REPLACE INTO conversation_history
        (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const deleteVec = sqliteDb.prepare(
      `DELETE FROM conversation_history_vec WHERE id = ?`
    );
    const insertVec = sqliteDb.prepare(
      `INSERT INTO conversation_history_vec (id, vector) VALUES (?, ?)`
    );
    const deleteFts = sqliteDb.prepare(
      `DELETE FROM conversation_history_fts WHERE id = ?`
    );
    const insertFts = sqliteDb.prepare(
      `INSERT INTO conversation_history_fts (id, content) VALUES (?, ?)`
    );

    const BATCH_SIZE = 500;
    let offset = 0;
    let migrated = 0;

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
            deleteVec.run(row.id);
            insertVec.run(row.id, serializeVector(vec));
            deleteFts.run(row.id);
            insertFts.run(row.id, row.content);
          }
        }
      });

      tx();
      migrated += rows.length;
      offset += BATCH_SIZE;

      if (totalConv > BATCH_SIZE) {
        process.stdout.write(`   ${migrated}/${totalConv}\r`);
      }
    }

    console.log(`   ✅ ${migrated} conversation chunks migrated`);
  }

  // ── Summary ───────────────────────────────────────────────────────

  sqliteDb.close();

  const { size } = statSync(target);
  const sizeMB = (size / 1024 / 1024).toFixed(2);

  console.log(`
✅ Migration complete!
   Output: ${target} (${sizeMB} MB)

Next steps:
   1. Verify: bun scripts/migrate-from-lancedb.ts --help
   2. Backup:  mv ${source} ${source}.lance-backup
   3. Activate: mv ${target} ${source}
   4. Restart your MCP server
`);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err.message ?? err);
  process.exit(1);
});
