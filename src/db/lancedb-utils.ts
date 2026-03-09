import * as lancedb from "@lancedb/lancedb";
import { Index, type Table } from "@lancedb/lancedb";
import type { Schema } from "apache-arrow";

/**
 * Converts LanceDB's Arrow Vector type to a plain number[].
 * LanceDB returns an Arrow Vector object which is iterable but not an array.
 */
export function arrowVectorToArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value
    : (Array.from(value as Iterable<number>) as number[]);
}

/**
 * Opens an existing table or creates it with the given schema.
 * Does NOT cache — callers should cache the returned Table if desired.
 */
export async function getOrCreateTable(
  db: lancedb.Connection,
  name: string,
  schema: Schema
): Promise<Table> {
  const names = await db.tableNames();
  if (names.includes(name)) {
    return await db.openTable(name);
  }
  return await db.createTable(name, [], { schema });
}

/**
 * Creates a mutex-guarded function that ensures an FTS index exists on a table's content column.
 *
 * Once the FTS index is confirmed/created, the promise is retained for the lifetime of the
 * caller — the index persists in LanceDB, so re-checking is unnecessary. On error, the
 * mutex resets so the next call can retry.
 *
 * The key design constraint: the promise must be captured synchronously (before any await)
 * to prevent concurrent callers from racing past the guard.
 */
export function createFtsMutex(
  getTable: () => Promise<Table>
): () => Promise<void> {
  let promise: Promise<void> | null = null;

  return () => {
    if (promise) return promise;

    promise = (async () => {
      const table = await getTable();
      const indices = await table.listIndices();
      const hasFtsIndex = indices.some(
        (idx) => idx.columns.includes("content") && idx.indexType === "FTS"
      );

      if (!hasFtsIndex) {
        await table.createIndex("content", {
          config: Index.fts(),
        });
        await table.waitForIndex(["content_idx"], 30);
      }
    })().catch((error) => {
      promise = null;
      throw error;
    });

    return promise;
  };
}
