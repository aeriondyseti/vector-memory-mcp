# Roadmap

Current version: **2.0.0**

## Tech Debt

- **Duplicate memory formatting in `handleSearchMemories`**: The memory-only code path (default, no `include_history`) formats results inline with the same logic as `formatSearchResult` for `source: "memory"`, minus the `Source:` label. Consolidating would require adding a `Source: memory` prefix to default output, changing existing behavior. Deferred to avoid breaking consumers that parse the output.

- **Repetitive error-response boilerplate in `handlers.ts`**: The `{ content: [{ type: "text", text }], isError: true }` shape is constructed inline at 5+ locations. An `errorResult(text)` helper would reduce duplication and make it easy to add a `requireStringArg` guard for common validation patterns.

- **Inconsistent parameter validation in MCP handlers**: `handleReindexSession` validates its required `session_id` arg defensively, but other handlers (`handleStoreMemories`, `handleDeleteMemories`, `handleReportMemoryUsefulness`, etc.) trust the MCP SDK schema validation and would throw unhandled `TypeError` on missing input. Low risk today since the SDK validates before calling handlers, but fragile if handlers are ever called directly (e.g. from HTTP routes).

- **N individual upserts for access tracking in `getMultiple()`**: `memory.service.ts:getMultiple()` batches the read via `findByIds` (single IN query), but fans out to N individual `repository.upsert()` calls for access tracking. Each upsert does a SELECT (existence check) + UPDATE — 2N queries total. A `bulkUpdateAccess(ids, now)` repository method using a single `UPDATE ... WHERE id IN (...)` would collapse this to 1 query. Same pattern applies to `trackAccess()`.

- **Unbounded IN clause in `findByIds()`**: `memory.repository.ts:findByIds()` builds a SQL IN clause from an unbounded array of IDs. SQLite has a default SQLITE_MAX_VARIABLE_NUMBER limit (usually 999). Add a size guard (e.g., 100 IDs) and batch if needed.

- **GitHub Actions Node.js 20 deprecation**: `actions/checkout@v4` and `actions/setup-node@v4` run on Node.js 20, which GitHub will force to Node.js 24 starting June 2, 2026. Update to newer action versions that support Node.js 24 before then.

- **Non-atomic delete-insert in conversation reindexing**: `conversation.service.ts` calls `deleteBySessionId()` before `embedBatch()`/`insertBatch()`. If embedding or insert fails after delete, the session's chunks are lost until the next re-index. Wrap in a SQLite transaction or insert-then-delete to make it crash-safe.

- **ConversationChunk field duplication**: `ConversationChunk` duplicates `sessionId`, `role`, `messageIndexStart`, `messageIndexEnd`, and `project` at both the top level and inside `metadata`. Consolidate to one location to eliminate divergence risk.

- **Conversation search filters applied post-candidate selection**: `conversation.repository.ts` runs KNN/FTS without applying session/role/date filters, then filters after RRF scoring. This can return fewer than `limit` results. Intentional performance tradeoff — document or push filters into candidate queries.

- **`get_waypoint` missing optional `project` parameter**: `set_waypoint` accepts a `project` param but `get_waypoint` has no way to specify which project's waypoint to retrieve. Add an optional `project` parameter for explicit retrieval.

- **Platform-dependent path separator in subagent detection**: `claude-code.parser.ts` uses hardcoded `/subagents/` check which won't match on Windows. Low priority since Bun runtime is Linux/macOS focused, but should use `path.sep` or a regex for correctness.

## Completed

### v2.0.0 - SQLite Migration & CI/CD
- Migrated storage from LanceDB to SQLite with sqlite-vec for vector search and FTS5 for full-text search
- Dropped Node.js support — Bun runtime required for bun:sqlite bindings
- Renamed checkpoint to waypoint (tools, routes, metadata)
- Added LanceDB-to-SQLite migration subcommand
- Rewrote CI/CD for three-tier dist-tag model (@dev/@rc/@latest)
- Fixed MCP string-serialized array handling (asArray helper)

### v1.1.0 - Conversation History Indexing (Feature 27)
- Conversation history indexing from Claude Code JSONL session logs
- Session parser with incremental indexing support
- Hybrid search (vector + FTS) across conversation history
- Unified search merging memories and conversation history
- New MCP tools: index_conversations, list_indexed_sessions, reindex_session
- search_memories gains include_history and history_only params

### v0.8.0 - Batch Operations & Checkpoints
- Batch memory operations (store/update/delete/get multiple)
- Checkpoint system for session continuity
- Session-start hook for automatic context loading
- HTTP/SSE transport for Claude Desktop
- Graceful shutdown handling

### v0.5.0 - Foundation
- Core database with LanceDB
- Embedding generation with @huggingface/transformers
- Basic MCP tools (store, search, get, delete)
- TypeScript implementation
- Local-first, privacy-focused design

---

## Planned

Features below were selected from a comparative analysis of three reference implementations ([cccmemory](reference/cccmemory), [mcp-memory-service](reference/mcp-memory-service), [shodh-memory](reference/shodh-memory)), extended with additional design work.

This server is general-purpose: useful to developers, creative writers, worldbuilders, project managers, and anyone else who works with an AI assistant across sessions. Claude Code lifecycle hooks (UserPromptSubmit, SessionStart, etc.) are supported where relevant, but are not the organizing principle of the design. Ordered by impact then ease of implementation within each phase.

---

### Next — Phase 1 — High Impact, Low Effort

Minimal schema changes. Most are handler and query-layer additions; Feature 3 requires one column.

#### 1. Date/Time Filtering in Search
Add to `search_memories`:
- `after` / `before` — ISO date strings (`"2024-01-01"`)
- `time_expr` — natural language (`"yesterday"`, `"last week"`, `"3 days ago"`)

`created_at` is already a top-level SQLite column; only a time parser and a WHERE predicate are needed.

#### 2. Flexible Deletion — Tags, Time Range, Dry Run
Extend `delete_memories`:
- `tags: string[]` — delete by tag match on metadata JSON (`tag_match: "any" | "all"`)
- `before` / `after` — delete by creation date range
- `dry_run: boolean` — preview without executing; returns count + IDs
- Returns `deleted_ids` for audit trail

#### 3. Memory Pinning
Add a `pinned` boolean column. Pinned memories are skipped by all delete and cleanup operations unless `force: true` is passed. Settable via `update_memories`. Reflected in search results.

Schema: one `Int32` column — SQLite schema migration required.

#### 4. Result Pagination (Offset)
Add `offset: integer` to `search_memories` and `get_memories`. SQLite supports `OFFSET` natively.

#### 5. Health & Storage Stats as MCP Tools
Two new read-only tools:
- `memory_health` — total count, deleted count, average usefulness, DB path, backend info
- `get_storage_stats` — table size on disk, record counts, fragmentation estimate

Pure SQLite queries; no schema changes.

#### 6. Database Maintenance Tools
- `optimize_database` — calls SQLite `VACUUM` / `ANALYZE` after bulk deletes
- `cleanup_orphans` — surface inconsistencies in the table
- `get_maintenance_history` — audit log stored as a sidecar JSON file

#### 7. Response Size Controls
Add `max_response_chars: integer` to `search_memories`. Truncates at memory boundaries (whole memories only) with `truncated: true` flag and omitted count. Pure handler logic.

---

### Phase 2 — High Impact, Medium Effort

Require schema migrations (new SQLite columns) or new retrieval logic.

#### 8. Memory Archiving
Add `archived` boolean column. Archived memories are excluded from search by default. Expose:
- `archive_memory(ids[])` / `unarchive_memory(ids[])`
- `include_archived: boolean` flag on `search_memories` and `get_memories`

Schema: one `Int32` column — SQLite schema migration required.

#### 9. Confidence & Importance Levels
Add two fields to the memory model:
- `confidence`: `uncertain | likely | confirmed | verified` (default: `likely`)
- `importance`: `low | normal | high | critical` (default: `normal`)

Settable via `store_memories` and `update_memories`. `search_memories` gains `min_confidence` and `min_importance` filter params. `critical` importance implies pin-protection behavior for deletions.

Schema: two `Utf8` columns — SQLite schema migration required.

#### 10. TTL (Auto-Expiry)
Add `expires_at` nullable timestamp column. All `search_memories` calls automatically filter `WHERE expires_at IS NULL OR expires_at > now()`. A `expire_memories` maintenance tool tombstones expired entries on demand.

Schema: one nullable `Timestamp` column — SQLite schema migration required.

#### 11. Search Modes — Exact & Hybrid
Add `mode` parameter to `search_memories`:
- `semantic` — current default (vector similarity only)
- `exact` — substring/keyword match via FTS5 index
- `hybrid` — `semantic_score × (1 - quality_boost) + usefulness × quality_boost`

`usefulness` column already exists; hybrid ranking uses it immediately. FTS5 is already in use.

#### 12. Tag-Based Search & Filtering
- Add `tags` / `tag_match` filter to `search_memories` (JSON-path predicate on metadata)
- New tool `search_by_tags(tags[], match_mode, limit, offset)` — pure tag retrieval without a query, ordered by recency

No schema changes — tags already live in metadata JSON.

#### 13. Stale Item Detection
New tool `find_stale_memories`:
- `stale_days: integer` (default: 90) — threshold since `last_accessed`
- `exclude_pinned: boolean` (default: true)
- `exclude_importance: string[]` — skip high/critical
- Returns stale memories with last access date and current usefulness score

No schema changes — queries existing `last_accessed` and `created_at` columns.

---

### Phase 3 — High Impact, Higher Effort

New subsystems or sidecar tables. Scope each individually before starting.

#### 14. Duplicate Detection & Merge
- `find_duplicates(similarity_threshold: 0.5–1.0)` — ANN self-search to find near-duplicate clusters; returns groups with recommended "keep" candidate
- `merge_duplicates(keep_id, merge_ids[], merge_strategy)` — strategies: `keep_content | combine_content | keep_newest`
- `cleanup_duplicates()` — auto-deduplicate at a safe default threshold (0.92)

Implementation: pairwise ANN search via sqlite-vec, cosine threshold grouping, then merge through existing `update_memories` + `delete_memories`.

#### 15. Quality Scoring System
Add `quality_score: Float32` column (0.0–1.0). Score derives from:
- Normalized access frequency (relative to memory age)
- Usefulness feedback signal (already collected)
- Recency decay

Score is recalculated on `report_memory_usefulness` and via a `score_memories` maintenance pass. Feeds the `hybrid` search mode (Feature 11) and `find_stale_memories` (Feature 13).

Schema: one `Float32` column — SQLite schema migration required.

#### 16. Tag Management System
Full CRUD on the tag namespace:
- `list_tags(sort_by, limit, offset)` — all tags with usage count, last used
- `rename_tag(old, new)` — rewrite all matching metadata JSON
- `merge_tags(sources[], target)` — combine and rewrite
- `delete_tag(name, force)` — remove from all memories

Implementation: full table scan + batch `update_memories`. If performance requires it, a separate `tags` SQLite sidecar table can be added to avoid repeated JSON scanning.

#### 17. Document Ingestion
New tool `ingest_document(file_path | directory_path, tags[], chunk_size, chunk_overlap)`:
- Supported: Markdown, plain text, JSON (phase 1); PDF via optional dependency (phase 2)
- Auto-chunking at sentence boundaries with configurable size and overlap
- Directory mode with file extension filter and max-file safety limit
- Each chunk stored as a separate memory with source file path in metadata

#### 18. Memory Consolidation
A periodic maintenance pass that prevents quality degradation over time:
1. **Decay** — reduce `quality_score` exponentially by age
2. **Cluster** — group semantically similar memories via ANN clustering
3. **Compress** — merge cluster members into a representative summary memory
4. **Forget** — archive memories below quality threshold

Exposed as `consolidate_memories(action: "run" | "status" | "recommend", time_horizon: "daily" | "weekly" | "monthly")`.

Depends on Feature 15 (quality scoring). Initially manual-only; scheduling via node-cron can be added after the core is stable.

---

**Knowledge Graph Subsystem** (Features 19 and 21 — implement 21 first)

Turns memory from a flat fact store into a structured reasoning layer. Two graphs, two node types, one reference bridge. Formal memory types (Feature 21) are a prerequisite — they give edges semantic weight.

---

#### 19. Knowledge Graph Subsystem

**Architecture: two graphs, one bridge**

```
Memory graph   — memory nodes, lineage edges (causal)
Entity graph   — entity nodes, domain edges (agent-defined)
Reference layer — memory→entity links (bridge between graphs)
```

**Data model**

```
entity_types  (id, name, description, default_properties JSON, importance_bonus, system, created_at)
edge_types    (id, name, description, category, valid_source_types JSON, valid_target_types JSON, system, created_at)
entities      (id, type, name, properties JSON, vector,
               source_type, source_ref, credibility,
               created_at, updated_at)
graph_edges   (id, source_id, source_ns, target_id, target_ns,
               edge_type, category, context, vector,
               source_type, source_ref, credibility,
               provenance, strength, created_at)
```

`entity_types.system` and `edge_types.system` flag read-only pre-populated entries (`Memory`, `caused`, `informed_by`, etc.). Agent-owned types have `system: false` and require explicit registration.

`graph_edges` replaces the three previously separate tables (`entity_edges`, `memory_edges`, `memory_entity_refs`). Cross-namespace edges (`source_ns: "memory"`, `target_ns: "entity"`) are the reference bridge. `graph_edges.category` is the extension point for future edge kinds (see Deferred below).

`entities.vector` embeds `name + properties`. `graph_edges.vector` embeds `"{source_name} {edge_type} {target_name}: {context}"` (context omitted if empty).

**Provenance fields** (`source_type`, `source_ref`, `credibility`) appear on both `entities` and `graph_edges`:

- `source_type`: `user | agent | inferred | file | web | conversation_history` — where did this fact or relationship originate?
- `source_ref`: optional reference to the specific origin — a file path, conversation session ID, memory ID, or URL
- `credibility`: Float 0.0–1.0 — default 1.0 for `user`, 0.8 for `agent`, 0.6 for `inferred`. Settable at write time; filterable in search and traversal.

This generalises source and credibility tracking to the entire graph rather than memories alone. Supersedes Feature 22.

---

**Type registry — hard enforcement**

Both entity types and edge types must be explicitly defined before use. Attempting to store an entity or edge with an undefined type returns an error directing the agent to call `create_entity_type` or `create_edge_type` first. No silent auto-creation.

Type definitions are self-documenting: they persist across sessions and give any new session a readable description of the domain model without having to infer it from data.

Entity type tools:
- `create_entity_type(name, description, default_properties?, importance_bonus?)` — register a new entity type; `default_properties` is a suggested property schema surfaced when storing entities of this type
- `update_entity_type(name, description?, default_properties?, importance_bonus?)` — amend a type definition
- `delete_entity_type(name)` — remove a type; fails if any entities of this type exist (use `force: true` to delete entities too)
- `list_entity_types()` — full registry: name, description, default_properties, entity count

Edge type tools:
- `create_edge_type(name, description, category, valid_source_types?, valid_target_types?)` — register a new edge type; `valid_source_types` / `valid_target_types` enforce domain integrity (e.g., `RESIDES_IN` only from `Character` or `Faction` to `Location`)
- `update_edge_type(name, ...)` — amend a type definition
- `delete_edge_type(name)` — remove a type; fails if any edges of this type exist
- `list_edge_types(category?)` — full registry: name, description, constraints, edge count

---

**Memory graph — lineage category**

Causal edges between memories. Answers: *why does this memory exist, what caused it, what did it cause?*

Lineage edge types are pre-populated in the registry with `system: true`: `caused`, `informed_by`, `resolved_by`, `superseded_by`, `triggered`. These system types cannot be modified or deleted. The type registry enforcement applies to all edges, but only agent-defined types (`system: false`) can be created, updated, or removed.

Edge provenance: `inferred` (auto-created by system) | `confirmed` (agent approved) | `explicit` (agent created directly)

Auto-inference: when a `decision` or `error` memory is stored, ANN search finds semantically similar recent memories and creates candidate `inferred` edges above a configurable threshold.

Tools:
- `lineage_link(from_id, to_id, type, context?)` — create explicit causal edge
- `lineage_trace(memory_id, direction: "forward"|"backward"|"both", depth?)` — traverse the causal graph
- `lineage_confirm(edge_id)` — promote inferred → confirmed
- `lineage_reject(edge_id)` — delete an inferred edge
- `lineage_stats` — total edges, by-type and by-provenance breakdown

---

**Entity graph — domain category**

Agent-defined entities with updatable properties, linked by agent-defined relationship types. Answers: *what exists in this domain, and how do things relate?*

Both the entity type and edge type must exist in the registry before use. On type mismatch, the error response includes a `call: "create_entity_type"` or `call: "create_edge_type"` hint.

Tools:
- `store_entity(type, name, properties?)` — create or upsert by name+type; error if type not registered
- `get_entity(id | name, type?)` — retrieve entity with properties; optionally include linked memories
- `update_entity(id, properties)` — patch properties in place
- `delete_entity(id)` — remove entity and its edges
- `list_entities(type?, limit, offset)` — browse by type
- `search_entities(query, type?)` — semantic search over entity name + properties
- `link_entities(source_id, target_id, type, context?)` — create domain edge; error if edge type not registered or source/target types violate constraints
- `unlink_entities(edge_id)` — remove an edge
- `entity_graph(entity_id, depth?, type_filter?)` — BFS neighborhood traversal
- `search_entity_edges(query, type?)` — semantic search over edge context

---

**Reference layer — memory→entity bridge**

Links memories to the entities they're about. Enables scoped memory search and "all reasoning about this entity" queries.

Ref types: `mentions`, `describes`, `supports`, `relates_to`

Tools:
- `link_memory_to_entity(memory_id, entity_id, ref_type?)` — explicit reference
- `get_entity_memories(entity_id, memory_type?)` — memories about an entity, ordered by relevance
- `search_memories` gains `entity_id` filter param

---

**Deferred edge categories** (add in future phases as needed)

- `dependency` on entity graph — `DEPENDS_ON`, `BLOCKS`, `ENABLES`, `CONFLICTS_WITH` — enables impact analysis ("what breaks if X changes?")
- `temporal` on entity graph — `PRECEDED_BY`, `CONCURRENT_WITH` — enables timeline construction and ordered event traversal

#### 20. Session Handoff System
Upgrade the current single-overwrite waypoint system to a proper history-aware handoff:
- `prepare_handoff` — structured export: summary, completed, in-progress, key decisions with rationale, next steps, linked memory IDs. Stored with a UUID (not overwritten).
- `resume_from_handoff(handoff_id?)` — load specific handoff (defaults to most recent), marks it as resumed
- `list_handoffs` — browse handoff history with timestamps and resume status
- `get_startup_context(query, max_tokens)` — query-aware aggregation of recent handoffs + relevant memories for context injection at conversation start

Handoffs stored as structured JSON in a sidecar file alongside the SQLite database.

#### 21. Formal Memory Type Taxonomy

`metadata.type` is a free-form string today with no system-level meaning. Making it a validated set of types gives it semantic weight that feeds quality scoring, search filtering, consolidation priority, and — critically — typed edges in the knowledge graph subsystem (Feature 19).

Types are designed to be domain-agnostic: equally applicable to software development, creative writing, worldbuilding, project management, research, or any other collaborative work.

Defined types with default importance bonuses:

| Type | Importance Bonus | Description |
|------|-----------------|-------------|
| `decision` | +0.30 | A choice made with rationale — architectural, creative, strategic |
| `error` | +0.25 | A mistake, failure, or dead end encountered |
| `learning` | +0.25 | An insight or lesson derived from experience |
| `discovery` | +0.20 | Something found that wasn't expected or previously known |
| `pattern` | +0.20 | A repeating structure, solution, or anti-pattern |
| `task` | +0.15 | Pending or completed work item |
| `context` | +0.10 | Background information, constraints, or world state |
| `observation` | +0.00 | General note; default when no type is specified |

Implemented as: type validation in `store_memories`, default quality score bonuses in the scoring system (Feature 15), and a `type` filter in `search_memories`.

No schema change — type is already stored in `metadata`. The bonus system is a service-layer concern.

**Migration:** Existing memories with free-form `metadata.type` remain readable. Validation is enforced only on new writes via `store_memories`. Unrecognized types in existing data are treated as `observation` for scoring purposes. A future `audit_memory_types` maintenance tool could scan and report non-conforming types.

### Phase 4 — Extended Capabilities

Features from further reference analysis and design work. Lower urgency than Phases 1–3 but high long-term value.

---

#### 22. ~~Source & Credibility Tracking~~

Absorbed into Feature 19 (Knowledge Graph Subsystem) — `source_type`, `source_ref`, and `credibility` are now first-class fields on both `entities` and `graph_edges`, generalising provenance tracking to the entire graph rather than memories alone.

---

#### 23. Episodic Memory Chains
**Source:** shodh-memory
**Impact:** Related memories from the same work session are currently disconnected atoms. Episodic grouping enables "what happened during this debugging session" as a single retrievable narrative unit, and supports temporal reasoning within an episode.

Add three optional fields:
- `episode_id: string | null` — groups memories into a named episode
- `sequence_number: integer | null` — ordering within the episode
- `preceding_memory_id: string | null` — explicit temporal chain link

New tools:
- `store_memories` gains `episode_id` and `sequence_number` params
- `get_episode(episode_id)` — retrieve all memories in an episode, ordered by sequence
- `list_episodes(limit, offset)` — browse episodes by recency

Schema: two nullable `Utf8` columns + one nullable `Int32` — SQLite schema migration.

---

#### 24. Proactive Context Tool
**Source:** shodh-memory
**Impact:** `search_memories` requires deliberate invocation. `get_startup_context` (Feature 20) fires once at session start. Proactive context is the missing middle: triggered by the *current conversation message*, it surfaces relevant memories mid-conversation without an explicit query from the agent.

New tool `proactive_context(context, max_results, threshold)`:
- `context` — the current user message or task description
- `max_results` — number of memories to surface (default: 5)
- `threshold` — minimum relevance score to surface (default: 0.65)

The tool embeds `context`, runs ANN search, and returns memories above threshold with their relevance scores. Designed to be called in a `UserPromptSubmit` hook as well as explicitly.

`auto_ingest: boolean` (default: false) — when true, the context string itself is stored as an `observation` memory, providing implicit feedback about what the agent found worth retrieving.

No schema changes. Pure search + optional store through existing service.

---

#### 25. ~~Decision Lineage Graph~~

Absorbed into Feature 19 (Knowledge Graph Subsystem) — the memory graph's lineage category covers this entirely.

---

#### 26. Backup & Restore
**Source:** shodh-memory
**Impact:** SQLite database is a single file. There is currently no way to take a snapshot, verify its integrity, or roll back after a bad consolidation run or accidental bulk delete.

New tools:
- `backup_create(description?)` — creates a SQLite backup, SHA-256 verifies the result, stores in a timestamped backup directory
- `backup_list` — list backups with timestamps, sizes, and descriptions
- `backup_verify(backup_id)` — check SHA-256 integrity without restoring
- `backup_restore(backup_id)` — restore from a verified snapshot (requires explicit confirmation flag)
- `backup_purge(keep_last_n)` — delete old backups beyond a retention count

SQLite's single-file format makes backup straightforward — a file copy or `.backup` command is sufficient. Integrity verification via SHA-256 adds safety for automated restore.

---

## Summary Table

| # | Feature | Phase | Schema Change |
|---|---------|-------|---------------|
| 27 | Conversation history indexing | **Done** | Yes — new `conversation_history` table |
| 1 | Date/time filtering in search | 1 | No |
| 2 | Flexible deletion (tags, time, dry_run) | 1 | No |
| 3 | Memory pinning | 1 | Yes — `pinned` column |
| 4 | Result pagination (offset) | 1 | No |
| 5 | Health & storage stats tools | 1 | No |
| 6 | Database maintenance tools | 1 | No |
| 7 | Response size controls | 1 | No |
| 8 | Memory archiving | 2 | Yes — `archived` column |
| 9 | Confidence & importance levels | 2 | Yes — two `Utf8` columns |
| 10 | TTL (auto-expiry) | 2 | Yes — `expires_at` column |
| 11 | Search modes (exact, hybrid) | 2 | No (FTS index only) |
| 12 | Tag-based search & filtering | 2 | No |
| 13 | Stale item detection | 2 | No |
| 14 | Duplicate detection & merge | 3 | No |
| 15 | Quality scoring system | 3 | Yes — `quality_score` column |
| 16 | Tag management system | 3 | Optional sidecar table |
| 17 | Document ingestion | 3 | No |
| 18 | Memory consolidation | 3 | No (requires #15) |
| 19 | Knowledge graph subsystem | 3 | Yes — `entity_types`, `edge_types`, `entities`, `graph_edges` |
| 20 | Session handoff system | 3 | No (sidecar store) |
| 21 | Formal memory type taxonomy | 3 | No |
| 22 | ~~Source & credibility tracking~~ | — | Absorbed into Feature 19 |
| 23 | Episodic memory chains | 4 | Yes — three nullable columns |
| 24 | Proactive context tool | 4 | No |
| 25 | ~~Decision lineage graph~~ | — | Absorbed into Feature 19 |
| 26 | Backup & restore | 4 | No (sidecar storage) |
