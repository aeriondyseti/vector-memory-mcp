# CLAUDE.md

## Project

`@aeriondyseti/vector-memory-mcp` -- A local-first MCP server providing vector-based semantic memory storage using SQLite + sqlite-vec + FTS5.

## Runtime

**Bun** (not Node.js). Uses `bun:sqlite` native bindings. Do not use Node-specific APIs.

## Commands

```sh
bun run test          # run all tests (via scripts/test-runner.ts)
bun run test:quick    # fast tests without preload
bun run dev           # watch mode
bun run typecheck     # bunx tsc --noEmit
bun run smoke         # smoke tests (scripts/smoke-test.ts)
bun run warmup        # download ML models
```

## Architecture

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point, CLI arg parsing, server startup |
| `src/config/index.ts` | Configuration |
| `src/db/connection.ts` | SQLite connection setup |
| `src/db/migrations.ts` | Schema migrations |
| `src/db/memory.repository.ts` | Memory CRUD + hybrid search (sqlite-vec KNN + FTS5 + RRF) |
| `src/db/conversation.repository.ts` | Conversation history storage |
| `src/db/sqlite-utils.ts` | SQLite utility helpers |
| `src/services/memory.service.ts` | Memory business logic |
| `src/services/conversation.service.ts` | Conversation indexing service |
| `src/services/embeddings.service.ts` | Local embeddings via @huggingface/transformers |
| `src/services/parsers/` | Session log parsers (Claude Code JSONL) |
| `src/mcp/server.ts` | MCP server setup |
| `src/mcp/tools.ts` | MCP tool definitions |
| `src/mcp/handlers.ts` | MCP tool handler implementations |
| `src/http/server.ts` | HTTP/SSE transport (Hono) |
| `src/http/mcp-transport.ts` | MCP-over-HTTP bridge |
| `src/types/` | TypeScript type definitions |
| `src/migration.ts` | LanceDB-to-SQLite migration (legacy support) |

## Testing

- Framework: `bun:test`
- Tests live in `tests/`
- Preload script: `tests/preload.ts` (required for most tests)
- Test helpers: `tests/utils/test-helpers.ts`
- CI runs via GitHub Actions (`ci.yml`)

## Git Flow

`main` -> `dev` -> `feat/*` -> `dev` -> `rc/X.Y.Z` -> `main` -> `dev` (reset)

- **RC branches:** bugfixes and chores only, no new features
- **Branch protection:** require test status check on `main` and `dev`

## Publishing

Three-tier npm dist-tags: `@dev`, `@rc`, `@latest`.

- `@dev`: git tags on dev branch
- `@rc`: branch pushes from `rc/*` branches
- `@latest`: `v*` git tags on main, cascades to `@dev` and `@rc`

See `.claude/skills/publish/SKILL.md` for the publish workflow.

## Code Style

- **Files**: kebab-case (`memory.service.ts`)
- **Classes**: PascalCase (`MemoryService`)
- **Functions/methods**: camelCase (`findById`)
- **Constants**: SCREAMING_SNAKE_CASE (`DEFAULT_HTTP_PORT`)
- **Imports**: include `.js` extension (NodeNext resolution); use `import type` for type-only imports
- **No JSDoc**: TypeScript types serve as documentation
- **No linter/formatter**: Bun/TypeScript handles style; follow existing patterns
- **No console.log**: except server startup messages

## Testing Notes

- `bun run test` uses `scripts/test-runner.ts` which preloads the embedding model — runs all tests
- `bun run test:quick` / `bun test` skip embedding-dependent tests (faster iteration)
- `bun run test:coverage` for coverage reports
- Run a specific file: `bun test tests/memory.test.ts`

## Important Conventions

- All data stored in `.vector-memory/` directory (single SQLite file: `memories.db`)
- Embedding model: `Xenova/all-MiniLM-L6-v2` (384 dimensions, loaded lazily on first use)
- Embeddings are local via `@huggingface/transformers` — no API keys needed
- MCP tool handlers may receive array args as JSON strings; use the `asArray()` helper from `src/mcp/handlers.ts`
- Version-based debug logging: auto-enabled for `-dev.N` and `-rc.N` versions, or set `VECTOR_MEMORY_DEBUG=1`
- Config is CLI-arg driven (no env vars except `VECTOR_MEMORY_DEBUG`)
