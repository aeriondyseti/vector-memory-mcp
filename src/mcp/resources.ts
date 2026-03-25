const MIGRATE_GUIDE = `# Migrating External Memory Databases

The vector-memory-mcp server exposes a \`POST /migrate\` HTTP endpoint that imports
memories from other database formats into the running instance. All imported
content is re-embedded with the server's current embedding model to guarantee
consistency.

## Endpoint

\`\`\`
POST http://<host>:<port>/migrate
Content-Type: application/json

{ "source": "/absolute/path/to/source/database" }
\`\`\`

## Discovering the Server Port

The HTTP server writes a lockfile at \`.vector-memory/server.lock\` in the
project's working directory. Read it to discover the current port:

\`\`\`json
{ "port": 3271, "pid": 12345 }
\`\`\`

## Supported Source Formats

The endpoint auto-detects the source format from the path provided.

### 1. LanceDB Directory
Provide the path to a LanceDB data directory (contains \`.lance\` files or
\`_versions\`/\`_indices\` subdirectories). Both memories and conversation
history are imported.

\`\`\`json
{ "source": "/path/to/project/.vector-memory" }
\`\`\`

### 2. Own SQLite (Current or Older Schema)
Provide the path to a \`.db\` file that was created by any version of
vector-memory-mcp. The migrator handles missing columns (e.g. \`usefulness\`,
\`access_count\`) by using sensible defaults. Both memories and conversation
history are imported.

\`\`\`json
{ "source": "/path/to/old-project/.vector-memory/memories.db" }
\`\`\`

### 3. CCCMemory SQLite
Provide the path to a CCCMemory database. The migrator extracts from the
\`decisions\`, \`mistakes\`, \`methodologies\`, \`research_findings\`,
\`solution_patterns\`, and \`working_memory\` tables. Each record is tagged
with \`source_type: "cccmemory"\` and the appropriate \`memory_type\` in
metadata.

\`\`\`json
{ "source": "/path/to/cccmemory.db" }
\`\`\`

### 4. MCP Memory Service SQLite
Provide the path to an mcp-memory-service database. Memories with
\`deleted_at IS NULL\` are imported. Tags and memory type are preserved in
metadata.

\`\`\`json
{ "source": "/path/to/mcp-memory-service.db" }
\`\`\`

### 5. MIF JSON (Shodh Memory Interchange Format)
Provide the path to a \`.json\` file exported from Shodh Memory. The file must
contain a top-level \`memories\` array. Memory type, tags, entities, and source
metadata are preserved.

\`\`\`json
{ "source": "/path/to/export.mif.json" }
\`\`\`

## Response

The endpoint returns a JSON summary upon completion:

\`\`\`json
{
  "source": "/path/to/source",
  "format": "own-sqlite",
  "memoriesImported": 142,
  "memoriesSkipped": 3,
  "conversationsImported": 0,
  "conversationsSkipped": 0,
  "errors": [],
  "durationMs": 8320
}
\`\`\`

- **memoriesImported**: Number of new memories written to the database.
- **memoriesSkipped**: Records skipped because a memory with the same ID
  already exists (safe for idempotent re-runs).
- **conversationsImported / conversationsSkipped**: Same, for conversation
  history chunks (LanceDB and own-sqlite formats only).
- **errors**: Per-record errors that did not abort the migration.
- **durationMs**: Wall-clock time for the entire operation.

## Important Notes

- **Re-embedding**: All content is re-embedded regardless of the source format.
  This ensures vector consistency with the server's current model but means the
  operation can take time for large databases (~50ms per record).
- **Idempotent**: Running the same migration twice is safe. Duplicate IDs are
  skipped.
- **Non-destructive**: The source database is opened read-only and is never
  modified.
- **Batched writes**: Records are inserted in batches of 100 within
  transactions. If the process is interrupted, already-committed batches are
  durable.
- **Error isolation**: A single bad record does not abort the migration. Check
  the \`errors\` array in the response for any per-record failures.

## Workflow Example

1. Locate the source database file or directory.
2. Read \`.vector-memory/server.lock\` to get the port.
3. Send the migrate request:
   \`\`\`bash
   curl -X POST http://127.0.0.1:3271/migrate \\
     -H "Content-Type: application/json" \\
     -d '{"source": "/path/to/old/memories.db"}'
   \`\`\`
4. Inspect the response summary.
5. Verify imported memories with a search:
   \`\`\`bash
   curl -X POST http://127.0.0.1:3271/search \\
     -H "Content-Type: application/json" \\
     -d '{"query": "test query", "limit": 5}'
   \`\`\`
`;

export const resources = [
  {
    uri: "vector-memory://guides/migrate",
    name: "Migration Guide",
    description:
      "How to use the POST /migrate HTTP endpoint to import memories from external database formats (LanceDB, older SQLite, CCCMemory, MCP Memory Service, MIF JSON) into the running vector-memory instance.",
    mimeType: "text/markdown",
  },
];

const RESOURCE_CONTENT: Record<string, string> = {
  "vector-memory://guides/migrate": MIGRATE_GUIDE,
};

export function readResource(uri: string): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  const text = RESOURCE_CONTENT[uri];
  if (!text) {
    throw new Error(`Resource not found: ${uri}`);
  }
  return {
    contents: [{ uri, mimeType: "text/markdown", text }],
  };
}
