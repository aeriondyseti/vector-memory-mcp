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

// Arrow TimeUnit enum → divisor to convert to milliseconds.
// 0=SECOND, 1=MILLISECOND, 2=MICROSECOND, 3=NANOSECOND
// Negative divisor = multiply (seconds → ms needs ×1000).
const TIME_UNIT_TO_MS_DIVISOR: Record<number, bigint> = {
  0: -1000n,   // seconds → ms (multiply by 1000)
  1: 1n,       // ms → no conversion
  2: 1000n,    // μs → ms
  3: 1000000n, // ns → ms
};

function buildTimestampDivisors(schema: any): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const field of schema.fields) {
    if (field.type.typeId === 10) {
      map.set(field.name, TIME_UNIT_TO_MS_DIVISOR[field.type.unit] ?? 1n);
    }
  }
  return map;
}

function columnValue(batch: any, colName: string, rowIdx: number): unknown {
  const col = batch.getChild(colName);
  if (!col) return undefined;
  try {
    return col.get(rowIdx);
  } catch {
    // Arrow's getter can throw on BigInt timestamps exceeding MAX_SAFE_INTEGER;
    // fall back to the raw typed array.
    let offset = rowIdx;
    for (const data of col.data) {
      if (offset < data.length) {
        return (data.values instanceof BigInt64Array || data.values instanceof BigUint64Array)
          ? data.values[offset]
          : null;
      }
      offset -= data.length;
    }
    return null;
  }
}

function toEpochMs(value: unknown, divisor: bigint = 1n): number {
  if (value == null) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") {
    if (divisor < 0n) return Number(value * -divisor);  // seconds → ms
    if (divisor === 1n) return Number(value);
    return Number(value / divisor);
  }
  if (typeof value === "number") {
    if (divisor < 0n) return value * Number(-divisor);
    if (divisor === 1n) return value;
    return Math.floor(value / Number(divisor));
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

const BATCH_SIZE = 100;
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

  // Paginated scan — query().toArrow() without offset/limit returns
  // non-deterministic results that can duplicate some rows and skip others.
  const schemaSample = await table.query().limit(1).toArrow();
  const tsDivisors = buildTimestampDivisors(schemaSample.schema);
  const seen = new Map<string, any>();

  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const arrowTable = await table.query().offset(offset).limit(BATCH_SIZE).toArrow();
    for (const batch of arrowTable.batches) {
      for (let i = 0; i < batch.numRows; i++) {
        const id = columnValue(batch, "id", i) as string;
        const content = columnValue(batch, "content", i) as string;
        const lastAccessed = columnValue(batch, "last_accessed", i);
        const accessedMs = lastAccessed != null ? toEpochMs(lastAccessed, tsDivisors.get("last_accessed")) : null;
        // Deduplicate by ID: prefer most recently accessed, then longest content.
        const existing = seen.get(id);
        if (existing) {
          const existingAccess = existing.last_accessed ?? 0;
          const newAccess = accessedMs ?? 0;
          if (newAccess < existingAccess) continue;
          if (newAccess === existingAccess && content.length <= existing.content.length) continue;
        }
        seen.set(id, {
          id,
          content,
          metadata: columnValue(batch, "metadata", i) ?? "{}",
          vector: toFloatArray(columnValue(batch, "vector", i)),
          created_at: toEpochMs(columnValue(batch, "created_at", i), tsDivisors.get("created_at")),
          updated_at: toEpochMs(columnValue(batch, "updated_at", i), tsDivisors.get("updated_at")),
          last_accessed: accessedMs,
          superseded_by: columnValue(batch, "superseded_by", i) ?? null,
          usefulness: columnValue(batch, "usefulness", i) ?? 0,
          access_count: columnValue(batch, "access_count", i) ?? 0,
        });
      }
    }
  }
  result.memories = [...seen.values()];
  console.error(`  ${result.memories.length} unique memories read (${total} rows scanned)`);
}

if (tableNames.includes("conversation_history")) {
  const table = await db.openTable("conversation_history");
  const total = await table.countRows();
  console.error(`Reading ${total} conversation chunks...`);

  const schemaSample = await table.query().limit(1).toArrow();
  const tsDivisors = buildTimestampDivisors(schemaSample.schema);
  const seen = new Map<string, any>();

  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const arrowTable = await table.query().offset(offset).limit(BATCH_SIZE).toArrow();
    for (const batch of arrowTable.batches) {
      for (let i = 0; i < batch.numRows; i++) {
        const id = columnValue(batch, "id", i) as string;
        const content = columnValue(batch, "content", i) as string;
        const existing = seen.get(id);
        if (existing && existing.content.length >= content.length) continue;
        seen.set(id, {
          id,
          content,
          metadata: columnValue(batch, "metadata", i) ?? "{}",
          vector: toFloatArray(columnValue(batch, "vector", i)),
          created_at: toEpochMs(columnValue(batch, "created_at", i), tsDivisors.get("created_at")),
          session_id: columnValue(batch, "session_id", i),
          role: columnValue(batch, "role", i),
          message_index_start: columnValue(batch, "message_index_start", i) ?? 0,
          message_index_end: columnValue(batch, "message_index_end", i) ?? 0,
          project: columnValue(batch, "project", i) ?? "",
        });
      }
    }
  }
  result.conversations = [...seen.values()];
  console.error(`  ${result.conversations.length} unique conversation chunks read (${total} rows scanned)`);
}

await db.close?.();
process.stdout.write(JSON.stringify(result));
