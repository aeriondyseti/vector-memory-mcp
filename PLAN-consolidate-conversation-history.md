# Plan: Consolidate Conversation History Infrastructure

After rebasing the `dev` branch, two parallel implementations of conversation history exist.
The active codebase uses Version B (`conversation.*` files), but Version A (`conversation-history.*` files)
has better infrastructure patterns worth adopting.

## Phase 1: Cleanup (no behavior changes)

### 1.1 — Delete dead Version A files

These files are only imported by each other; nothing in the active codebase uses them:

- `src/types/conversation-history.ts`
- `src/db/conversation-history.schema.ts`
- `src/db/conversation-history.repository.ts`
- `src/services/conversation-history.service.ts`
- `src/services/session-parser.ts`

### 1.2 — Consolidate `sql-utils.ts` into `lancedb-utils.ts`

`escapeSql()` and `escapeLanceDbString()` are identical (`value.replace(/'/g, "''")`).
The `RRF_K` constant also belongs with the other LanceDB utilities.

- Add `RRF_K` export to `lancedb-utils.ts`
- Rename `escapeLanceDbString` → `escapeSql` across the codebase
- Update imports in `memory.repository.ts` and `conversation.repository.ts`
- Delete `src/db/sql-utils.ts`

## Phase 2: Share infrastructure patterns

### 2.1 — Use `createRerankerMutex` in `ConversationRepository`

Currently `conversation.repository.ts` creates a fresh `RRFReranker` on every `findHybrid` call.
`MemoryRepository` already caches it via the mutex pattern from `lancedb-utils.ts`.

- Add `private getReranker = createRerankerMutex()` to `ConversationRepository`
- Replace `await rerankers.RRFReranker.create(RRF_K)` with `await this.getReranker()`
- Remove the direct `rerankers` import

### 2.2 — Use `createFtsMutex` in `ConversationRepository`

Currently uses inline FTS index management with manual `ftsIndexPromise` tracking.
The shared `createFtsMutex` does the same thing more robustly.

- Replace inline FTS management with `private ensureFtsIndex = createFtsMutex(() => this.getTable())`
- **Caveat**: Version B resets `ftsIndexPromise = null` after `insertBatch` and `deleteBySessionId`
  to force FTS re-creation when data changes. Options:
  - (a) Accept stale FTS indexes until restart (LanceDB may handle this transparently)
  - (b) Extend `createFtsMutex` to return a resettable handle

### 2.3 — Use `getOrCreateTable` in `ConversationRepository`

Currently has inline table creation logic. Version A's repository already uses
the shared `getOrCreateTable` from `lancedb-utils.ts`.

- Replace inline `getTable()` with `getOrCreateTable(this.db, CONVERSATION_TABLE_NAME, conversationSchema)`

## Phase 3: Deeper improvements (optional)

### 3.1 — Async file I/O in `ConversationHistoryService`

`conversation.service.ts` uses `readFileSync`/`writeFileSync` for the JSON index state file.

- Replace with `readFile`/`writeFile` from `fs/promises`
- Make `loadIndexState` async

### 3.2 — Tighten `SearchResult` to discriminated union

Version B's `SearchResult` uses a flat interface with optional fields.
A discriminated union on `source` provides better type narrowing.

- Split into `MemorySearchResult | HistorySearchResult`
- Update consumers to narrow on `source`

### 3.3 — Consider LanceDB session tracking (lowest priority)

Version A stored session tracking in an `indexed_sessions` LanceDB table (atomic with data).
Version B uses a JSON file. Only worth pursuing if sync issues arise in practice.

## Dependency graph

```
Phase 1.1 (delete dead files)  ─┐
Phase 1.2 (consolidate utils)  ─┤─→ Phase 2.1 (cached reranker)
                                 ├─→ Phase 2.2 (FTS mutex)
                                 └─→ Phase 2.3 (getOrCreateTable)

Phase 3.1 (async I/O)          ─ independent
Phase 3.2 (discriminated union) ─ independent
Phase 3.3 (LanceDB tracking)   ─ independent, lowest priority
```
