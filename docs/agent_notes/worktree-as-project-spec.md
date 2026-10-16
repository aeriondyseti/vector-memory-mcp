# Spec: treat a git worktree as its main repository's project

Status: draft, awaiting approval. Source: top item of `IDEAS.md` (Server).

## 1. Background (for readers new to this)

**Git worktree.** One repository can have several checked-out folders at once. The original is the *main working
tree* (e.g. `~/Development/vector-memory-mcp`). Each extra one is a *linked worktree*, made with
`git worktree add`. Claude Code puts its own under `<repo>/.claude/worktrees/<name>`. All of them share one `.git`
directory, which git calls the *common dir* (`<main>/.git`).

**Project.** Every memory row has a `project` column: a canonical absolute path made by `normalizeProject()`
(`server/core/project.ts`). Search uses it two ways. `scope: "project"` filters to the current project, and the
default `scope: "all"` boosts current-project results. Today the server's project is simply its working directory
(`server/config/index.ts:80`).

**The problem.** A session started in `<repo>/.claude/worktrees/foo` stamps and searches under that worktree path.
File-memory sync, though, files memories under the main repo root (`plugin/hooks/mods/index.ts:405`, via
`$.session.repo().root`), because that's where Claude Code keeps the shared memory folder. The result:

- from a worktree, `scope: "project"` can't see synced file memories, and they get no boost;
- memories stored from a worktree are stranded under its path once the worktree is deleted.

## 2. Decisions (confirmed with the user)

| Question | Decision |
|---|---|
| What is the waypoint keyed by? | **The worktree path**, which is the same key as today. Waypoints don't change. |
| What happens to existing rows filed under worktree paths? | A **one-time versioned migration** re-files them under the main repo. |
| Which folders count as worktrees? | **Any git worktree**, detected by asking git. Path patterns are used only for worktrees that were already deleted. |
| Which project does conversation history get? | **The main repo** too, using the same resolution. |
| Can searches target the workspace? | **Yes.** Rows also record their `workspace`. `scope: "workspace"` filters to it, and results from the current workspace rank above the rest of the repo (§7). |

## 3. Core idea: split one identity into two

Today one value, "project = cwd", does four jobs. We split it:

| Name | Value | Used for |
|---|---|---|
| **project** | main working tree root of the repo containing cwd, exactly what `$.session.repo().root` answers (cwd outside a repo) | memory stamping, search filter and boost, file memories, conversation history |
| **workspace** | `normalizeProject(cwd)`, exactly today's value | waypoint ID, server-discovery lockfile, the new `workspace` column, `scope: "workspace"` and the workspace boost |

Why keep `workspace`? Parallel sessions in two worktrees of one repo must not share a waypoint (they'd overwrite
each other), and each session's hooks must find *their own* server's lockfile. Keeping both on the cwd means
waypoints and server discovery behave **exactly as today**, so neither needs a migration. Recording it on every
row as well means a search can still tell "from this worktree" apart from "from this repo" (§7).

For a session at the root of a main checkout, or outside any repository, `project === workspace`, and nothing
changes. Sessions in a worktree *or a subdirectory* get `project !== workspace` (§4).

## 4. Resolving the project

New function in `server/core/project.ts`:

```ts
export function resolveProject(cwd: string): string
```

**Must match file-memory sync byte for byte.** File memories are filed under `$.session.repo().root`. That is a
Claude Code engine API (the `claude-code` module), not hook-kit. Its contract only says "the repository's root,
absolute: the main working tree's for a worktree; null outside a repository". So step 1 probed it: a throwaway mod
recorded `repo().root` from real fixture folders under Claude Code 2.1.301 (2026-10-16):

| Session started in | `repo().root` |
|---|---|
| main checkout | main root |
| **subdirectory of the main checkout** | **main root** (not the subdirectory) |
| `.claude/worktrees/wt`, or a subdirectory of it | main root |
| a worktree outside the repo (`git worktree add ../elsewhere`) | main root |
| a symlink to the checkout, or a subdirectory through it | main root, as a **real path** (the engine's session root is resolved too) |
| `/tmp/…` worktree (`/tmp` → `/private/tmp` on macOS) | `/private/tmp/…/main` |
| a folder outside any repository | `null` |

That is exactly `dirname(git rev-parse --path-format=absolute --git-common-dir)`, since git also answers real paths.
The probe also overturned the first draft's step 3, which kept a main-checkout *subdirectory* as its own project.
The engine folds it into the repo root, so the server must too, or a subdirectory session's file memories stay
unjoined. (Not probed: submodules and bare-repo worktrees, both rare; they keep the fallback below.)

Algorithm, as implemented in `server/core/project.ts` (tested by `tests/project-resolution.test.ts`):

1. Run `git -C <cwd> rev-parse --path-format=absolute --git-common-dir` (`Bun.spawnSync`, 2s timeout).
2. If it answers and `basename(commonDir) === ".git"`, return `normalizeProject(dirname(commonDir))`. That covers
   the main checkout, its subdirectories and every linked worktree, all through symlinks.
3. If it answers anything else (a submodule's `.git/modules/x`, a bare repository), there's no main checkout to
   fold into. Return `git rev-parse --show-toplevel`, or the folder if that fails.
4. If git fails (not a repo, git not installed, folder gone): for a folder that no longer exists and matches
   `^(.*)/\.claude/worktrees/[^/]+(/.*)?$`, return `normalizeProject(<group 1>)`. Otherwise return
   `normalizeProject(cwd)`.

Results are memoized per input path (a `Map`), so the history parser doesn't spawn git once per message.

`normalizeProject()` stays as-is: a pure string normalizer that every comparison still goes through. The server's
own `process.cwd()` is already a physical path (`getcwd` resolves symlinks), so nothing needs to resolve it first.

**Consequence: subdirectory sessions change too.** A session started in `<repo>/server` used to file under
`<repo>/server`; it now files under `<repo>`, with `<repo>/server` as its workspace. Migration v6 picks these rows up
with no extra work, because `resolveProject()` on an existing subdirectory answers the repo root.

## 5. Changes, file by file

### Server

| File | Change |
|---|---|
| `server/core/project.ts` | Add `resolveProject()` and the deleted-worktree pattern helper (§4). |
| `server/config/index.ts` | `project: normalizeProject(overrides.project ?? resolveProject(process.cwd()))`; new `workspace: normalizeProject(process.cwd())`. The existing `--project` flag still wins, which is the escape hatch. |
| `server/index.ts` | Pass `config.workspace` into `MemoryService`; the startup log shows both values when they differ. |
| `server/core/memory.service.ts` | Constructor takes `workspace`. `setWaypoint` / `getLatestWaypoint` default to `workspace` instead of `this.project` (an explicit `project` arg still wins, as the HTTP `/waypoint?project=` hook call does). Stamping and search use `workspace` as §7 describes; everything else keeps using `this.project`. |
| `server/core/memory.repository.ts` | `workspace` column in insert/upsert/row mapping; a `workspace = ?` condition beside every `project = ?` candidate filter (KNN, FTS, graph lanes, `queryMemories`). |
| `server/core/memory.ts` / `conversation.ts` | `workspace: string \| null` on the types. |
| `server/core/conversation.repository.ts` | Stamp and filter `workspace` on history rows. |
| `server/transports/mcp/tools.ts` + `handlers.ts` | `search_memories` `scope` gains `"workspace"` (schema at ~317 plus the SCOPE text at ~308; `get_session_context`'s own `scope` at ~743 stays `project`/`all`); `store_memories` gains optional `workspace` (path or `null`, §7). Results show `workspace` when it differs from `project`. |
| `server/transports/http/server.ts` | `writeLockfiles` / `removeLockfiles` take `config.workspace`, so hooks (which hash their cwd) still find the right server. |
| `server/core/parsers/claude-code.parser.ts` | `project = resolveProject(entry.cwd)` instead of `normalizeProject(entry.cwd)`. |
| `server/core/consolidation.service.ts:278` | A legacy `.vector-memory/` db found inside a worktree consolidates into the main repo's project (`resolveProject`). Waypoint re-keying there keeps using the folder path (workspace). |
| `server/core/migrations.ts` | Migration v6 (§6). |

### Plugin

Almost nothing changes, which is deliberate: the hooks only use their project value for lockfile discovery and the
`/waypoint?project=` fetch, and both stay cwd-keyed (= workspace).

- `plugin/hooks/scripts/hooks-lib.ts`: update the `currentProject()` doc comment to say it must match the server's
  **workspace**, not project. Possibly rename it to `currentWorkspace()`.
- `plugin/hooks/mods/index.ts:405`: keep passing the main root explicitly. It's now redundant with a new server,
  but still correct against older servers still cached by `bunx`. Also pass `workspace: null`: a file memory belongs
  to the whole repo, not to whichever worktree happened to sync it last (§7). `fileMemoryArgs` gains the field, and
  its tests assert it.

### Docs

- `CLAUDE.md` "Important Conventions": a project is the main repo root for worktrees; waypoints and locks are keyed
  by workspace.
- `plugin/skills/vector-memory-usage/SKILL.md`: "tagged with the project (the working directory)" becomes "the
  repository (worktrees share their main repo's project)".
- `CHANGELOG.md` `[Unreleased]`; remove the item from `IDEAS.md`.

## 6. Migration v6: re-file old worktree rows

**Where it runs.** `runVersionedMigrations` already gates one-shot changes with `PRAGMA user_version` inside
`BEGIN IMMEDIATE`, which takes a write lock so two servers starting at once can't both run it. The new step is
`version < 6`.

**Build the mapping first, outside the transaction.** Spawning git while holding the write lock would block other
processes.

1. `SELECT DISTINCT project` from `memories`, `conversation_history` and `conversation_index_state`.
2. For each value: if the folder exists, use `resolveProject()`; if it doesn't, use the `.claude/worktrees` pattern.
   Keep only entries where `new !== old`. A typical db yields a handful.

Inside the transaction, if the re-checked version is still < 6:

0. Add the `workspace` column to `memories` and `conversation_history` (`addColumnIfMissing`), add
   `idx_memories_workspace` and `idx_conversation_workspace`, and backfill **before** re-filing:
   `UPDATE memories SET workspace = project WHERE json_extract(metadata, '$.source') IS NOT 'file-memory'`, and the
   same for history. A row's original project *is* the folder it was stored from, so old worktree rows keep their
   worktree as workspace while their project moves to the main repo. File memories stay `NULL` (repo-wide).
1. `UPDATE memories SET project = ? WHERE project = ? AND id NOT LIKE 'wp:%'`. Waypoints keep their worktree
   project, because they're keyed by workspace.
2. `UPDATE conversation_history SET project = ?, metadata = json_set(metadata, '$.project', ?) WHERE project = ?`,
   the same shape as `repairConversationProjects`.
3. `UPDATE conversation_index_state SET project = ? WHERE project = ?`.
4. **Key dedupe.** Keyed memories (`metadata.key`, e.g. `file-memory:<path>`) supersede each other within one project
   (`memory.service.ts:313`). Merging two projects can leave two live rows with the same key under the main root.
   For each `(project, key)` with more than one live, non-superseded row, keep the newest and mark the others
   superseded by it, using the same columns `supersedeByKey` sets.
5. `PRAGMA user_version = 6`.

**Safety.** If the mapping is non-empty, take a `BackupService` snapshot before the transaction (verified by SHA-256)
and log one line: `re-filed N memories from M worktree paths; backup at …`. If the mapping is empty, it's a silent
no-op that still bumps the version.

**What it can't fix.** A deleted worktree *outside* `.claude/worktrees/` (made with `git worktree add ~/elsewhere`)
leaves no trace of which repo it belonged to, so those rows stay put. A later `consolidate`-style CLI could map them
manually if anyone needs it.

## 7. Searching by workspace

**Stamping.** Every new memory and history row stores a `workspace` beside its `project`:

- `store_memories` from a session: the server's `workspace`, if the memory is filed under the server's own
  project. If an explicit, different `project` is passed, `workspace` is `NULL`, because it's another repo and this
  folder means nothing there.
- An explicit `workspace` arg wins. `null` means "repo-wide", which is what file-memory sync sends.
- Conversation history: the session log's raw `cwd`, normalized. That cwd *is* the workspace.
- `update_memories` never changes `workspace`. Supersession by key copies the new row's workspace as usual.

**Filtering, `scope: "workspace"`.** Restricts to `workspace = <current workspace>`. Following the repo rule, this
is **pre-filtered** into KNN/FTS candidate selection, the same way `project` is, never applied to a global top-K
afterwards. That's why the column gets an index. Repo-wide rows (`NULL`) are excluded: a scope this narrow means
"what happened in this worktree". A caller who wants those rows too uses `scope: "project"`, which now ranks the
workspace first anyway (below).

**Explicit paths.** Today `scope: "<path>"` means "that project". The path now goes through `resolveProject()`, so
passing a worktree path searches its whole repo instead of matching nothing after the migration.

**Boosting.** `CURRENT_PROJECT_BOOST` (×1.15, `scope: "all"` only) becomes a tier, not a stack:

| Result row | `scope: "all"` | `scope: "project"` |
|---|---|---|
| Same workspace (session is in a linked worktree) | ×1.15 × `CURRENT_WORKSPACE_BOOST` (1.10) | × `CURRENT_WORKSPACE_BOOST` |
| Same project, other workspace or `NULL` | ×1.15 | ×1 |
| Other project | ×1 | (filtered out) |

- The workspace tier applies **only when `workspace !== project`**: a linked worktree, or a subdirectory (§4), where
  rows stored from that same subdirectory rank first. At the root of a main checkout, ranking is byte-for-byte
  today's. The alternative, also boosting
  main-checkout rows when in the main checkout, would push repo-wide file memories and worktree rows down for every
  main-checkout user. Easy to flip later if wanted.
- 1.10 is a starting value: enough to win ties inside the repo without hiding a clearly better match from a sibling
  worktree. It's a named constant, so tuning it is a one-line change.
- The same boost function also wraps conversation-history scores (`memory.service.ts:661`).
- Out of scope for now: `proactive_context`, `get_session_context` and the stale/duplicate tools keep working at
  project level.

## 8. Edge cases

| Case | Result |
|---|---|
| Not a git repo / git missing | project = cwd, same as today. |
| Main checkout root | Unchanged. |
| Subdirectory of a main checkout | Project becomes the repo root, as the engine answers (§4); workspace stays the subdirectory. |
| Folder reached through a symlink | Real path, from git and from the server's own `process.cwd()`, same as the engine. |
| Session started in a subdirectory of a worktree | Main repo root, which matches what file-memory sync uses. |
| Submodule | Its own toplevel, not the superproject (step 4). |
| Worktree of a bare repo | cwd (there's no main checkout to fold into). |
| Two sessions in two worktrees of one repo | Same project (they share memories); different workspaces (separate waypoints and lockfiles). |
| `EnterWorktree` mid-session | The server's cwd was fixed at launch, so its workspace and project stay the launch folder's. Hooks run in the new cwd and pass `?project=` explicitly. This is existing behaviour, not made worse; noted as a known limitation. |
| Older server version still running after migration | It may file a few new rows under a worktree path. Accepted; they're found again once that session upgrades. |
| `--project <path>` given | Used verbatim as project; workspace is still cwd. |
| Worktree deleted, then recreated with the same name | Its old rows have the same workspace path, so they're boosted again. Harmless, often useful. |
| `scope: "workspace"` in a main checkout | Rows stored from the main checkout itself (not from worktrees, not file memories). |

## 9. Tests (`bun:test`, in `tests/`)

Build real throwaway repos in a temp dir (`git init`, commit, `git worktree add`) so no git behaviour is mocked:

1. `resolveProject` (done, `tests/project-resolution.test.ts`): main checkout, subdir of main, Claude Code worktree,
   subdir of a worktree, worktree outside the repo, symlink and subdir through it (expected real path), non-repo
   folder, deleted `.claude/worktrees/x` path, deleted other path. Still to add with step 2: submodule.
2. Config: `project` and `workspace` from a worktree cwd; `--project` override.
3. Waypoints: two `MemoryService`s with one project and different workspaces set waypoints independently.
4. Search: a memory stored from a worktree session is found with `scope: "project"` from the main checkout and vice
   versa.
5. Migration v6: seed rows under a live worktree path, a deleted `.claude/worktrees` path and a `wp:` waypoint; assert
   re-filing, waypoint untouched, conversation tables updated, key dedupe, idempotency (a second run is a no-op),
   backup created only when rows move.
6. Parser: a session log whose `cwd` is a worktree yields the main root.
7. Lockfile: the server writes its lock at `globalLockPath(workspace)`; hooks-lib's hash of cwd matches.
8. Workspace stamping: session store, explicit other project (`NULL`), explicit `workspace: null`, history rows.
9. `scope: "workspace"`: finds only this worktree's rows, and with more matching rows elsewhere than the limit it
   still returns this workspace's (proves it's a pre-filter, not a post-filter).
10. Boost tiers: in a worktree, an equally relevant same-workspace row outranks a sibling-worktree row under both
    `"all"` and `"project"`; in a main checkout, scores equal today's.
11. Migration step 0: workspace backfilled from the *original* project; file memories `NULL`.

## 10. Implementation order

1. ~~Verify `$.session.repo().root` semantics (§4).~~ Done: probed, algorithm corrected, `resolveProject()` and
   `tests/project-resolution.test.ts` landed.
2. ~~`resolveProject` + tests~~ (landed with step 1; submodule case still to add).
3. Config split + `MemoryService` workspace + lockfile, with tests.
4. Parser + consolidation.
5. Migration v6 (column, backfill, re-file) + backup + tests.
6. Workspace stamping, `scope: "workspace"` pre-filter, boost tiers, tool schema, and the plugin's
   `workspace: null`, with tests.
7. Docs, CHANGELOG, remove the IDEAS item. `bun run typecheck && bun run test`.

One `feat/worktree-project` branch → PR → `main`. Likely a minor version bump, because default search results
change for worktree users.
