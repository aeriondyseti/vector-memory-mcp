# Plan: Consolidate Conversation History Infrastructure

**Status: COMPLETE** (Phases 1-3.1 done)

After rebasing the `dev` branch, two parallel implementations of conversation history existed.
The active codebase uses Version B (`conversation.*` files), and Version A (`conversation-history.*` files)
had better infrastructure patterns that have now been adopted.

## Phase 1: Cleanup — DONE

### 1.1 — Delete dead Version A files — DONE

Deleted 5 source files + 3 test files that were only imported by each other.

### 1.2 — Consolidate `sql-utils.ts` into `lancedb-utils.ts` — DONE

Merged `escapeSql` and `RRF_K` into `lancedb-utils.ts`, updated all imports, deleted `sql-utils.ts`.

## Phase 2: Share infrastructure patterns — DONE

### 2.1 — Use `createRerankerMutex` in `ConversationRepository` — DONE

Replaced per-query `rerankers.RRFReranker.create(RRF_K)` with cached `createRerankerMutex()`.

### 2.2 — Use `createFtsMutex` in `ConversationRepository` — DONE

Replaced inline FTS management with `createFtsMutex()`. For the reset-after-mutation caveat,
the solution is to reassign `this.ensureFtsIndex = createFtsMutex(...)` after `insertBatch`
and `deleteBySessionId` — cheap (new closure) and equivalent to the old `ftsIndexPromise = null`.

### 2.3 — Use `getOrCreateTable` in `ConversationRepository` — DONE

Replaced inline table creation with `getOrCreateTable()` from `lancedb-utils.ts`,
with caller-side caching via `tablePromise`.

## Phase 3: Deeper improvements

### 3.1 — Async file I/O in `ConversationHistoryService` — DONE

Replaced `readFileSync`/`writeFileSync`/`mkdirSync` with async `readFile`/`writeFile`/`mkdir`
from `fs/promises`. Made `loadIndexState` and `saveIndexState` async.

### 3.2 — Tighten `SearchResult` to discriminated union

Version B's `SearchResult` uses a flat interface with optional fields.
A discriminated union on `source` would provide better type narrowing.

- Split into `MemorySearchResult | HistorySearchResult`
- Update consumers to narrow on `source`

### 3.3 — Consider LanceDB session tracking (lowest priority)

Version A stored session tracking in an `indexed_sessions` LanceDB table (atomic with data).
Version B uses a JSON file. Only worth pursuing if sync issues arise in practice.
