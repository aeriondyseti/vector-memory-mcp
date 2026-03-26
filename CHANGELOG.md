# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-03-26

### Added
- **Plugin setup hook**: New `plugin-setup.sh` SessionStart hook that auto-installs dependencies and warms up the embedding model on first plugin use. Uses a cached hash of `package.json` to skip reinstalls when nothing changed.

### Fixed
- **Context monitor for autonomous sessions**: Run context monitor on `PostToolUse` events, not just `Notification`, so it fires during autonomous agent sessions.
- **Port collision test stability**: Stabilized flaky port collision test with deterministic port allocation.
- **Vector backfill after migration**: Backfill missing vectors in `_vec` tables after the vec0-to-BLOB migration, ensuring search works immediately after upgrade.

### Changed
- **Removed legacy LanceDB migration code**: Dropped `@lancedb/lancedb` and `apache-arrow` dependencies and all associated migration paths. Users on 1.x must upgrade through 2.2.x first.
- **Removed publish skill**: Publishing workflow now documented in CLAUDE.md instead of a skill file.

### Roadmap
- Added Feature 29: Federated cross-project search (search across multiple projects' databases)
- Added Feature 30: Embedding model evaluation (alternatives to all-MiniLM-L6-v2)

## [2.2.3] - 2026-03-23

### Fixed
- **LanceDB extract pagination and dedup**: `query().toArrow()` without offset/limit returned non-deterministic results that duplicated some rows and skipped others. Switched to paginated offset/limit reads with deduplication by ID. Also adds schema-aware timestamp conversion (reads Arrow `TimeUnit` per column) and safe BigInt fallback when Arrow's getter throws.

## [2.2.2] - 2026-03-23

### Fixed
- **LanceDB migration BigInt crash on macOS**: Arrow's `StructRow` proxy threw `TypeError` when reading microsecond timestamps exceeding `Number.MAX_SAFE_INTEGER`. Migration now reads columns directly from Arrow `RecordBatch` objects, bypassing the unsafe conversion.

## [2.2.1] - 2026-03-23

### Fixed
- **macOS compatibility**: Dropped `sqlite-vec` native extension which required `sqlite3_load_extension`, unavailable on macOS system SQLite. Vector KNN search is now implemented as brute-force cosine similarity in JS over plain BLOB tables. No API changes.
- **Removed unused `apache-arrow` dependency**: Was only a transitive dependency of LanceDB, not directly imported.

### Changed
- **Vec tables migrated from vec0 to plain BLOB**: On first startup after upgrade, existing `vec0` virtual tables are automatically migrated to plain `(id TEXT, vector BLOB)` tables. Migration is transparent and one-time.
- **LanceDB migration refactored**: Data extraction now runs in a subprocess (`scripts/lancedb-extract.ts`) to avoid native symbol collisions between `@lancedb/lancedb` and `bun:sqlite`.

## [2.2.0] - 2026-03-19

### Added
- **`search_memories` offset pagination**: New `offset` parameter for paginating through search results. Candidate pool scales with offset; capped at 500 to prevent pathological queries.
- **`get_waypoint` project parameter** (experimental): Optional `project` param on `get_waypoint` MCP tool and `GET /waypoint?project=` HTTP route. Waypoint IDs are now deterministic per project (SHA-256), allowing multiple projects to maintain independent waypoints. Legacy no-project path unchanged.

### Changed
- **`errorResult()` helper in handlers**: Replaced 11 inline error-response constructions with a shared `errorResult(text)` helper. No behavior change.

## [2.1.1] - 2026-03-19

### Fixed
- **Publish workflow bash syntax error**: Fixed unescaped parentheses in dist-tag warning step that caused workflow failure after successful publish
- **Dist-tag cascade without NPM_TOKEN**: Replaced `npm dist-tag add` (requires access token) with shadow `X.Y.Z-dev.0` publish using OIDC — no secrets needed
- **Node 20 deprecation**: Upgraded `actions/checkout` and `actions/setup-node` to v6 (Node 24 native), bumped `node-version` to 24 LTS, dropped redundant `npm install -g npm@latest` step

### Added
- **Release channels documentation**: README section covering `@latest`, `@rc`, and `@dev` install channels with usage warnings

## [2.1.0] - 2026-03-19

### Changed
- **Extract `SessionIndexDetail` type**: Inline return type from `indexConversations()` extracted into a named interface in `src/types/conversation.ts`, with `IndexStatus` type alias for the `"indexed" | "skipped" | "error"` union
- **`indexSession()` returns `IndexedSession`**: Eliminates redundant map lookup after each session is indexed; callers receive the state directly

## [2.0.0] - 2026-03-18

### Breaking Changes
- **SQLite replaces LanceDB**: Storage backend migrated from LanceDB (~845-file directory) to a single SQLite file using [sqlite-vec](https://github.com/asg017/sqlite-vec) for vector search and FTS5 for full-text search. Net new dependency footprint reduced to 24KB (sqlite-vec); LanceDB remains bundled temporarily for migration support (see Migration below).
- **Bun runtime required**: Node.js support removed. The server now requires [Bun](https://bun.sh/) for `bun:sqlite` native SQLite bindings. The `dist/` build step and `@hono/node-server` dependency have been removed.
- **Rename checkpoint to waypoint**: All "checkpoint" terminology renamed to "waypoint"
  - MCP tools: `store_checkpoint` → `set_waypoint`, `get_checkpoint` → `get_waypoint`
  - HTTP route: `GET /checkpoint` → `GET /waypoint`
  - Metadata type field: `"checkpoint"` → `"waypoint"`
  - Existing waypoint data (stored at UUID zero) remains compatible

### Added
- **`migrate` subcommand**: Run `vector-memory-mcp migrate` to convert LanceDB data to SQLite. Auto-detects legacy data at startup and prompts for migration.
- **Lockfile-based port discovery**: Server writes `.vector-memory/server.lock` with `{port, pid}` on startup, enabling hooks to discover the correct port in multi-session scenarios.
- **Server instructions**: MCP server now declares itself as the canonical memory system in tool descriptions
- **Smoke test script**: `bun run smoke` for manual testing checklist
- **Version-based debug logging**: Auto-enabled for `-dev.N` and `-rc.N` versions, or via `VECTOR_MEMORY_DEBUG=1`

### Fixed
- **MCP string-serialized arrays**: Added `asArray()` helper to handle MCP transports delivering array arguments as JSON strings (e.g., `for..of` iterating character-by-character)
- **`isError` flag on validation errors**: All validation error responses now include `isError: true` per MCP convention
- **Server version in MCP info**: Uses `VERSION` from `package.json` instead of hardcoded `"0.6.0"`
- **Migration guard**: `runMigrate` now guards against missing LanceDB source on fresh installs
- **Migration vector conversion**: Fixed `DataView` byteOffset/byteLength handling in `toFloatArray` — previously ignored view bounds, risking corrupted embeddings
- **Migration hardening**: Warn on unexpected timestamp types instead of silent `Date.now()` fallback; close LanceDB connection after migration; quote paths in summary shell commands; handle `.sqlite` extension doubling
- **Input validation**: Validate `query`, `history_after`, `history_before`, and `since` date parameters in MCP handlers and HTTP routes — reject malformed dates instead of passing `Invalid Date` downstream
- **Empty FTS query guard**: Skip FTS MATCH when sanitized query is empty instead of crashing
- **Waypoint soft-delete filter**: Exclude soft-deleted memories from waypoint `referencedMemories`
- **Subagent UUID validation**: Validate subagent session filenames against UUID pattern (matching main session behavior)
- **Publish workflow**: Add `NODE_AUTH_TOKEN` to dist-tag cascade step; always run typecheck for `@dev` publishes

### Changed
- **Direct TypeScript execution**: Package now runs `.ts` source directly via Bun instead of compiling to `dist/`. Simplifies development and eliminates stale-build issues.
- **Hybrid search rewritten**: KNN (sqlite-vec) + FTS5 queries with manual Reciprocal Rank Fusion (k=60) replace LanceDB's built-in reranker chain. Service layer unchanged.
- **CI/CD rewrite**: Three-tier dist-tag model (`@dev`/`@rc`/`@latest`) with branch-based RC publish flow

### Removed
- `dist/` build pipeline (`tsc` compilation, `prebuild`, `build` scripts)
- `@hono/node-server` dependency and Node.js HTTP fallback code path
- LanceDB schema files (`src/db/schema.ts`, `conversation.schema.ts`, `lancedb-utils.ts`)

### Migration
Users upgrading from 1.x with existing data should run:
```bash
vector-memory-mcp migrate
# Verify .vector-memory/memories.db.sqlite exists and contains your data
mv .vector-memory/memories.db .vector-memory/memories.db.lance-backup
mv .vector-memory/memories.db.sqlite .vector-memory/memories.db
```

If migration fails, restore the backup:
```bash
mv .vector-memory/memories.db.lance-backup .vector-memory/memories.db
```

LanceDB (`@lancedb/lancedb`, `apache-arrow`) ships as a production dependency in 2.0 solely to support migration. It will be removed in the next major version.

## [1.1.0] - 2026-03-11

### Added
- **Conversation history indexing**: Index Claude Code JSONL session logs as searchable history via `index_conversations`, `list_indexed_sessions`, and `reindex_session` tools
- **Unified search**: `search_memories` gains `include_history`, `history_only`, `session_id`, `role_filter`, `history_after`, and `history_before` parameters to search across both memories and conversation history
- **Conversation history parser**: Incremental JSONL parser with chunking, overlap, and role extraction for Claude Code session logs
- **Conversation history data layer**: Dedicated LanceDB table, repository, and service for conversation chunks with hybrid vector + FTS search

### Fixed
- **SQL injection in LanceDB where clauses**: Added `escapeLanceDbString()` helper to double single quotes in all 12 string interpolation sites across `MemoryRepository` and `ConversationHistoryRepository`
- **`include_history` / `history_only` mutual exclusivity**: Now returns an error if both are set to `true` instead of silently preferring `history_only`

### Changed
- **Shared reranker factory**: Extracted `createRerankerMutex()` into `lancedb-utils.ts`, replacing duplicate promise-mutex `getReranker()` methods in both repositories
- **Shared test helpers**: Created `tests/utils/test-helpers.ts` with `EMBEDDING_DIM`, `fakeEmbedding()`, `createMockEmbeddings()`, `userLine()`, `assistantLine()` — eliminates duplication across 4 test files
- **Test runner consistency**: Migrated 3 vitest test files back to bun:test (`vi.fn()` → `mock()`)
- **`handleGetMemories` cleanup**: Converted inline arrow `format` to named `formatMemoryDetail()` function

## [1.0.2] - 2026-02-10

### Changed
- **Dev publish flow**: Dev versions now tag existing commits instead of creating version bump commits. GHA sets package.json version from the git tag at build time.
- **Branch conventions**: Dev releases require `dev` branch, stable releases require `main`
- **Dev version scheme**: Dev tags derive from current stable version (`1.0.1-dev.N`), with `dev.0` indicating same commit as the stable release

### Fixed
- CI workflow now runs on `dev` branch pushes and PRs

## [1.0.1] - 2026-02-09

### Changed
- **Automated GitHub Releases**: GitHub Actions workflow now automatically creates GitHub Releases for stable versions
- **Updated publish workflow**: Publish skill documentation updated to reflect automated release creation

### Fixed
- CI/CD improvements for release automation

## [1.0.0] - 2026-02-09

### Breaking Changes
- **API rename**: All `handoff` terminology renamed to `checkpoint` throughout the codebase
  - MCP tools: `store_handoff` → `store_checkpoint`, `get_handoff` → `get_checkpoint`
  - Functions: `storeHandoff()` → `storeCheckpoint()`, `getLatestHandoff()` → `getLatestCheckpoint()`
  - HTTP route: `/handoff` → `/checkpoint`
  - Commands: `.claude/commands/handoff/` → `.claude/commands/checkpoint/`
  - Metadata type field: `"handoff"` → `"checkpoint"`
  - **Migration note**: Existing checkpoint data (stored at UUID zero) remains compatible, but client code using old tool names must be updated

### Added
- **Hybrid search**: Combined vector + full-text search with RRF (Reciprocal Rank Fusion) for better retrieval
- **Intent-based search**: 5 search intents (`continuity`, `fact_check`, `frequent`, `associative`, `explore`) with tuned weight profiles
- **Multi-signal scoring**: Relevance, recency (exponential decay), and utility (votes + access count) signals
- **Score jitter**: Controlled randomness for noise-robust RAG (prevents retrieval getting "stuck in a rut")
- **Mandatory search triggers**: Tool description now specifies when LLMs MUST search memory
- **`reason_for_search` parameter**: Forces intentional retrieval by requiring justification
- **Node.js compatibility**: Support for Node.js environments in addition to Bun

### Changed
- **Search is now read-only**: Access stats only update on explicit utilization (`vote`, `get`, `storeCheckpoint`)
- **New memories get fair discovery**: `lastAccessed` initialized to creation time for recency scoring
- **`vote()` tracks access**: Voting now also increments access count as explicit utilization signal
- **`storeCheckpoint()` tracks utilized memories**: Memories referenced in checkpoint get access credit

### Fixed
- **LanceDB schema migration**: Auto-migrate pre-hybrid databases to new schema format
- **CI workflow improvements**: Better handling of E2E tests and environment detection
- **npm publishing**: Configured GitHub Actions OIDC trusted publishing

### Removed
- `VectorRow` type (replaced by `HybridRow`)
- `findSimilar()` repository method (replaced by `findHybrid()`)
- Old `calculateScore()` method (replaced by intent-based scoring pipeline)

## [0.8.0] - 2026-01-06

### Added
- **Batch memory operations**: `store_memories`, `update_memories`, `delete_memories`, `get_memories` now accept arrays
- **Checkpoint system**: `store_checkpoint` and `get_checkpoint` for session continuity
- **Session-start hook**: `hooks/session-start.ts` for automatic checkpoint loading
- **HTTP/SSE transport**: Connect via HTTP for Claude Desktop integration
- **Graceful shutdown**: Proper cleanup on SIGTERM, SIGINT, stdin close
- **Publish tooling**: `/publish` slash command and `scripts/publish.ts`
- **CI workflow**: GitHub Actions for running tests on PRs

### Changed
- Standardized data storage to `.vector-memory/` directory
- Simplified configuration (hard-coded paths, fewer CLI args)

## [0.5.0] - 2026-01-04

### Added
- Proactive memory guidance and project configuration
- Global install support via `bunx`

### Changed
- Updated configuration documentation

## [0.4.0] - 2026-01-03

### Added
- Automatic warmup on install (downloads ML models)
- Fixed installation dependencies for native modules

## [0.3.0] - 2026-01-02

### Added
- Core memory operations (store, search, get, delete)
- LanceDB vector storage
- Local embeddings via @huggingface/transformers
- MCP protocol integration

## [0.2.0] - 2025-12-30

### Added
- Initial MCP server implementation
- Basic project structure

[2.3.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v2.2.3...v2.3.0
[2.0.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.8.0...v1.0.0
[0.8.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.5.0...v0.8.0
[0.5.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AerionDyseti/vector-memory-mcp/releases/tag/v0.2.0
