# Ideas

Things vector-memory could do someday. Nothing here is committed: an idea moves to [ROADMAP.md](ROADMAP.md) only
when it's decided, and can be deleted any time.

## Plugin

- **Offer to import file-based memories on first run.** The first time the plugin starts (no record of having
  asked), find existing Claude Code file-based memories (`~/.claude*/projects/*/memory/*.md`, skipping
  `MEMORY.md`) and ask whether to import them into vector memory, using the same mapping as file-memory sync
  (frontmatter `name` → `file-memory:<name>` key, `description` + body → content, `metadata.type` → type).
  Remember the answer so it is asked once.

## Search

- **Keyword triggers.** Let a memory carry a list of trigger keywords that weigh more heavily in search than its
  content. Fits as one more weighted lane in the RRF fusion (beside vector, FTS and the graph lanes in
  `memory.repository.ts`) or a weighted FTS5 column; needs a migration and `store_memories` / `update_memories`
  params. Open questions: boost only, or guaranteed inclusion on a hit? Exact match or FTS tokens? Should
  triggers also feed `proactive_context`? File-memory sync could map a `keywords:` frontmatter field.
