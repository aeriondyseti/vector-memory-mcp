---
name: waypoint:set
description: Save session context to vector memory for seamless resumption
user-invocable: true
disable-model-invocation: true
---

Create a comprehensive waypoint snapshot using vector-memory.

## 1. Extract & Store Memories

Review the session for significant items worth persisting long-term.

**Extract:**
- Architectural decisions and rationale
- Implementation patterns discovered or established
- Insights about the codebase structure
- Blockers encountered and their resolutions
- Context that would be valuable for future sessions

**Skip:**
- Pleasantries and conversational filler
- Ephemeral states (e.g., "currently running tests")
- Information already stored in previous memories

For each significant item, call `mcp__vector-memory__store_memories` with appropriate metadata tags.

## 2. Set Waypoint

Call `mcp__vector-memory__set_waypoint` with:

```
project: [repository/project name]
branch: [current git branch]
summary: [2-3 sentences: what was the primary goal, what's the current status]

completed:
- [specific items with file paths where relevant]
- [e.g., "Implemented user auth in src/auth/login.ts"]

in_progress_blocked:
- [items still in flight with current state]
- [blockers with context on what's needed]

key_decisions:
- [decisions made and WHY - rationale is crucial]
- [e.g., "Chose JWT over sessions because X, Y, Z"]

next_steps:
- [concrete, actionable items]
- [prioritized if possible]

memory_ids:
- [IDs returned from store_memories calls above]
```

## 3. Report to User

Summarize what was stored:
- Number of memories created
- Key topics captured
- Waypoint stored confirmation

## Guidelines

- **Be thorough but concise** - capture context that would take time to reconstruct
- **Include file paths** - makes resumption faster
- **Explain decisions** - future-you won't remember why
- **Link memories** - use memory_ids to connect related context
- **Skip the obvious** - don't store things easily discoverable from code
