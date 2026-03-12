# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-03-12

### Breaking Changes
- **SQLite replaces LanceDB**: Storage backend migrated from LanceDB (~845-file directory) to a single SQLite file using [sqlite-vec](https://github.com/asg017/sqlite-vec) for vector search and FTS5 for full-text search. Dependencies reduced from 223MB to 24KB.
- **Bun runtime required**: Node.js support removed. The server now requires [Bun](https://bun.sh/) for `bun:sqlite` native SQLite bindings. The `dist/` build step and `@hono/node-server` dependency have been removed.
- **Rename checkpoint to waypoint**: All "checkpoint" terminology renamed to "waypoint"
  - MCP tools: `store_checkpoint` → `set_waypoint`, `get_checkpoint` → `get_waypoint`
  - HTTP route: `GET /checkpoint` → `GET /waypoint`
  - Metadata type field: `"checkpoint"` → `"waypoint"`
  - Existing waypoint data (stored at UUID zero) remains compatible

### Added
- **`migrate` subcommand**: Run `vector-memory-mcp migrate` to convert LanceDB data to SQLite. Auto-detects legacy data at startup and prompts for migration.
- **Lockfile-based port discovery**: Server writes `.vector-memory/server.lock` with `{port, pid}` on startup, enabling hooks to discover the correct port in multi-session scenarios.

### Changed
- **Direct TypeScript execution**: Package now runs `.ts` source directly via Bun instead of compiling to `dist/`. Simplifies development and eliminates stale-build issues.
- **Hybrid search rewritten**: KNN (sqlite-vec) + FTS5 queries with manual Reciprocal Rank Fusion (k=60) replace LanceDB's built-in reranker chain. Service layer unchanged.

### Removed
- `dist/` build pipeline (`tsc` compilation, `prebuild`, `build` scripts)
- `@hono/node-server` dependency and Node.js HTTP fallback code path
- LanceDB schema files (`src/db/schema.ts`, `conversation.schema.ts`, `lancedb-utils.ts`)

### Migration
Users upgrading from 1.x with existing data should run:
```bash
vector-memory-mcp migrate
mv .vector-memory/memories.db .vector-memory/memories.db.lance-backup
mv .vector-memory/memories.db.sqlite .vector-memory/memories.db
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

[2.0.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v1.0.2...v1.1.0
[0.8.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.5.0...v0.8.0
[0.5.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AerionDyseti/vector-memory-mcp/releases/tag/v0.2.0
