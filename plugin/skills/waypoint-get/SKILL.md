---
name: waypoint:get
description: Load project context from waypoint + git + vector memories
user-invocable: true
disable-model-invocation: true
---

Load context for current project using vector-memory.

## 1. Check Git

```bash
git log --oneline -10 2>/dev/null
git branch --show-current 2>/dev/null
```

## 2. Fetch Waypoint

Call `mcp__vector-memory__get_waypoint` to retrieve the latest waypoint snapshot.

After reading waypoint, check for staleness:
```bash
git log --oneline --since="[waypoint date]" 2>/dev/null
```

**If commits exist after waypoint:** Show them, ask user whether to use waypoint or skip it.

**If no waypoint exists:** Note it and continue to step 3.

## 3. Search Memories

Call `mcp__vector-memory__search_memories` with:
- query: "[project name] architecture decisions patterns"
- intent: "continuity"
- reason_for_search: "Loading project context for session resumption"
- limit: 10

## 4. Load Referenced Memories

If the waypoint includes memory IDs, call `mcp__vector-memory__get_memories` with those IDs to retrieve full context.

## 5. Present Context

```markdown
# Context: [Project]
**Dir:** [path] | **Branch:** [branch] | **Waypoint:** [date or None]

## Git Activity
[recent commits]

## State
[from waypoint summary, completed items, blockers]

## Next Steps
[from waypoint next_steps]

## Relevant Memories
[key memories from search + referenced memories]
```

## 6. Synthesize & Continue

Combine waypoint document with retrieved memories to establish full context. Then:

1. Briefly acknowledge what was loaded (waypoint date + number of memories retrieved)
2. Confirm current status and next steps from waypoint
3. Ask: "Ready to continue with [next step], or is there a different direction?"

**No waypoint / no memories:** Just note it and ask what we're working on.
