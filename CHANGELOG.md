# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Automatic waypoint checkpoints** (Claude Code mod, `plugin/hooks/mods/`, registered under `modules` in `hooks.json`); tests run with `claude plugin test plugin`.
  - **Compaction**: a `session.compact` hook saves a model-drafted waypoint (`set_waypoint`) before every main-conversation compaction and appends it (`get_waypoint`) to the compacted conversation. `/compact <text>` steers the draft. Falls back to a plain compaction on any failure; skips `precompute` and subagent compactions.
  - **`/clear` and `/exit`**: a `command.run` hook asks before the command runs — save, skip, or cancel — and free text typed under "Other" becomes guidance for the waypoint (recorded as `metadata.user_notes`). On a failed save it asks whether to continue. New `exitCheckpoint` option (`ask` | `always` | `never`, default `ask`).
  - **Session start and after `/clear`**: a `classic.SessionStart` hook wraps the existing waypoint loader and asks whether to load the waypoint it found (with its age and branch); "Start fresh" drops it from the session's context. A waypoint just saved at `/clear` loads unasked; runs with nobody to ask (`-p`, SDK) load as before. New `loadCheckpoint` option (`ask` | `always` | `never`, default `ask`).
- **Write-time duplicate check**: `store_memories` (and `proactive_context`'s auto-ingest) no longer stores a near-exact repeat of a live memory in the same project — both cosine ≥ 0.95 and word-overlap (Jaccard) ≥ 0.85 must agree. With exactly one match the write is skipped and the response names the existing memory (update it with `update_memories`); with several, the memory is stored and flagged in `metadata.possible_duplicate_of` for review rather than merged on a guess. `allow_duplicates: true` opts out. Archived, deleted, superseded and waypoint memories are never matched.
- **Per-kind update rules (memory lifecycles)**: memories now update according to what they are.
  - *Cumulative* (default): every entry is kept.
  - *Superseding*: a memory given a `key` (e.g. `current-goal`, `preferred-editor`) replaces the live memory with the same key in the same project; the old one stays as history (`superseded_by`) and leaves default search (`include_superseded: true` shows it, labelled `[SUPERSEDED by …]`). `store_memories` reports what it replaced; `update_memories` can assign a key.
  - *Open until resolved*: `task`, `next-step` and `blocker` memories start `status: open`; `update_memories` with `status: "resolved"` (stamped `resolved_at`) drops them from default search and proactive context (`include_resolved: true` shows them). `get_session_context` lists open items after pinned ones.
  - Duplicate handling respects lifecycles: resolved memories are not write-time duplicate candidates, superseded versions are never clustered, and an open and a resolved copy are left for review (`different status`).
- **Graph-aware search**: `search_memories` fuses a graph lane into its ranking — memories linked through the knowledge graph (memory→entity references, memory lineage, entity edges, walked as undirected up to 3 links) to entities the query names (whole-word, case-insensitive). Graph hits rank by distance then by how many seeds reach them and enter the fusion at half weight; hub entities (> 50 links) are not walked through unless named; project-scoped searches keep graph hits in the project. Results reached this way are marked `via graph (N links)`. It is **opt-in** (`include_graph: true`): on a larger real-world corpus, where most questions name some entity, it pushed passing mentions above the answer, so it ships off until it is tuned further. `exact` mode never uses it. A second part — neighbours of the top text matches — is implemented but weighted 0 by default (`GRAPH_NEIGHBOR_WEIGHT`): the benchmark showed it costs top-rank precision.
- **Graph benchmark**: `bun run benchmark:graph` compares search with the graph lane off and on over the general dataset plus an auto-linked knowledge graph (35 entities, 27 relations) and 8 new `multi_hop` queries; results and the neighbour-weight tuning are in BENCHMARKS.md (original queries: no measurable change; multi-hop R@5 +0.25, NDCG@5 +0.16). `bun run benchmark` guards both. The benchmark runner now closes its database before cleanup (fixes EBUSY on Windows).
- **Synthesis memories cite sources**: `store_memories` items accept `sources` — the IDs of the memories a conclusion draws on (unknown ids are dropped with a note). Search shows them (`Sources: …`) and flags a synthesis whose sources have since been replaced or deleted. The tool description and usage skill suggest storing conclusions reached across several memories this way, so broad questions find them directly.
- **Time-focused search**: when a question names a period ("last week", "two months ago", "in March", "March 15th", "this year") — or `search_memories` is given `during` ("last week", "March", or a range "2026-03-01..2026-04-01") — memories from that period join the ranking as a fourth fused lane (ranked by similarity): a focus, not a filter, so nothing outside the period is dropped. The lane runs only when the period holds a minority of the searched memories. Memories gain `occurred_at` (store/update; schema v5): when what they describe happened, if not when they were stored — backfilled notes and past sessions count from their event. On LongMemEval, temporal-reasoning questions improved modestly; other question types were unchanged.
- **Lifecycle-aware search**: a current memory in search results carries the versions it replaced (same `key`, or duplicates merged into it), newest first, up to 3 — shown as `Previously (newest first): … (from – until)` — so an agent sees what changed alongside the current value instead of stale versions competing as separate results; versions worded like the current one are left out. `search_memories` gains `status: "open" | "resolved"` to list what is still open (or what was done) directly.
- **Search reranking**: `search_memories` re-scores its top 30 memory candidates with a CPU cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, ONNX, ~90 MB, downloaded by `warmup` or on first search), which reads the query and each memory (with its context) together. Its score, spread to 0–1 over the candidates, is blended evenly with the fused vector + keyword score and becomes the candidates' relevance under the search intent. On the benchmarks it improved every set — on a real-world notes corpus most on temporal, event and factual questions — while the cross-encoder alone lost on short conversational memories (implicit connections); on LongMemEval it lifted MRR 0.62 → 0.76. It reads at most 256 tokens per memory: ~0.06–0.4 s per search on CPU, depending on memory length. A reranked result's confidence includes the cross-encoder's verdict (see confidence below). On by default; `--no-rerank` / `VECTOR_MEMORY_RERANK=0` turns it off, and `rerank: false` skips it for one search. `exact` mode is never reranked.
- **Memory context**: a memory can name where it belongs — `context`, a short path from source to section ("Atlas design doc > Auth flow", "Campaign notes > Valerica > Allies") — on `store_memories`, `update_memories` (empty string clears) and HTTP `POST /store`. The context is embedded ahead of the content and indexed in its own keyword column at 4× the weight of content words, so a chunk is found by the document and section it belongs to even when its own text doesn't say; it is shown with the memory (`Context:`) but is not part of its content. `ingest_document` now chunks Markdown section by section and gives each chunk the context "Title > Heading > Subheading" (title from frontmatter, the first `#` heading, or the file name; heading lines move from the content into the context); other files get their file name. Schema v4 adds the column and rebuilds the memory keyword index. On a real-world notes corpus, chunks stored with their note and section were found far more often by note- and section-name lookups and somewhat more often by hand-written questions.

### Changed
- **`cleanup_duplicates` and `consolidate_memories` merge only clear duplicates**: a cluster member is merged into the survivor only when it is in the same project, matches the survivor directly (not merely through a chain of similar members) in both embedding (cosine ≥ 0.95, now the default for both) and wording (Jaccard ≥ 0.85), and is not pinned or critical. Everything else is left in place and reported for review with its reason. `cleanup_duplicates` gains `dry_run: true`; consolidation reports `duplicatesForReview`. `find_duplicates` is unchanged: read-only, listing all candidates from 0.92.
- **Duplicate merges keep history**: `cleanup_duplicates`, `consolidate_memories` and merges mark the merged-away memories as superseded by the survivor (searchable with `include_superseded`, shown as its history) instead of deleting them.
- **Search confidence is a calibrated probability**: it was cosine similarity through a sigmoid, which saturates — right and wrong top results both scored ~1.0. It is now P(anything stored is relevant) — the query's best similarity over the store — × P(this result is the one), a logistic model over the result's similarity z-score against everything stored, its gap to the best match, and its keyword rank, fitted on the public benchmark sets. On held-out data it separates right from wrong top results far better, keeps off-topic queries near 0, and is calibrated (a result at 0.7 is relevant about 70% of the time). For a reranked result the second stage also weighs the cross-encoder's score (fitted on reranked searches, LongMemEval's long conversational memories included) — before that, `proactive_context`, which surfaces by confidence, ignored the reranker entirely. Ranking is unchanged. `exact` mode, which has no vector lane, keeps the old formula. `proactive_context`'s default threshold is now 0.6 (was 0.65), chosen on a RAG-injection evaluation: at equal precision it surfaces a relevant memory for far more messages than before (e.g. 38% vs 15–20% of LongMemEval questions at ~60% precision), and stays silent on 97–100% of chit-chat.
- **Fusion constant RRF k = 5** (was 10): with the reranker on, it ranked best on a real-world notes corpus and was never worse beyond noise elsewhere, with or without the reranker.
- **Embedding model profiles**: `EmbeddingsService` knows each supported model's pooling (mean or first-token) and search-query prefix (`MODEL_PROFILES`: all-MiniLM-L6-v2, snowflake-arctic-embed-xs/-s, bge-small-en-v1.5), and search embeds the query through `embedQuery`. Nothing changes for the default MiniLM model; the profiles make other models measurable. Evaluated as replacements (all 384-d): none clearly improved hand-written-question or ConvoMem accuracy, so the default stays — a switch would also need re-embedding every store and recalibrating the similarity thresholds.
- **Plugin root is `plugin/`**: the marketplace entry's source is now `./plugin` and the manifest lives at `plugin/.claude-plugin/plugin.json`, so installs copy only the plugin, not the whole repo.
- **hook-kit is a real dependency, no longer vendored**: hooks import `@aeriondyseti/hook-kit` from `plugin/package.json` + `plugin/bun.lock`, which Claude Code installs automatically into each cached plugin version. Removed the committed bundle, `scripts/vendor-hook-kit.ts`, the `vendor:hooks` scripts, and the CI drift guard.

### Fixed
- **Relevance outweighed by recency and use**: search scored a memory as weighted relevance + recency + utility, but relevance entered as the raw fused (RRF) score, ~0.03–0.18, against recency and utility on 0–1 — so in a store with memories of different ages a fresh, weak match outranked an older, exact one whatever the intent said. Relevance is now each candidate's fused score relative to the search's best. Conversation history results get the same normalization, so `history_weight` now means what it says (they were nearly always ranked below every memory).
- **Keyword search works for natural-language questions**: the keyword (FTS5) lane required every word of the query, so a question like "Who leads the Scarlet Covenant?" matched nothing unless "who" appeared in a memory — in practice search ran on vectors alone. Queries are now built from content words (question and function words dropped, possessives split, FTS syntax neutralised) and match memories containing **any** of them, BM25 ranking those that share more (and rarer) words first; `exact` mode still requires every content word. Requiring at least half the words was measured too and rejected: it won only on the 45-memory general benchmark and lost on ConvoMem (900 memories; MRR 0.704 before → 0.731 with any-word matching, 0.694 with half) and on a larger real-world corpus.
- **Keyword hits are ranked**: memory keyword results were returned in insertion order and fed to the fusion as if ranked; they are now ordered by BM25 (`ORDER BY rank`), as conversation history already was.
- **Keyword search stems words** (Porter): "migration" finds "migrating". Schema v3 rebuilds both FTS indexes with the stemming tokenizer from the rows they index, on first start after upgrading.
- **Confidence counts only strong keyword hits**: the agreement bonus applies to keyword ranks ≤ 10, and a keyword-only result scores 0.40 when ranked that high, 0.20 otherwise.

## [3.0.0] - 2026-09-27

Major release: completes the entire feature roadmap (Phases 1–4 + Knowledge Graph)
and adopts a single global memory store. MCP surface grew from 11 to **69 tools**.

### Added
- **Memory attributes** (schema v2): `pinned`, `archived`, `confidence`, `importance`, `expires_at`/`ttl_seconds`, `quality_score`, `episode_id`, `sequence_number`, `preceding_memory_id` — settable via `store_memories`/`update_memories`.
- **Search filters**: date (`after`/`before`/`time_expr`), `min_confidence`, `min_importance`, `type`, `tags`/`tag_match`, `include_archived`, `include_expired`, `max_response_chars`, and a `mode` (semantic/exact/hybrid).
- **Deletion & lifecycle**: flexible `delete_memories` (ids/tags/date-range, `dry_run`, `force`, pinned/critical protection); `archive_memory`/`unarchive_memory`; `expire_memories`; `find_stale_memories`.
- **Quality & consolidation**: `score_memories` (usefulness/frequency/recency/type/importance), `consolidate_memories` (decay/compress/forget), `find_duplicates`/`merge_duplicates`/`cleanup_duplicates`.
- **Organization**: `search_by_tags`, `list_tags`/`rename_tag`/`merge_tags`/`delete_tag`, `get_episode`/`list_episodes`, `get_session_context`, `proactive_context`.
- **Operations**: `memory_health`, `get_storage_stats`, `optimize_database`, `cleanup_orphans`, `get_maintenance_history`; `backup_create`/`list`/`verify`/`restore`/`purge`; `ingest_document`.
- **Session handoffs**: `prepare_handoff`/`resume_from_handoff`/`list_handoffs`/`get_startup_context` (history-preserving, unlike waypoints).
- **Knowledge graph** (25 tools): entity/edge type registry with hard enforcement, entities with embeddings + provenance, domain edges with type constraints, memory-graph lineage (`caused`/`informed_by`/…), and a memory→entity reference bridge.

### Changed
- **BREAKING — global memory store**: all data lives in a single `~/.vector-memory/memories.db` shared by every project, with a `project` column (canonical cwd path). `search_memories` defaults to `scope: "all"` (current project boosted). Repo-local dbs remain available via `--db-file` / `VECTOR_MEMORY_DB_PATH`; the `consolidate` CLI imports legacy repo-local dbs.
- **Release flow**: Publishing is tag-driven — `npm version <x> && git push --follow-tags`. `vX.Y.Z` publishes `@latest` (tag must be on `main`); `vX.Y.Z-<pre>` publishes `@next`. The `dev` and `rc/*` branches and the `@dev`/`@rc` dist-tags are retired; development is trunk-based on `main`.
- **Plugin**: `plugin/.mcp.json` always runs `@latest`; hooks use vendored `@aeriondyseti/hook-kit` 1.1.0.
- **Debug logging**: Auto-enabled for any pre-release version (`X.Y.Z-*`).

### Fixed
- **Cross-platform (Windows)**: SQLite file-lock release (GC + retry) before `rmSync`/rename in tests and in consolidation `--archive`; OS-agnostic path assertions. Full suite green on Windows.
- **Release commit missing manifests**: `sync-version` ran as `postversion` (after `npm version` commits), so the synced plugin/marketplace versions never landed in the release commit. It now runs as the `version` hook and stages its output.

## [2.4.0] - 2026-03-27

### Added
- **ONNX Runtime embeddings**: Replaced `@huggingface/transformers` with direct `onnxruntime-node` + `@huggingface/tokenizers`. Downloads ONNX model files on demand, runs inference directly via ONNX Runtime with manual mean pooling + normalization. Faster cold-start and smaller install footprint.
- **Model warmup endpoint**: `EmbeddingsService` gains `isReady` getter and `warmup()` method. HTTP server exposes `POST /warmup` endpoint and `embeddingReady` field in health response. Session-start hook warms the model before indexing to prevent cold-start timeouts.
- **Project-scoped conversation indexing**: Session-start hook now computes the project-specific session log path and passes it to `POST /index-conversations`, instead of scanning all projects (~327 sessions).
- **Hook timeout utility**: `withHookTimeout()` in hooks-lib.ts wraps hook main functions with self-managed timeouts that emit user-visible warnings instead of dying silently.
- **Plugin setup hook**: New `plugin-setup.sh` SessionStart hook that auto-installs dependencies and warms up the embedding model on first plugin use.
- **Benchmark tracking**: `bun run benchmark:update` snapshots search quality metrics (MRR, P@1, P@5, R@5, NDCG@5) into BENCHMARKS.md, averaged over multiple runs.

### Fixed
- **Context monitor for autonomous sessions**: Run context monitor on `PostToolUse` events, not just `Notification`, so it fires during autonomous agent sessions.
- **Port collision test stability**: Stabilized flaky port collision test with deterministic port allocation.
- **Vector backfill after migration**: Backfill missing vectors in `_vec` tables after the vec0-to-BLOB migration, ensuring search works immediately after upgrade.
- **Plugin manifest detection**: Fixed marketplace and MCP server detection issues with plugin directory structure.

### Changed
- **Self-contained plugin directory**: `plugin/` has zero imports from `server/`. Shared utilities (ANSI codes, icons, message builders) are duplicated in `plugin/hooks/scripts/hooks-lib.ts`.
- **Removed legacy LanceDB migration code**: Dropped `@lancedb/lancedb` and `apache-arrow` dependencies and all associated migration paths. Users on 1.x must upgrade through 2.2.x first.
- **Removed RC branch tier**: Simplified release flow to `dev` → `main` only. No more `rc/*` branches.
- **Removed publish skill**: Publishing workflow now documented in CLAUDE.md instead of a skill file.

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

[2.4.0]: https://github.com/AerionDyseti/vector-memory-mcp/compare/v2.2.3...v2.4.0
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
