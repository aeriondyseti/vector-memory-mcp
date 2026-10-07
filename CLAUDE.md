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
bun run install:plugin # install plugin/ deps (hook-kit); needed for typecheck
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

Trunk-based: `feat/*` / `fix/*` → PR → `main`. There are no long-lived `dev` or `rc/*` branches.

- **Branch protection:** require the test status check on `main`

## Publishing

Pushing a `v*` tag triggers `.github/workflows/publish.yml`. Nothing publishes on branch pushes.

```sh
# stable → npm @latest (must be on main); add a CHANGELOG section for X.Y.Z first
npm version <patch|minor|major|X.Y.Z> && git push --follow-tags

# pre-release → npm @next (any branch)
npm version 3.0.0-beta.1 && git push --follow-tags
```

`main` requires a PR + passing `test` check; admins bypass this, so the one-liner works for the repo owner. Otherwise run `npm version` on a `release/X.Y.Z` branch, merge its PR with a **merge commit** (not squash, so the tagged commit is on `main`), then `git push origin vX.Y.Z`. A stable tag fails fast if `CHANGELOG.md` has no `## [X.Y.Z]` section.

`npm version` bumps `package.json`, runs `scripts/sync-version.ts` as the `version` lifecycle hook (stamps `plugin/.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`, runs `bun update @aeriondyseti/hook-kit` in `plugin/`, stages them), then commits and tags. The workflow checks the tag equals `package.json`'s version, requires stable tags to be on `main`, runs tests, publishes with provenance, and creates a GitHub Release (marked pre-release for `@next`).

### Version Source of Truth

`package.json` is the single source of truth. `sync-version.ts` accepts an optional explicit version argument; without one it reads from `package.json`.

### Two Installation Paths

- **npm** (`bunx @aeriondyseti/vector-memory-mcp`) — standalone MCP server, no hooks/skills
- **Plugin/marketplace** (install from GitHub) — lightweight shell with hooks + skills; MCP server runs via `bunx @aeriondyseti/vector-memory-mcp@latest`

### Plugin & Marketplace

This repo ships two independent artifacts from one codebase:

- **npm package** — `server/` only, published to npm. Consumers run via `bunx`.
- **Plugin** — `plugin/` directory, self-contained. Installed via marketplace; only `plugin/` is copied to the user's machine. The MCP server runs via `bunx @aeriondyseti/vector-memory-mcp@latest`.

| File | Purpose |
|------|---------|
| `.claude-plugin/marketplace.json` | Marketplace manifest — single plugin, `"source": "./plugin"` |
| `.claude-plugin/schemas/` | Local JSON Schema files for plugin.json and marketplace.json |
| `plugin/.claude-plugin/plugin.json` | Plugin manifest (paths relative to `plugin/`) |
| `plugin/package.json` + `plugin/bun.lock` | Hook dependencies (`@aeriondyseti/hook-kit`). Claude Code runs `bun install --frozen-lockfile --ignore-scripts` in each cached plugin version |
| `plugin/.mcp.json` | Runs MCP server via `bunx @aeriondyseti/vector-memory-mcp@latest` |
| `plugin/hooks/` | Session lifecycle hooks (start, clear) and waypoint checkpoint mods (compaction, /clear, /exit). Context-usage warnings live in the separate `context-monitor` plugin |
| `plugin/hooks/scripts/hooks-lib.ts` | Hook utilities (formatting, server discovery) — self-contained copy |
| `plugin/skills/` | Skills: vector-memory-usage, waypoint-set, waypoint-get, waypoint-workflow |
| `scripts/sync-version.ts` | `npm version` hook: stamps version into plugin/marketplace manifests |

**Important:** `plugin/` has no imports from `server/`. Shared utilities (ANSI codes, icons, message builders) are duplicated in `plugin/hooks/scripts/hooks-lib.ts` to keep the plugin self-contained. npm packages the hooks need go in `plugin/package.json`, never the root one. Keep `plugin/` free of `bunfig.toml` and of Yarn/pnpm lockfiles: either makes Claude Code skip the dependency install.

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
- Version-based debug logging: auto-enabled for any pre-release version (`X.Y.Z-*`), or set `VECTOR_MEMORY_DEBUG=1`
- Config is CLI-arg driven (no env vars except `VECTOR_MEMORY_DEBUG`)
