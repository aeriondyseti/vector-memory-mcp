# Manual Smoke Test Checklist — vector-memory-mcp 2.0

Run through these scenarios after the automated smoke test passes (`bun run smoke`).
Each section is independent — you can run them in any order.

Check off items as you go by editing this file or copying to a scratch pad.

---

## Prerequisites

- A working local build: `bun install` completes without errors
- The automated smoke test passes: `bun run smoke` exits 0
- Claude Code CLI installed and functional
- (Optional) A repo with LanceDB 1.x data for Section E

```bash
# Set this to your local clone of vector-memory-mcp
export PACKAGE_DIR="$HOME/Development/tools/vector-memory-mcp"
```

---

## A. Fresh Install Experience

Tests the first-run path a new user would hit.

```bash
# 1. Create an isolated temp directory
FRESH=$(mktemp -d)
cd "$FRESH"
git init && echo '{}' > package.json
```

```bash
# 2. Install the package (use link for local dev)
cd $PACKAGE_DIR
bun link
cd "$FRESH"
bun link @aeriondyseti/vector-memory-mcp
```

```bash
# 3. Verify warmup downloads the embedding model
bunx vector-memory-mcp warmup
```

- [ ] Output shows model download progress or "already cached"
- [ ] No errors in output

```bash
# 4. Add MCP config to Claude Code settings
# Add to ~/.claude/settings.json under mcpServers:
#   "vector-memory": {
#     "command": "bunx",
#     "args": ["vector-memory-mcp"],
#     "env": {}
#   }
```

```bash
# 5. Start Claude Code in the temp directory
cd "$FRESH"
claude
```

- [ ] Server starts (look for "HTTP server listening" in Claude Code's MCP stderr)
- [ ] No crash or error on startup

```
# 6. Inside Claude Code, test basic operations:
> Store a memory: "The speed of light is 299,792,458 m/s"
> Search memories for "speed of light"
```

- [ ] Store succeeds (Claude confirms memory stored)
- [ ] Search returns the memory you just stored

```bash
# 7. Cleanup
rm -rf "$FRESH"
```

---

## B. Plugin Hook Integration

Tests the cc-plugins vector-memory plugin hooks (session-start banner, waypoint resume).

**Prerequisite:** cc-plugins vector-memory plugin installed or symlinked into your hooks.

```bash
# 1. Open a repo that has a .vector-memory/ directory
cd $PACKAGE_DIR   # or any repo with the plugin configured
claude
```

- [ ] Session-start hook fires on entry
- [ ] Banner displays either waypoint info or "fresh session" message
- [ ] No errors in hook output

```
# 2. Set a waypoint inside Claude Code
> /vector-memory:waypoint-set
```

- [ ] Waypoint set confirmation displayed
- [ ] No errors

```
# 3. Clear session and re-enter
> /clear
```

- [ ] Session-start hook fires again
- [ ] Banner now shows the waypoint you just set
- [ ] Referenced memories (if any) are displayed in the banner

---

## C. Conversation History Flow

Tests that conversation indexing captures real multi-turn sessions.

```bash
# 1. Start server with history enabled (automated smoke test already verified this,
#    but here we test with a REAL Claude Code conversation)
cd $PACKAGE_DIR
claude
```

```
# 2. Have a multi-turn conversation (3+ exchanges)
> What embedding model does this project use?
> How does the hybrid search work?
> What tables are in the SQLite schema?
```

```
# 3. Trigger indexing (via tool call or session-start hook)
> Index my conversation history
```

- [ ] Indexing completes without errors
- [ ] Reports at least 1 session indexed

```
# 4. Search history
> Search my conversation history for "hybrid search"
```

- [ ] Returns fragments from the conversation you just had

```
# 5. Test date filters (via direct tool call)
> Search conversation history for "embedding" with history_after set to today's date
```

- [ ] Returns only recent results (from today)

---

## D. Multi-Session Port Discovery

Tests that two independent server instances don't collide.

```bash
# Terminal 1: Start Claude Code in repo A
cd $PACKAGE_DIR
claude
```

```bash
# Terminal 2: Start Claude Code in a DIFFERENT repo
cd /tmp
mkdir smoke-repo-b && cd smoke-repo-b
git init
claude
```

```bash
# Terminal 3: Inspect lockfiles
cat $PACKAGE_DIR/.vector-memory/server.lock
cat /tmp/smoke-repo-b/.vector-memory/server.lock
```

- [ ] Both lockfiles exist
- [ ] Ports are different
- [ ] Both PIDs are alive (`kill -0 <pid>` returns 0)

```
# In Terminal 1 (repo A):
> Store a memory: "This memory belongs to repo A"

# In Terminal 2 (repo B):
> Search memories for "repo A"
```

- [ ] Memory stored in repo A does NOT appear in repo B's search results
- [ ] This confirms per-directory data isolation

```bash
# Close Terminal 1's Claude Code session (Ctrl+C or /exit)
# Then check:
cat $PACKAGE_DIR/.vector-memory/server.lock
```

- [ ] Lockfile for repo A is gone (cleaned up on exit)
- [ ] Repo B's server is still running

```bash
# Cleanup
rm -rf /tmp/smoke-repo-b
```

---

## E. Migration UX (with real 1.x data)

**Skip this section if you don't have a repo with LanceDB data from vector-memory-mcp 1.x.**

```bash
# 1. Locate your 1.x data directory
ls -la <your-repo>/.vector-memory/memories.db/
# Should be a DIRECTORY (LanceDB), not a file
```

```bash
# 2. Attempt to start the 2.0 server against it
cd <your-repo>
bun run $PACKAGE_DIR/src/index.ts
```

- [ ] Server refuses to start
- [ ] Error message clearly says "Legacy LanceDB data detected"
- [ ] Error message tells you to run `vector-memory-mcp migrate`

```bash
# 3. Run the migration
bun run $PACKAGE_DIR/src/index.ts migrate
```

- [ ] Progress output shows memory count and conversation chunk count
- [ ] Completes with "Migration complete!" message
- [ ] Output shows file size and next-steps instructions

```bash
# 4. Follow the next-steps
mv <your-repo>/.vector-memory/memories.db <your-repo>/.vector-memory/memories.db.lance-backup
mv <your-repo>/.vector-memory/memories.db.sqlite <your-repo>/.vector-memory/memories.db
```

```bash
# 5. Restart the server
cd <your-repo>
bun run $PACKAGE_DIR/src/index.ts
```

- [ ] Server starts successfully with SQLite backend
- [ ] No migration warnings

```bash
# 6. Verify data survived
# In Claude Code or via curl:
curl -s http://127.0.0.1:3271/search -H 'Content-Type: application/json' \
  -d '{"query": "<something you know was in your 1.x data>", "intent": "fact_check"}' | jq .
```

- [ ] Search returns memories that existed in your LanceDB data

---

## F. Error Resilience

Tests graceful handling of edge cases.

### F1. Stale lockfile recovery

```bash
# 1. Start a server, note its PID
cd /tmp && mkdir smoke-resilience && cd smoke-resilience
bun run $PACKAGE_DIR/src/index.ts --port 3299 &
SERVER_PID=$!
cat .vector-memory/server.lock
```

```bash
# 2. Kill it ungracefully (simulates crash)
kill -9 $SERVER_PID
```

```bash
# 3. Verify stale lockfile remains
cat .vector-memory/server.lock
```

- [ ] Lockfile still exists (wasn't cleaned up because SIGKILL skips handlers)

```bash
# 4. Start a new server — it should handle the stale lockfile
bun run $PACKAGE_DIR/src/index.ts --port 3299 &
NEW_PID=$!
sleep 1
cat .vector-memory/server.lock
```

- [ ] New server starts successfully (the port should be available since old process is dead)
- [ ] New lockfile is written with new PID

```bash
# Cleanup
kill $NEW_PID 2>/dev/null; rm -rf /tmp/smoke-resilience
```

### F2. Port conflict auto-discovery

```bash
# 1. Start two servers on the same port
cd /tmp && mkdir smoke-port-a smoke-port-b

cd /tmp/smoke-port-a
bun run $PACKAGE_DIR/src/index.ts --port 3299 &

cd /tmp/smoke-port-b
bun run $PACKAGE_DIR/src/index.ts --port 3299 &
```

- [ ] First server binds to port 3299
- [ ] Second server logs "Port 3299 is in use, finding an available port..."
- [ ] Second server binds to a different port

```bash
# Verify different ports
cat /tmp/smoke-port-a/.vector-memory/server.lock
cat /tmp/smoke-port-b/.vector-memory/server.lock
```

- [ ] Ports are different

```bash
# Cleanup
kill %1 %2 2>/dev/null; rm -rf /tmp/smoke-port-a /tmp/smoke-port-b
```

### F3. Empty query handling

> **Note:** This test assumes a server is running on port 3271 (e.g., from Section D or E).
> If no server is running, start one first:
> `cd /tmp && mkdir -p smoke-f3 && cd smoke-f3 && bun run $PACKAGE_DIR/src/index.ts &`

```bash
# Send an empty query to the search endpoint
curl -s http://127.0.0.1:3271/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "", "intent": "fact_check"}' | jq .
```

- [ ] Returns a 400 error with a clear message (not a 500 crash)

---

## Results Summary

After completing all applicable sections, fill in:

| Section | Result | Notes |
|---------|--------|-------|
| A. Fresh Install | Pass / Fail / Skip | |
| B. Plugin Hooks | Pass / Fail / Skip | |
| C. History Flow | Pass / Fail / Skip | |
| D. Multi-Session | Pass / Fail / Skip | |
| E. Migration UX | Pass / Fail / Skip | |
| F. Error Resilience | Pass / Fail / Skip | |

**Tested by:** _______________
**Date:** _______________
**Commit:** _______________
