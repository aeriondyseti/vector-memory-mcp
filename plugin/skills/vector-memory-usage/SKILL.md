---
name: vector-memory-usage
description: This skill should be used when the user asks to "store a memory", "remember this", "search memories", "what did we decide", "find relevant context", "update a memory", "delete a memory", "that memory was useful", discusses "memory quality", "memory best practices", "proactive memory search", or when guidance is needed on when and how to use the vector memory system effectively. Provides patterns for storing, searching, and leveraging semantic memories across sessions.
---

# Vector Memory Usage

The vector memory system provides semantic, project-scoped memory storage. Memories persist across sessions and are retrieved via semantic search — meaning queries find relevant memories by meaning, not just keyword matching.

## Database Storage and Version Control

The vector-memory MCP server stores its database as a single SQLite file (`.vector-memory/memories.db`) inside the project directory. **This database should be committed to version control by default.** Committing the database ensures:

- **Portability** — cloning the repo includes all accumulated project context, so new sessions (or new machines) start with full memory intact
- **Collaboration** — teammates benefit from shared architectural decisions, known blockers, and implementation insights
- **Durability** — the database is backed up alongside the code it describes, preventing accidental loss

The database is a single SQLite file with sqlite-vec for vector search and FTS5 for full-text search. If a project has sensitive memories that should not be committed, add `.vector-memory/` to `.gitignore` on a per-project basis — but the default expectation is to commit it.

## When to Proactively Search Memories

Search memories BEFORE making decisions or assumptions. The cost of an unnecessary search is low; the cost of missing relevant context is high.

### Mandatory Search Triggers

- **Architectural decisions** — before choosing a library, pattern, or approach, search for prior decisions on the same topic
- **Debugging unfamiliar code** — search for implementation notes, known issues, or past resolutions
- **Starting a new task** — search for relevant context, prior attempts, or related decisions
- **Referential ambiguity** — when the user says "the project", "that bug", "last time", "as we discussed", search to resolve the reference
- **Repeated patterns** — when implementing something similar to past work, search for the established pattern

### Recommended Search Triggers

- **Before suggesting solutions** — check if the problem was solved before
- **When encountering unfamiliar conventions** — search for project-specific patterns or standards
- **Code review context** — search for why code was written a certain way before suggesting changes
- **Configuration questions** — search for prior setup decisions and rationale

## Writing Effective Search Queries

### Use Natural Language with Keywords

Good queries combine intent with specific terms:

| Scenario | Query | Intent |
|----------|-------|--------|
| Resuming work | "authentication system architecture" | `continuity` |
| Checking a decision | "database choice PostgreSQL vs SQLite" | `fact_check` |
| Finding patterns | "error handling patterns API endpoints" | `frequent` |
| Exploring connections | "performance optimization caching" | `associative` |
| Creative exploration | "alternative approaches to state management" | `explore` |

### Search Intents

Call `mcp__vector-memory__search_memories` with the appropriate intent:

- **continuity** — resuming work, finding recent context (favors recency)
- **fact_check** — verifying decisions or specifications (favors relevance)
- **frequent** — finding common patterns or preferences (favors utility)
- **associative** — brainstorming, finding connections (high relevance + variety)
- **explore** — stuck or creative mode (balanced + diverse results)

### Always Provide a Reason

The `reason_for_search` field forces intentional retrieval. Be specific:
- "Checking if there's a prior decision on auth approach before suggesting JWT"
- "Looking for known issues with the payment module before debugging"

## Storing High-Quality Memories

### One Concept Per Memory

Each memory should be self-contained and capture exactly one idea:

**Good:**
```
"Chose libSQL over PostgreSQL for the Resonance project because
of native vector support and simpler single-file deployment for local-first
architecture."
```

**Bad:**
```
"Uses SQLite"
```

The good example includes: what was decided, for which project, and why. The bad example lacks context, subject, and reasoning.

### Memory Content Rules

- **1-3 sentences** (20-75 words) per memory
- **Self-contained** — use explicit subjects, never "it", "this", "the project"
- **Include dates/versions** when relevant
- **Be concrete** — specific file paths, tool names, version numbers

### Using embedding_text for Long Content

When memory content exceeds ~1,000 characters, provide an `embedding_text` field with a concise searchable summary. The embedding is generated from `embedding_text` instead of the full content, ensuring the memory remains discoverable:

```json
{
  "content": "[detailed multi-paragraph implementation notes...]",
  "embedding_text": "Authentication middleware implementation using JWT with RS256 signing and refresh token rotation",
  "metadata": { "type": "implementation" }
}
```

### What to Store

Call `mcp__vector-memory__store_memories` with appropriate metadata type tags:

| Type | Store | Example |
|------|-------|---------|
| `decision` | What was chosen + why | "Chose Drizzle ORM over Prisma for type safety and SQL-like syntax" |
| `implementation` | What was built + where + patterns | "Auth middleware in src/middleware/auth.ts uses JWT with RS256 signing" |
| `insight` | Learning + why it matters | "sqlite-vec virtual tables require DELETE+INSERT, not INSERT OR REPLACE" |
| `blocker` | Problem + resolution | "CORS errors resolved by adding origin whitelist in server config" |
| `next-step` | TODO + suggested approach | "Add rate limiting to API; consider express-rate-limit middleware" |
| `context` | Background info + constraints | "Project targets Node 20+ only; can use native fetch and crypto" |

### What NOT to Store

- Machine-specific paths or local environment details
- Ephemeral states ("tests are currently failing")
- Information easily discoverable from code
- Pleasantries or conversational filler
- Duplicate information already in existing memories

## Updating and Deleting Memories

### When to Update

Call `mcp__vector-memory__update_memories` when a memory's content is still conceptually valid but needs correction or refinement:

- A decision's rationale needs clarification
- An implementation detail changed (new file path, different approach)
- A version number or date needs updating
- The embedding_text should be improved for better search discoverability

Updating preserves the memory ID, so any waypoint references to it remain valid.

### When to Delete

Call `mcp__vector-memory__delete_memories` when a memory is no longer relevant:

- A decision was reversed entirely
- A feature was removed from the codebase
- Information is outdated and misleading
- A duplicate was accidentally created

Deletion is a soft-delete — the memory can be recovered by searching with `include_deleted: true`. This means it is safe to delete aggressively when memories become stale.

**Rule of thumb:** If the memory needs minor corrections, update it. If it no longer reflects reality, delete it.

## Memory Usefulness Feedback

Call `mcp__vector-memory__report_memory_usefulness` after retrieving memories to indicate whether they were helpful. This feedback loop is important for search quality:

- **Report useful** when a memory directly informed a decision, resolved ambiguity, or saved time
- **Report not useful** when a memory was irrelevant to the query, outdated, or misleading
- Reporting consistently helps the system learn which memory patterns provide value
- Skipping reports means the system cannot improve its ranking over time

## Tools Reference

All tools use the `mcp__vector-memory__` prefix:

| Tool | Purpose |
|------|---------|
| `mcp__vector-memory__search_memories` | Semantic search with intent-based ranking |
| `mcp__vector-memory__store_memories` | Persist new memories (batch supported) |
| `mcp__vector-memory__get_memories` | Retrieve specific memories by ID |
| `mcp__vector-memory__update_memories` | Modify existing memories in place |
| `mcp__vector-memory__delete_memories` | Soft-delete outdated memories (recoverable) |
| `mcp__vector-memory__report_memory_usefulness` | Feedback on memory quality |

For session-level snapshots, see the **waypoint-workflow** skill which covers `mcp__vector-memory__set_waypoint` and `mcp__vector-memory__get_waypoint`.
