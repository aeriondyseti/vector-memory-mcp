# Ideas

Things vector-memory could do someday. Nothing here is committed: an idea moves to [ROADMAP.md](ROADMAP.md) only
when it's decided, and can be deleted any time.

## Plugin

- **Offer to import file-based memories on first run.** The first time the plugin starts (no record of having
  asked), find existing Claude Code file-based memories (`~/.claude*/projects/*/memory/*.md`, skipping
  `MEMORY.md`) and ask whether to import them into vector memory, using the same mapping as file-memory sync
  (frontmatter `name` → `file-memory:<name>` key, `description` + body → content, `metadata.type` → type).
  Remember the answer so it is asked once.
