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
| `server/core/embeddings.service.ts` | Local embeddings via ONNX Runtime + @huggingface/tokenizers |
| `server/core/migration.service.ts` | Cross-format database migration |
| `server/core/consolidation.service.ts` | Repo-local → global db consolidation (`consolidate` CLI) |
| `server/core/maintenance.service.ts` | Health/storage stats, VACUUM/ANALYZE, orphan cleanup, maintenance history |
| `server/core/backup.service.ts` | SHA-256-verified DB snapshots (backup/restore/verify/purge) |
| `server/core/handoff.service.ts` | History-preserving session handoffs (sidecar store) |
| `server/core/document-ingestion.service.ts` | Chunk + ingest Markdown/text/JSON files into memories |
| `server/core/graph.ts` / `graph.repository.ts` / `graph.service.ts` | Knowledge graph subsystem (entity/edge type registry, entities, edges, lineage, memory→entity refs) |
| `server/core/project.ts` | Canonical project identity (`normalizeProject`) |
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

`package.json` is the single source of truth. `scripts/sync-version.ts` stamps the version into `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and stamps the npm dist-tag into `plugin/.mcp.json` based on the current git branch. It accepts an optional explicit version argument; without one it reads from `package.json`.

Branch → dist-tag mapping: `main` → `@latest`, `rc/*` → `@rc`, `dev`/feature → `@dev`.

### Two Installation Paths

- **npm** (`bunx @aeriondyseti/vector-memory-mcp`) — standalone MCP server, no hooks/skills
- **Plugin/marketplace** (install from GitHub) — lightweight shell with hooks + skills; MCP server runs via `bunx` from npm. Install with ref for channel: `@rc`, `@dev`, or default (`main` = `@latest`)

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

This repo ships two independent artifacts from one codebase:

- **npm package** — `server/` only, published to npm. Consumers run via `bunx`.
- **Plugin** — `plugin/` directory, self-contained. Installed via marketplace; only `plugin/` is copied to the user's machine. The MCP server runs via `bunx @aeriondyseti/vector-memory-mcp@<dist-tag>`.

| File | Purpose |
|------|---------|
| `.claude-plugin/marketplace.json` | Marketplace manifest — single plugin, `"source": "./plugin"` |
| `.claude-plugin/schemas/` | Local JSON Schema files for plugin.json and marketplace.json |
| `plugin/.claude-plugin/plugin.json` | Plugin manifest (self-contained inside `plugin/`) |
| `plugin/.mcp.json` | Runs MCP server via `bunx @aeriondyseti/vector-memory-mcp@<dist-tag>` |
| `plugin/hooks/` | Session lifecycle hooks (start, clear, compact, context monitor) |
| `plugin/hooks/scripts/hooks-lib.ts` | Hook utilities (formatting, server discovery) — self-contained copy |
| `plugin/skills/` | Skills: vector-memory-usage, waypoint-set, waypoint-get, waypoint-workflow |
| `scripts/sync-version.ts` | Stamps version + branch-aware dist-tag into plugin/marketplace files |

**Important:** `plugin/` has no imports from `server/`. Shared utilities (ANSI codes, icons, message builders) are duplicated in `plugin/hooks/scripts/hooks-lib.ts` to keep the plugin self-contained.

## Code Style

- **Files**: kebab-case (`memory.service.ts`)
- **Classes**: PascalCase (`MemoryService`)
- **Functions/methods**: camelCase (`findById`)
- **Constants**: SCREAMING_SNAKE_CASE (`DEFAULT_HTTP_PORT`)
- **Imports**: no `.js` extensions (Bundler resolution); use `import type` for type-only imports
- **No JSDoc**: TypeScript types serve as documentation
- **No linter/formatter**: Bun/TypeScript handles style; follow existing patterns
- **No console.log**: except server startup messages

## Testing Notes

- `bun run test` uses `scripts/test-runner.ts` which preloads the embedding model — runs all tests
- `bun run test:quick` / `bun test` skip embedding-dependent tests (faster iteration)
- `bun run test:coverage` for coverage reports
- Run a specific file: `bun test tests/memory.test.ts`

## Important Conventions

- All data stored in a single **global** SQLite file: `~/.vector-memory/memories.db`, shared by every project. Memories are tagged with a `project` column (canonical absolute path of the cwd, via `normalizeProject()` in `server/core/project.ts`). Repo-local dbs remain available via `--db-file` / `VECTOR_MEMORY_DB_PATH`
- `search_memories` defaults to `scope: "all"` (cross-project, current project boosted); `scope: "project"` restricts to the current repo. Project filters are **pre-filtered** into KNN/FTS candidate selection — never post-filter a global top-K
- Waypoints are keyed per-project (`wp:<sha256 of normalized path>`); there is deliberately no global UUID_ZERO waypoint copy (last-writer-wins clobber in a shared db)
- `consolidate` CLI subcommand imports legacy repo-local `.vector-memory/` dbs into the global store (`server/core/consolidation.service.ts`)
- Multi-process safety: `busy_timeout` is set before the WAL switch; the legacy vec0 cleanup runs only behind a read-only probe + exclusive lock; non-idempotent migrations are gated by `PRAGMA user_version` inside `BEGIN IMMEDIATE`
- Embedding model: `Xenova/all-MiniLM-L6-v2` (384 dimensions, loaded lazily on first use)
- Embeddings are local via ONNX Runtime + `@huggingface/tokenizers` — no API keys needed
- MCP tool handlers may receive array args as JSON strings; use the `asArray()` helper from `server/transports/mcp/handlers.ts`
- Version-based debug logging: auto-enabled for `-dev.N` and `-rc.N` versions, or set `VECTOR_MEMORY_DEBUG=1`
- Config is CLI-arg driven (no env vars except `VECTOR_MEMORY_DEBUG`)
