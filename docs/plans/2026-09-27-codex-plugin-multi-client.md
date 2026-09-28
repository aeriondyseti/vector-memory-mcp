# Codex Plugin & Multi-Client Shared Store — Spec

**Status:** Draft · **Date:** 2026-09-27 · **Target:** 3.1.0
**Builds on:** PR #15, merged (`plugin/` is the plugin root, with its own `package.json` + `bun.lock`)

## Goal

Let Codex and Claude Code (and several sessions of each) run against **one** memory store,
`~/.vector-memory/memories.db`, at the same time, and ship a Codex plugin with the same
experience the Claude Code plugin has: MCP tools, session-start context, conversation
indexing, the context-size monitor, and skills.

## Non-goals

- A single shared server daemon. Deferred; see [Alternatives](#alternatives-considered).
- Sync across machines.
- Replacing or importing Codex's built-in `memories` feature.
- Other agents (Cursor etc.). The work below keeps them in reach but doesn't target them.

## Background

### Process model today

Each client session spawns its own server over stdio (`plugin/.mcp.json` →
`bunx … vector-memory-mcp@latest --plugin --enable-history`). With `--plugin` the server
also opens HTTP (default port 3271, falling back to a random port) and writes a discovery
lockfile that the hooks use. **Two Claude Code sessions already produce the multi-process
case**, so most of Part A fixes bugs that exist today, not only for Codex.

### What's already safe

- WAL mode with `busy_timeout=5000` set before the WAL switch (`server/core/connection.ts:177-179`)
- Migrations gated by `PRAGMA user_version` inside `BEGIN IMMEDIATE` (`server/core/migrations.ts:188-241`)
- The legacy vec0 cleanup runs behind a read-only probe and an exclusive lockfile (`connection.ts:27-112`)
- Services are rebuilt per handler call, so there are no stale in-process caches (`handlers.ts:164`)
- Conversation re-indexing uses deterministic chunk ids plus `replaceSession` in one transaction, so no duplicate rows

### Gaps (ordered by severity)

| # | Problem | Where |
|---|---------|-------|
| G1 | **Lost updates.** `get()`, `vote()` and `update()` read the whole row, then `INSERT OR REPLACE` it, so concurrent writers overwrite each other and counters lose increments. Every hook's waypoint load goes through `get()`, so a waypoint read is a full-row write. | `memory.service.ts:150-252`, `memory.repository.ts:138-161`, `:1034` |
| G2 | **Discovery lockfile clobbering.** One lock per project (`locks/<sha(project)>.lock`), so the last server started wins, and when it exits it deletes the lock the other server's hooks rely on ("Server not ready"). | `http/server.ts:69-113`, `hooks-lib.ts:277-335` |
| G3 | **Backup/restore on a live db.** `copyFileSync` ignores the `-wal` file, so snapshots can be inconsistent. `restore` overwrites the file under open connections and leaves the old `-wal`/`-shm` in place, which risks corruption. | `backup.service.ts:93,158` |
| G4 | **Sidecar JSON read-modify-write** with no lock and non-atomic writes: `handoffs.json`, `backups-index.json`, `maintenance-history.json`. Concurrent writers lose entries, and a torn write reads back as `[]`. | `handoff.service.ts:31-81`, `backup.service.ts:60-109`, `maintenance.service.ts:200-217` |
| G5 | **No SQLITE_BUSY handling.** Transactions are deferred (`db.transaction()`), and there's no retry, so read-then-write transactions can fail with `SQLITE_BUSY_SNAPSHOT`. `VACUUM` in `optimize_database` blocks every other process past its 5 s timeout. | `conversation.repository.ts:211-233`, `maintenance.service.ts:117` |
| G6 | **No client identity.** No row records which client wrote it, and MCP `clientInfo` is ignored. | `migrations.ts:60-139` |
| G7 | **Indexing is Claude-only**, and concurrent sessions redo the same indexing work (correct, but wasteful). | `parsers/claude-code.parser.ts`, `conversation.service.ts:212-298` |

Found along the way: `projectSessionLogPath` only replaces `/`, so on Windows backslash
paths it likely points at a directory that doesn't exist (`hooks-lib.ts:256-259`). Fix this in M1.

### Codex extension surface (codex-cli 0.157.1; docs + `openai/codex` source)

| Concern | Claude Code | Codex |
|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json`, **falling back to `.claude-plugin/plugin.json`**. Also a root `plugin.json` "Agent Plugins v1" format, whose loader currently **drops hooks**, so avoid it. |
| Marketplace | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json`, with legacy support for `.claude-plugin/marketplace.json`. Install: `codex plugin marketplace add owner/repo`, then `codex plugin add`. |
| Install location | `~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/` | `~/.codex/plugins/cache/<mkt>/<plugin>/<ver>/` |
| npm dependency install | Automatic (`bun install --frozen-lockfile --ignore-scripts`) | **None.** |
| MCP config | `.mcp.json` (`{"mcpServers": …}`) | Same file format. Keys: `startup_timeout_sec` (**default 10 s**), `tool_timeout_sec`, `env_vars`, `cwd` (defaults to the session cwd). The environment is a **whitelist** (HOME, PATH, … / Windows core vars). |
| Hooks | `hooks/hooks.json`, shell `sh` | `hooks/hooks.json` in the plugin; bundled hooks are always on (`plugin_hooks` flag retired). Events: SessionStart (`startup\|resume\|clear\|compact`), Pre/PostToolUse, Pre/PostCompact, UserPromptSubmit, Stop, SessionEnd, … **Windows runs commands through `cmd.exe`** (`commandWindows` available). Users must **approve plugin hooks via `/hooks`** before they run. |
| Hook env | `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` | `PLUGIN_ROOT`, `PLUGIN_DATA`, **and the `CLAUDE_*` aliases** |
| Hook output | `systemMessage`, `hookSpecificOutput.additionalContext` | Same fields. `systemMessage` shows as a UI warning. SessionStart stdout text becomes developer context. |
| Transcripts | `~/.claude/projects/<proj>/<uuid>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, with `session_meta` (cwd, id) and per-turn `token_count` (`model_context_window`, `last_token_usage`). The newer "paginated" format replaces legacy message events with `ItemCompleted` turn items. Upstream calls `transcript_path` "not a stable interface". |
| Skills | `skills/*/SKILL.md` | The same open `SKILL.md` standard. Invoked as `$skill`. |

Codex also has a built-in `memories` feature (stable, off by default). It stores
Codex-only summaries under `~/.codex/memories`. It doesn't conflict with ours; see B6.

---

## Part A — Multi-client shared store

**Principle:** keep one independent server process per client session. Correctness comes
from SQLite (short `IMMEDIATE` write transactions, atomic column updates, everything
shared lives in the db), not from coordination between processes. Any number of
processes, from any client, can open the db.

### A1. Write-transaction discipline

- Add `withWriteTx(db, fn)` in `sqlite-utils.ts`. It runs `BEGIN IMMEDIATE … COMMIT`, retries
  `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` with jittered backoff (5 attempts, 50 ms → 800 ms),
  and then rethrows with a clear "database busy" error.
- Route every repository write through it. Replace the deferred `db.transaction()` in
  `replaceSession` and the other read-then-write transactions.
- Keep embedding work outside transactions (it mostly is already). Transactions stay
  under about 50 ms.

### A2. Remove lost updates (G1)

- `get()`: stop rewriting the row. Record the access with the existing atomic update path
  (`bulkUpdateAccess`: `access_count = access_count + 1`, `last_accessed = ?`).
- `vote()`: `UPDATE memories SET usefulness = usefulness + ? WHERE id = ?`.
- `update()`: update only the changed columns. Rewrite the vec/FTS rows only when
  `content` changes. Concurrent edits to *different* fields no longer clobber each other.
  Edits to the same field stay last-writer-wins, which is acceptable for now; an
  optional `expected_rev` is future work.
- `getLatestWaypoint()` no longer writes, apart from the atomic access bump.

### A3. Move sidecar JSON into the db (G4)

- New tables `handoffs`, `maintenance_history` and `backup_index` in migration **v3**
  (gated by `user_version`, inside `BEGIN IMMEDIATE`).
- The same migration imports any existing JSON files once, then renames them `*.migrated`.
- The services read and write the tables through A1.

### A4. Consistent backup and safe restore (G3)

- **Backup:** `VACUUM INTO '<path>'` produces a consistent snapshot that includes WAL
  content and doesn't block other readers. SHA-256 verification stays as it is.
- **Restore:** allowed only when this process is the **sole live server** (from A6's
  registry). Otherwise it fails with the list of live servers (pid, client, project).
  When it proceeds: `wal_checkpoint(TRUNCATE)`, close, swap the file in, delete the stale
  `-wal`/`-shm`, reopen.

### A5. Maintenance under concurrency (G5)

- `optimize_database`: run `VACUUM` only when this is the sole live server. Otherwise run
  `PRAGMA optimize`, `ANALYZE` and `wal_checkpoint(PASSIVE)`, and report that VACUUM was
  skipped and why.
- The `consolidate` CLI keeps its single transaction (it's an offline tool), but acquires it
  with `BEGIN IMMEDIATE` through A1.

### A6. Server registry and hook discovery (G2)

- Replace the per-project lock with a registry: `~/.vector-memory/servers/<pid>.json`
  containing `{pid, port, project, client, version, historyEnabled, startedAt}`.
  - Write it after binding and remove it on exit.
  - Any reader prunes entries whose pid is dead.
- Bind with `Bun.serve({ port: 0 })` fallback and retry on `EADDRINUSE`, removing the
  probe-then-bind race (`http/server.ts:343-349`).
- **Hook discovery:**
  - Prefer a live server with the same project and client, then any live server.
  - The db is shared and every hook request already passes `project`, so any server can
    answer.
- **Version skew:** hooks ship in the plugin but the server comes from `bunx @latest`, so
  they can drift. For one minor release, servers keep writing the legacy per-project lock
  (but only remove it if they own it), and new hooks fall back to reading it.
- The registry also answers "am I the sole server?" for A4 and A5.

### A7. Indexing coordination (G7, part 1)

- `POST /index-conversations` takes `{ path, format, project }`. `format` is
  `claude-code | codex`, and the server picks the matching parser (Part B4).
- The server indexes when asked. `--enable-history` keeps gating whether history appears
  in search, and no longer decides whether indexing happens.
- **Lease:** `conversation_index_state` gains `claimed_by` and `claim_expires_at`. A
  process claims a session in `BEGIN IMMEDIATE`. If another process holds a live claim
  (60 s), it skips that session. This removes the duplicate embedding work.

### A8. Client identity (G6)

- Record the client from the MCP `initialize` `clientInfo.name`, normalized to
  `claude-code | codex | <other>`. A `--client <name>` flag overrides it for clients that
  send nothing useful.
- Migration v3 adds a nullable `client TEXT` column to `memories`, `conversation_history`
  and `conversation_index_state`. Existing conversation rows are backfilled as
  `claude-code`; existing memories stay `NULL` (unknown).
- Writes stamp `client`, and results return it.
- `search_memories` gains an optional `client` filter. The default is all clients: a
  shared store is the point. There's no same-client boost; see Open question 5.
- Hook HTTP calls send `client` too.

### A9. Multi-process test harness

A new `tests/multi-process.test.ts` spawns K Bun worker processes (`Bun.spawn`) against a
temporary db:

- N concurrent `get` / `vote` on one memory: the final counters equal the exact sums.
- Concurrent `update` of different fields: both changes persist.
- Concurrent waypoint set/get across processes.
- Two processes index the same session: one set of rows, and embedding runs once (lease).
- `backup` during a write load: the snapshot opens and passes `integrity_check`.
- Concurrent `prepare_handoff`: nothing is lost.
- Registry: two servers in the same project, one exits, and hooks still discover the other.
- `restore` / `VACUUM` refuse while a second server is alive.

CI runs this on Linux, plus a **Windows job** for file-locking behavior.

---

## Part B — Codex plugin

### B1. Packaging: one plugin directory, two manifests

`plugin/` serves both clients:

```
plugin/
  .claude-plugin/plugin.json     # Claude Code (existing)
  .codex-plugin/plugin.json      # Codex (new): Codex reads this before .claude-plugin/
  .mcp.json                      # Claude Code MCP config
  codex.mcp.json                 # Codex MCP config (startup timeout, env_vars, --client codex)
  hooks/hooks.json               # Claude Code hooks
  hooks/codex-hooks.json         # Codex hooks (commandWindows, --client codex)
  hooks/scripts/…                # shared scripts, client-aware via --client
  skills/…                       # shared SKILL.md files
  package.json, bun.lock         # hook-kit
```

- **Why a separate Codex manifest** when Codex would read `.claude-plugin/plugin.json`
  anyway: Codex needs different MCP settings (`startup_timeout_sec`, `env_vars`) and
  different hook commands (`cmd.exe`, `--client codex`). The two manifests can point at
  different files while sharing the scripts and skills.
- **Marketplace:** add `.agents/plugins/marketplace.json` at the repo root with a local
  source of `./plugin`. Keep `.claude-plugin/marketplace.json` for Claude Code.
  - Install: `codex plugin marketplace add aeriondyseti/vector-memory-mcp`, then
    `codex plugin add vector-memory`.
- `sync-version.ts` also stamps `.codex-plugin/plugin.json` and
  `.agents/plugins/marketplace.json`.
- **Dependencies:** Codex doesn't install npm packages.
  - The hooks rely on **Bun's own auto-install, which follows the committed `bun.lock`**.
    Verified during PR #15: a plugin copy with no `node_modules` ran the hook and loaded
    hook-kit 1.1.0. The first hook run needs the network or Bun's global cache.
  - If B-verification shows this isn't reliable inside Codex's sandbox, fall back to a
    bootstrap that runs `bun install --frozen-lockfile` into `$PLUGIN_DATA` and points
    `NODE_PATH` there.

### B2. MCP server under Codex

`codex.mcp.json`:

```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "bunx",
      "args": ["-y", "--bun", "@aeriondyseti/vector-memory-mcp@latest",
               "--plugin", "--enable-history", "--client", "codex"],
      "startup_timeout_sec": 60,
      "env_vars": ["USERPROFILE", "LOCALAPPDATA", "BUN_INSTALL"]
    }
  }
}
```

- Codex gives MCP servers the session cwd, so `normalizeProject(cwd)` identifies the
  project correctly.
- `startup_timeout_sec: 60` covers a cold `bunx` download. The model loads lazily, so it
  doesn't add to startup.
- `env_vars` covers `homedir()` and Bun's cache on Windows. Which variables are actually
  needed will be confirmed during verification; see Open question 3.

### B3. Hooks under Codex

| Purpose | Claude Code event | Codex event | Script |
|---|---|---|---|
| Index conversations + load waypoint | SessionStart `start` | SessionStart `startup\|resume` | `session-start.ts --client codex` |
| Reset after `/clear` | SessionStart `clear` | SessionStart `clear` | `session-clear.ts --client codex` |
| After compaction | SessionStart `compact` | SessionStart `compact` (or PostCompact) | `session-compact.ts --client codex` |
| Context-size monitor | Stop, PostToolUse (throttled) | Stop, PostToolUse (throttled) | `context-monitor.ts --client codex` |

- **Commands:** `command` is `bun "${PLUGIN_ROOT}/hooks/scripts/<x>.ts" --client codex`.
  `commandWindows` uses the `%PLUGIN_ROOT%` form, because `cmd.exe` doesn't expand `${…}`.
  Whether Codex substitutes the placeholder itself is Open question 2.
- **Client-aware scripts:** `hooks-lib.ts` gains `--client`, which selects:
  - the transcript reader: Claude `message.usage` vs Codex `token_count` with
    `model_context_window` (exact, no model-window lookup table);
  - the session-log location: `~/.claude/projects/<proj>` vs `~/.codex/sessions`;
  - the index `format` sent to A7.
- **Output:** hook-kit's `toUser` (`systemMessage`) and `additionalContext` map one-to-one.
  Check that hook-kit's `parse()` accepts Codex payloads, which carry extra fields
  (`turn_id`, `model`, `last_assistant_message`) under the same event names. If it
  doesn't, add a Codex-tolerant mode in **hook-kit 1.2**.
- **Trust:** document that Codex users must approve the plugin's hooks via `/hooks` once.
  Without approval, the MCP tools still work; only automatic context loading, indexing and
  the monitor are off.

### B4. Codex conversation indexing (G7, part 2)

- A new `server/core/parsers/codex-rollout.parser.ts` implements `SessionLogParser`.
  - It scans `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, newest first, bounded by
    `conversation_index_state.lastModified`.
  - Session id and project come from `session_meta` (`id`, `cwd` → `normalizeProject`).
    Codex doesn't group sessions by project, so the parser filters on cwd.
  - Messages come from both shapes: legacy `response_item` / `event_msg` user and agent
    messages, and paginated `ItemCompleted` turn items. Tool noise is skipped using the
    existing chunking rules.
  - Unknown item types are ignored, never fatal, because the format isn't a stable
    interface.
- **Fixtures:** sanitized real rollouts in both formats under `tests/fixtures/codex/`.
- **Alternative (deferred):** reading through the Codex app-server `thread/read` API. It's
  more stable, but it needs the daemon and is experimental.

### B5. Skills

- The `SKILL.md` files are shared as they are; the format is compatible.
- Rewrite Claude-specific wording to be client-neutral: `/waypoint:set` becomes "the
  waypoint-set skill", and "Claude Code" becomes "your agent". Keep one set of files.
- Codex users invoke skills as `$waypoint-set`. Mention this in each skill's usage line.

### B6. Coexisting with Codex's built-in memories

- Ours is cross-agent and project-aware. Codex's covers Codex only and holds summaries.
  They don't conflict.
- The README recommends leaving Codex `memories` off when using this plugin, so memory
  isn't split across two systems, but both can run.
- `external_agent_memory_import` (under development in Codex) targets Claude Code's
  file-based memory, not this store. No action needed.

---

## Milestones

| Milestone | Scope | Release |
|---|---|---|
| **M1: Safe multi-process store** | A1–A6, A9, plus the Windows `projectSessionLogPath` fix. Useful to Claude-only users running several sessions. | `3.1.0-beta.1` (`@next`) |
| **M2: Client-aware server** | A7, A8, B4 (Codex parser + fixtures), `--client` flag | `3.1.0-beta.2` |
| **M3: Codex plugin** | B1–B3, B5, marketplace, `sync-version` updates, hook-kit 1.2 if needed | `3.1.0-beta.3` |
| **M4: Verify and document** | Verification matrix below, README/INSTALL for Codex, CHANGELOG | `3.1.0` (`@latest`) |

## Verification matrix

Run each scenario on Windows and Linux (and macOS if available):

1. Two Claude Code sessions, same project: waypoint set in A is visible in B; both keep hook discovery after either exits.
2. Codex only: plugin installs, hooks approved, MCP tools work, session-start context loads, rollouts are indexed, and the monitor warns at 50/75/90 %.
3. Claude Code and Codex, same project: a memory stored in one is found by `search_memories` in the other, with the correct `client` on each; counters are exact after mixed `get`/`vote`.
4. Different projects at once: no cross-project leakage beyond the `scope: "all"` behavior.
5. `optimize_database` and `backup_restore` with two clients live: they refuse or degrade as specified, with no corruption (`integrity_check`).
6. Version skew: a new server with old plugin hooks, and old server with new hooks. Discovery still works.
7. Cold start under Codex: empty Bun cache, first session. MCP starts within 60 s and the hooks resolve hook-kit.

## Alternatives considered

- **One shared daemon:** clients attach through a thin stdio→HTTP shim.
  - Pros: one embedding model in memory, no cross-process write races.
  - Cons: who starts and stops it, one crash takes every client down, version skew
    between clients and the daemon, and local auth.
  - Deferred. A6's registry and A7's request-scoped `format` / `project` are steps toward
    it, if it's ever needed.
- **A separate `codex-plugin/` directory:** rejected. It duplicates hooks, scripts and
  skills, and two manifests in one directory are enough.
- **The root `plugin.json` Agent Plugins v1 format:** rejected for now. Codex's loader drops
  hooks for that format (`core-plugins/src/loader.rs`), despite what the docs say.

## Open questions

1. Does Codex's legacy marketplace support resolve a string `"source": "./plugin"`? This is moot if we ship `.agents/plugins/marketplace.json`, but it decides whether Codex users can use the Claude marketplace file directly.
2. Does Codex substitute `${PLUGIN_ROOT}` in hook commands itself, or rely on the shell? This decides the `commandWindows` form.
3. Does Codex's Windows MCP environment whitelist include `USERPROFILE` / `LOCALAPPDATA`? This decides whether `env_vars` is needed.
4. Is hook-kit compatible with Codex payloads, or does it need a 1.2 release?
5. **Owner decision:** should search boost results from the same client? Proposed: no, treat all clients equally.
6. **Owner decision:** is the hook-trust step (approving hooks via `/hooks` in Codex) acceptable UX, or should the Codex plugin default to MCP tools only, with hooks opt-in?

## References

- Codex plugins: https://developers.openai.com/codex/plugins/build · hooks: https://learn.chatgpt.com/docs/hooks · MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli · skills: https://learn.chatgpt.com/docs/build-skills
- `openai/codex` source: `core-plugins/src/loader.rs`, `exec-server-protocol/src/protocol.rs`, `rollout/src/recorder.rs`, `rollout/src/policy.rs`, `hooks/src/engine/discovery.rs`, `rmcp-client/src/utils.rs`
- Claude Code plugin dependency install: https://code.claude.com/docs/en/plugins/loading.md#node-js-package-dependencies
