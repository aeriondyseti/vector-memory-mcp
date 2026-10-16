# Ideas

Things vector-memory could do someday. Nothing here is committed: an idea moves to [ROADMAP.md](ROADMAP.md) only
when it's decided, and can be deleted any time.

## Server

- **Treat a git worktree as its main repository's project.** The server's project is its working directory, so a
  session started in a worktree (`<repo>/.claude/worktrees/<name>`) files and searches under the worktree path,
  while file-memory sync files under the main repository's root (where Claude Code keeps the shared memory
  folder). Deriving the server's project from the git main working tree would make `scope: "project"` and the
  current-project boost find synced file memories from any worktree, and stop memories from being stranded under
  deleted worktree paths. Catch: waypoints are keyed per project, so worktrees of one repo would share one
  waypoint and parallel tasks in separate worktrees would overwrite each other's; waypoints would need their own
  key (e.g. per worktree or per branch). Existing rows filed under worktree paths would need a migration or
  an alias.

## Plugin

- **Offer to import file-based memories on first run.** The first time the plugin starts (no record of having
  asked), find existing Claude Code file-based memories (`~/.claude*/projects/*/memory/*.md`, skipping
  `MEMORY.md`) and ask whether to import them into vector memory, using the same mapping as file-memory sync
  (`file-memory:<path>` key, `description` + body → content, `metadata.type` → type).
  Remember the answer so it is asked once.

## Search

- **Keyword triggers.** Let a memory carry a list of trigger keywords that weigh more heavily in search than its
  content. Fits as one more weighted lane in the RRF fusion (beside vector, FTS and the graph lanes in
  `memory.repository.ts`) or a weighted FTS5 column; needs a migration and `store_memories` / `update_memories`
  params. Open questions: boost only, or guaranteed inclusion on a hit? Exact match or FTS tokens? Should
  triggers also feed `proactive_context`? File-memory sync could map a `keywords:` frontmatter field.
