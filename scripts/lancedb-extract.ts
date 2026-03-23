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

/**
 * Read a value from an Arrow column at a given row index.
 * Arrow timestamp columns return BigInt — we convert to epoch-ms here
 * without going through Arrow's bigIntToNumber safety check.
 */
function columnValue(batch: any, colName: string, rowIdx: number): unknown {
  const col = batch.getChild(colName);
  if (!col) return undefined;
  return col.get(rowIdx);
}

function toEpochMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") {
    // Arrow timestamps are microseconds; convert to milliseconds.
    const ms = value / 1000n;
    return Number(ms);
  }
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

if (tableNames.includes("memories")) {
  const table = await db.openTable("memories");
  const total = await table.countRows();
  console.error(`Reading ${total} memories...`);

  // Use toArrow() to get raw Arrow RecordBatches, bypassing StructRow
  // property accessors that throw on BigInt timestamps.
  const arrowTable = await table.query().toArrow();
  for (const batch of arrowTable.batches) {
    for (let i = 0; i < batch.numRows; i++) {
      const lastAccessed = columnValue(batch, "last_accessed", i);
      result.memories.push({
        id: columnValue(batch, "id", i),
        content: columnValue(batch, "content", i),
        metadata: columnValue(batch, "metadata", i) ?? "{}",
        vector: toFloatArray(columnValue(batch, "vector", i)),
        created_at: toEpochMs(columnValue(batch, "created_at", i)),
        updated_at: toEpochMs(columnValue(batch, "updated_at", i)),
        last_accessed: lastAccessed != null ? toEpochMs(lastAccessed) : null,
        superseded_by: columnValue(batch, "superseded_by", i) ?? null,
        usefulness: columnValue(batch, "usefulness", i) ?? 0,
        access_count: columnValue(batch, "access_count", i) ?? 0,
      });
    }
  }
  console.error(`  ${result.memories.length} memories read`);
}

if (tableNames.includes("conversation_history")) {
  const table = await db.openTable("conversation_history");
  const total = await table.countRows();
  console.error(`Reading ${total} conversation chunks...`);

  const arrowTable = await table.query().toArrow();
  for (const batch of arrowTable.batches) {
    for (let i = 0; i < batch.numRows; i++) {
      result.conversations.push({
        id: columnValue(batch, "id", i),
        content: columnValue(batch, "content", i),
        metadata: columnValue(batch, "metadata", i) ?? "{}",
        vector: toFloatArray(columnValue(batch, "vector", i)),
        created_at: toEpochMs(columnValue(batch, "created_at", i)),
        session_id: columnValue(batch, "session_id", i),
        role: columnValue(batch, "role", i),
        message_index_start: columnValue(batch, "message_index_start", i) ?? 0,
        message_index_end: columnValue(batch, "message_index_end", i) ?? 0,
        project: columnValue(batch, "project", i) ?? "",
      });
    }
  }
  console.error(`  ${result.conversations.length} conversation chunks read`);
}

await db.close?.();
process.stdout.write(JSON.stringify(result));
