#!/usr/bin/env bun
/**
 * Standalone migration script: LanceDB → SQLite (sqlite-vec)
 *
 * This is a thin wrapper around server/migration.ts for direct invocation.
 * The preferred way to migrate is `vector-memory-mcp migrate`.
 *
 * Usage:
 *   bun scripts/migrate-from-lancedb.ts [--source <lancedb-dir>] [--target <sqlite-file>]
 *
 * Defaults:
 *   --source  .vector-memory/memories.db        (the old LanceDB directory)
 *   --target  .vector-memory/memories.db.sqlite  (new SQLite file)
 *
 * @deprecated Use `vector-memory-mcp migrate` instead. This script will be
 *   removed in the next major version.
 */

import { migrate, formatMigrationSummary } from "../server/migration.js";

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

  Prefer: vector-memory-mcp migrate

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

async function main() {
  const { source, target } = parseArgs();
  const result = await migrate({ source, target });
  console.error(formatMigrationSummary(source, target, result));
}

main().catch((err) => {
  console.error("❌ Migration failed:", err.message ?? err);
  process.exit(1);
});
