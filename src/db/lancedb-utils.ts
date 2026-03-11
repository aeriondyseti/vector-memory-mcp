import * as lancedb from "@lancedb/lancedb";
import { Index, rerankers, type Table } from "@lancedb/lancedb";
import type { Schema } from "apache-arrow";

/**
 * Escape a string value for safe interpolation into LanceDB/DataFusion SQL WHERE clauses.
 *
 * DataFusion uses ANSI SQL string literal rules:
 * - String literals are delimited by single quotes
 * - Single quotes within strings are escaped by doubling: ' -> ''
 * - Backslashes are NOT escape characters (treated literally)
 */
export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/** Default k parameter for Reciprocal Rank Fusion reranking. */
export const RRF_K = 60;

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
 * Safely parse a JSON string into an object, returning an empty object on failure.
 */
export function safeParseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
  try {
    return await db.openTable(name);
  } catch (err: unknown) {
    // Only proceed to create if the table was not found
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("was not found") && !message.includes("does not exist")) {
      throw err;
    }
  }
  try {
    return await db.createTable(name, [], { schema });
  } catch {
    // Another caller may have created it concurrently
    return await db.openTable(name);
  }
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

/**
 * Creates a promise-mutex for RRFReranker instantiation.
 * Same pattern as createFtsMutex: create once, cache forever, reset on error.
 */
export function createRerankerMutex(
  k: number = RRF_K
): () => Promise<rerankers.RRFReranker> {
  let promise: Promise<rerankers.RRFReranker> | null = null;

  return () => {
    if (!promise) {
      promise = rerankers.RRFReranker.create(k).catch((e) => {
        promise = null;
        throw e;
      });
    }
    return promise;
  };
}
