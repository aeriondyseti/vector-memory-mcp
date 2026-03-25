---
name: waypoint:workflow
description: This skill should be used when the user asks to "set a waypoint", "save my progress", "save session state", "load waypoint", "resume work", "where were we", "what was I working on", "start a new session", "switch tasks", mentions "session persistence", "context management", or discusses when and how to use waypoints effectively. Provides guidance on the waypoint lifecycle for session continuity.
---

# Waypoint Workflow

Waypoints capture a structured snapshot of session state — what was accomplished, what decisions were made, and what comes next. They enable seamless session resumption across context boundaries.

## Core Concept

A waypoint is NOT a memory. Memories are individual facts, decisions, or insights stored via `mcp__vector-memory__store_memories`. A waypoint is a session-level summary that ties memories together with project state, providing a resume point.

**Waypoint = Session State Snapshot**
- Summary of work done
- Key decisions and rationale
- Items in progress or blocked
- Concrete next steps
- Links to related memory IDs

## When to Set a Waypoint

### After Completing a Discrete Task

Set a waypoint whenever a logical unit of work finishes:
- Feature implementation complete
- Bug fix verified
- Refactoring done
- Investigation concluded with findings

**Anti-pattern:** Setting a waypoint mid-task creates confusing resume points. Wait for a natural stopping point.

### Before Clearing Context

Always set a waypoint before running `/clear`. Context clearing without a waypoint means losing all session state. The plugin's `/clear` detection hook provides a safety net, but explicitly setting one is better practice.

### Before Switching Tasks

When pivoting to a different area of work, set the current state first. This preserves the mental model of the previous task for clean resumption later.

### At Regular Intervals in Long Sessions

Long sessions accumulate context that becomes expensive to reconstruct. Set waypoints periodically to create recovery points. The plugin's context monitor warns at 50% and 75% context usage — treat these as waypoint prompts.

## When to Load a Waypoint

### Session Start

At the beginning of each session, load the waypoint to restore context. The plugin's SessionStart hook suggests this automatically. To continue previous work, accept; to start fresh, decline.

### After Context Clearing

If context was cleared mid-project, load the waypoint to restore orientation.

### Returning After a Break

When resuming work on a project after time away, the waypoint provides faster orientation than re-reading code.

## The Waypoint-Memory Relationship

Waypoints and memories serve different purposes and work together:

1. **Extract memories first** — review the session for significant decisions, insights, patterns, and blockers. Store each as an individual memory via `mcp__vector-memory__store_memories` with appropriate metadata type tags (`decision`, `implementation`, `insight`, `blocker`, `next-step`, `context`).

2. **Then set the waypoint** — call `mcp__vector-memory__set_waypoint` with the summary, completed items, next steps, and the memory IDs returned from step 1.

3. **On load, both are retrieved** — `/waypoint:get` loads the waypoint AND searches for relevant memories, plus fetches any specifically linked memory IDs.

This two-step process ensures individual insights persist as searchable memories while the waypoint provides the session-level narrative that ties them together. See the **vector-memory-usage** skill for guidance on writing high-quality memories.

## Best Practices

### Writing Effective Waypoints

1. **Be specific about state** — "Implemented auth middleware in `src/middleware/auth.ts`, passing all 12 tests" is better than "worked on auth"
2. **Include file paths** — accelerates resumption by pointing directly to relevant code
3. **Explain decisions with rationale** — "Chose JWT over sessions because the API is stateless and serves mobile clients" captures the WHY
4. **Make next steps actionable** — "Add rate limiting to `/api/login` endpoint" is better than "improve security"
5. **Link memories** — include memory_ids from the extraction step to connect related context

### Waypoint Hygiene

- **One waypoint per project** — each store overwrites the previous waypoint
- **Set before clearing** — always set a waypoint before `/clear` to prevent data loss
- **Keep summaries concise** — 2-3 sentences for the summary field
- **Completed items with specifics** — include file paths, test counts, concrete outcomes
- **Skip ephemeral state** — omit "currently running tests" or similar transient info

### Anti-Patterns to Avoid

- **Setting a waypoint mid-task** — creates confusing resume points with half-done work
- **Skipping next_steps** — the most valuable part for resumption; always include them
- **Vague summaries** — "worked on stuff" provides no value
- **Setting without memories** — extract important decisions/insights as individual memories via `mcp__vector-memory__store_memories` first, then reference their IDs in the waypoint
- **Ignoring context warnings** — when the context monitor warns, take action

## Example Waypoint

A well-structured waypoint looks like this:

```
project: "acme-api"
branch: "feature/user-auth"
summary: "Implemented JWT-based authentication with refresh tokens. All 18 auth tests passing. Ready to add rate limiting."

completed:
- "JWT auth middleware in src/middleware/auth.ts with RS256 signing"
- "Refresh token rotation in src/services/token.service.ts"
- "Auth routes: POST /login, POST /refresh, POST /logout in src/routes/auth.ts"
- "18 tests passing in tests/auth.test.ts"

in_progress_blocked:
- "Rate limiting design not started yet"

key_decisions:
- "Chose JWT over sessions because API is stateless and serves mobile clients"
- "Used RS256 (asymmetric) over HS256 for future microservice token verification"
- "Refresh tokens stored in httpOnly cookies, not localStorage, for XSS protection"

next_steps:
- "Add rate limiting to /login endpoint (consider express-rate-limit)"
- "Add password reset flow"
- "Set up CI pipeline for auth tests"

memory_ids:
- "mem_a1b2c3"
- "mem_d4e5f6"
```

## Workflow Pattern

The recommended workflow for each work session:

```
1. Session starts → Load waypoint (/waypoint:get)
2. Work on tasks
3. Context monitor warns at 50% → Consider setting a waypoint soon
4. Complete discrete task → Set waypoint (/waypoint:set)
5. Clear context (/clear) → Fresh context for next task
6. Repeat from step 1
```

This cycle prevents context rot, keeps token usage efficient, and ensures memories remain high-quality.

## Commands and Tools Reference

| Command / Tool | Purpose |
|----------------|---------|
| `/waypoint:get` | Load waypoint + recent git activity + relevant memories |
| `/waypoint:set` | Extract memories from session, then set waypoint snapshot |
| `mcp__vector-memory__set_waypoint` | Underlying MCP tool for storing waypoint data |
| `mcp__vector-memory__get_waypoint` | Underlying MCP tool for retrieving the latest waypoint |
| `mcp__vector-memory__store_memories` | Store individual memories before setting waypoint |
| `mcp__vector-memory__search_memories` | Search for relevant memories during waypoint load |
