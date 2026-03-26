# CLAUDE.md

## Project

`@aeriondyseti/vector-memory-mcp` -- A local-first MCP server providing vector-based semantic memory storage using SQLite + sqlite-vec + FTS5.

## Runtime

**Bun** (not Node.js). Uses `bun:sqlite` native bindings. Do not use Node-specific APIs.

## Commands

```sh
bun run test          # run all tests (via scripts/test-runner.ts)
bun run test:quick    # fast tests without preload
bun run test:coverage  # coverage reports
bun run dev           # watch mode
bun run typecheck     # bunx tsc --noEmit
bun run smoke         # smoke tests (scripts/smoke-test.ts)
bun run warmup        # download ML models
```

## Architecture

| Path | Purpose |
|------|---------|
| `server/index.ts` | Entry point, CLI arg parsing, server startup |
| `server/config/index.ts` | Configuration |
| **Core** (`server/core/`) | |
| `server/core/connection.ts` | SQLite connection setup |
| `server/core/migrations.ts` | Schema migrations |
| `server/core/memory.repository.ts` | Memory CRUD + hybrid search (sqlite-vec KNN + FTS5 + RRF) |
| `server/core/conversation.repository.ts` | Conversation history storage |
| `server/core/sqlite-utils.ts` | SQLite utility helpers |
| `server/core/memory.service.ts` | Memory business logic |
| `server/core/conversation.service.ts` | Conversation indexing service |
| `server/core/embeddings.service.ts` | Local embeddings via @huggingface/transformers |
| `server/core/migration.service.ts` | Cross-format database migration |
| `server/core/parsers/` | Session log parsers (Claude Code JSONL) |
| `server/core/memory.ts` | Memory type definitions |
| `server/core/conversation.ts` | Conversation type definitions |
| **Utils** (`server/utils/`) | |
| `server/utils/formatting.ts` | ANSI styling, icons, message builders, time formatting |
| **Transports** | |
| `server/transports/mcp/server.ts` | MCP server setup |
| `server/transports/mcp/tools.ts` | MCP tool definitions |
| `server/transports/mcp/handlers.ts` | MCP tool handler implementations |
| `server/transports/mcp/resources.ts` | MCP resource definitions |
| `server/transports/http/server.ts` | HTTP/SSE transport (Hono) |
| `server/transports/http/mcp-transport.ts` | MCP-over-HTTP bridge |
| **Legacy** | |
| `server/migration.ts` | LanceDB-to-SQLite migration (legacy support) |

## Testing

- Framework: `bun:test`
- Tests live in `tests/`
- Preload script: `tests/preload.ts` (required for most tests)
- Test helpers: `tests/utils/test-helpers.ts`
- CI runs via GitHub Actions (`ci.yml`)

## Git Flow

`main` -> `dev` -> `feat/*` -> `dev` -> `rc/X.Y.Z` -> `main` -> `dev` (reset)

- **RC branches:** bugfixes and chores only, no new features
- **Branch protection:** require test status check on `main` only; `dev` is unprotected (integration/dogfooding branch)

## Publishing

Three-tier npm dist-tags: `@dev`, `@rc`, `@latest`. Use `/publish` to run the workflow interactively.

### Version Source of Truth

`package.json` is the single source of truth. `scripts/sync-version.ts` stamps the version into `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. It accepts an optional explicit version argument; without one it reads from `package.json`.

### Two Installation Paths

- **npm** (`bunx @aeriondyseti/vector-memory-mcp`) — standalone MCP server, no hooks/skills
- **Plugin/marketplace** (clone from GitHub) — MCP server runs from source via `plugin/.mcp.json`, includes hooks + skills

### Dev Flow (`/publish dev`)

Lightweight snapshot of current `dev` branch. Backward-looking: "stuff since last release."

1. Must be on `dev`, clean, up to date
2. Compute version: latest stable tag + `-dev.N` (e.g., `2.2.3-dev.4`)
3. `sync-version.ts "${NEW_VERSION}"` → commit → tag `v${NEW_VERSION}` → push branch + tags
4. GHA publishes to npm `@dev` (overrides `package.json` version from tag at build time)

### RC Flow (`/publish rc`)

Stabilization branch. Forward-looking: "this will become X.Y.Z." No new features — bugfixes and chores only.

1. Must be on `dev`, clean, up to date. Check for existing `rc/*` branches
2. Analyze commits since last stable tag → determine semver bump (`feat:` = minor, `fix:` = patch, `feat!:` = major)
3. Create `rc/X.Y.Z` branch, `npm version X.Y.Z-rc.1`, `sync-version.ts` → commit → push
4. GHA publishes to npm `@rc` on every push to the `rc/*` branch
5. Iterate: fix bugs → bump rc number (`X.Y.Z-rc.N`) → sync → commit → push

### Release Flow (`/publish release`)

Promote an RC to stable. Must be on an `rc/*` branch.

1. Version from branch name: `rc/2.3.0` → `2.3.0`
2. Write CHANGELOG, `npm version X.Y.Z`, `sync-version.ts` → commit → push
3. Create PR: `rc/X.Y.Z` → `main`
4. After merge: tag `vX.Y.Z` on main, push tags, merge main → dev, delete rc branch
5. GHA publishes to npm `@latest`, cascades `@dev` via shadow publish, creates GitHub Release

### Plugin & Marketplace

This repo is both an npm package and a Claude Code plugin marketplace.

| File | Purpose |
|------|---------|
| `.claude-plugin/plugin.json` | Plugin manifest — `mcpServers`, `hooks`, `skills` point to `plugin/` |
| `.claude-plugin/marketplace.json` | Marketplace manifest — single plugin, `"source": "./"` |
| `.claude-plugin/schemas/` | Local JSON Schema files for plugin.json and marketplace.json |
| `plugin/.mcp.json` | Runs MCP server from source: `bun ${CLAUDE_PLUGIN_ROOT}/server/index.ts` |
| `plugin/hooks/` | Session lifecycle hooks (start, clear, compact, context monitor) |
| `plugin/skills/` | Skills: vector-memory-usage, waypoint-set, waypoint-get, waypoint-workflow |
| `scripts/sync-version.ts` | Stamps version from `package.json` (or explicit arg) into plugin/marketplace files |

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
- MCP tool handlers may receive array args as JSON strings; use the `asArray()` helper from `server/transports/mcp/handlers.ts`
- Version-based debug logging: auto-enabled for `-dev.N` and `-rc.N` versions, or set `VECTOR_MEMORY_DEBUG=1`
- Config is CLI-arg driven (no env vars except `VECTOR_MEMORY_DEBUG`)
