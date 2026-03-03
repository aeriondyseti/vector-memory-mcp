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
