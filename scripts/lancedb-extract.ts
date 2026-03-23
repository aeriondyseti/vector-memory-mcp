#!/usr/bin/env bun
/**
 * Standalone LanceDB data extractor — runs in a child process so that
 * @lancedb/lancedb native bindings never coexist with bun:sqlite's
 * extension loading in the same process.
 *
 * Usage: bun scripts/lancedb-extract.ts <lance-db-path>
 * Output: JSON on stdout — { memories: Row[], conversations: Row[] }
 */

const source = process.argv[2];
if (!source) {
  console.error("Usage: bun scripts/lancedb-extract.ts <lance-db-path>");
  process.exit(1);
}

function toEpochMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  return Date.now();
}

function toFloatArray(vec: unknown): number[] {
  if (Array.isArray(vec)) return vec;
  if (vec instanceof Float32Array) return Array.from(vec);
  if (vec && typeof (vec as any).toArray === "function") {
    return Array.from((vec as any).toArray());
  }
  if (ArrayBuffer.isView(vec)) {
    const view = vec as DataView;
    return Array.from(new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4));
  }
  return [];
}

const lancedb = await import("@lancedb/lancedb");
const db = await lancedb.connect(source);
const tableNames = await db.tableNames();
console.error(`Found tables: ${tableNames.join(", ")}`);

const result: { memories: any[]; conversations: any[] } = {
  memories: [],
  conversations: [],
};

const BATCH_SIZE = 500;

if (tableNames.includes("memories")) {
  const table = await db.openTable("memories");
  const total = await table.countRows();
  console.error(`Reading ${total} memories...`);

  let offset = 0;
  while (true) {
    const rows = await table.query().limit(BATCH_SIZE).offset(offset).toArray();
    if (rows.length === 0) break;
    for (const row of rows) {
      result.memories.push({
        id: row.id,
        content: row.content,
        metadata: row.metadata ?? "{}",
        vector: toFloatArray(row.vector),
        created_at: toEpochMs(row.created_at),
        updated_at: toEpochMs(row.updated_at),
        last_accessed: row.last_accessed != null ? toEpochMs(row.last_accessed) : null,
        superseded_by: row.superseded_by ?? null,
        usefulness: row.usefulness ?? 0,
        access_count: row.access_count ?? 0,
      });
    }
    offset += BATCH_SIZE;
  }
  console.error(`  ${result.memories.length} memories read`);
}

if (tableNames.includes("conversation_history")) {
  const table = await db.openTable("conversation_history");
  const total = await table.countRows();
  console.error(`Reading ${total} conversation chunks...`);

  let offset = 0;
  while (true) {
    const rows = await table.query().limit(BATCH_SIZE).offset(offset).toArray();
    if (rows.length === 0) break;
    for (const row of rows) {
      result.conversations.push({
        id: row.id,
        content: row.content,
        metadata: row.metadata ?? "{}",
        vector: toFloatArray(row.vector),
        created_at: toEpochMs(row.created_at),
        session_id: row.session_id,
        role: row.role,
        message_index_start: row.message_index_start ?? 0,
        message_index_end: row.message_index_end ?? 0,
        project: row.project ?? "",
      });
    }
    offset += BATCH_SIZE;
  }
  console.error(`  ${result.conversations.length} conversation chunks read`);
}

await db.close?.();
process.stdout.write(JSON.stringify(result));
