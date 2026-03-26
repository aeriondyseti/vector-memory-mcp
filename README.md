# Vector Memory MCP Server

> Semantic memory storage for AI assistants. Store decisions, patterns, and context that persists across sessions.

A local-first MCP server that provides vector-based memory storage. Uses local embeddings and SQLite with sqlite-vec for fast, private semantic search — all in a single file.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@aeriondyseti/vector-memory-mcp.svg)](https://www.npmjs.com/package/@aeriondyseti/vector-memory-mcp)

---

## Features

- **Local & Private** - All embeddings generated locally ([all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2), 384-dim), data stored in a single SQLite file
- **Semantic Search** - Hybrid vector + full-text search with intent-based ranking
- **Batch Operations** - Store, update, delete, and retrieve multiple memories at once
- **Session Waypoints** - Save and restore project context between sessions
- **Conversation History** - Index and search Claude Code session transcripts
- **MCP Native** - Standard protocol, works with any MCP-compatible client

---

## Installation

There are two ways to install Vector Memory, depending on how much integration you want.

### Option A: Claude Code Plugin (recommended)

Install as a plugin to get the full experience: MCP server, session lifecycle hooks, waypoint skills, and context monitoring — all managed automatically.

```bash
# Add the marketplace
claude plugin marketplace add AerionDyseti/vector-memory-mcp

# Install the plugin
claude plugin install vector-memory@vector-memory-mcp
```

This clones the repo and runs the MCP server directly from source. Hooks handle session start/clear/compact events, and skills provide `/waypoint:set`, `/waypoint:get`, and memory usage guidance.

### Option B: MCP Server Only

Install just the MCP server via npm if you want memory storage without hooks or skills, or if you're using a non-Claude Code MCP client.

```bash
bun install -g @aeriondyseti/vector-memory-mcp
```

> First install downloads ML models (~90MB). This may take a minute.

Then add to your MCP client config (e.g., `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "vector-memory": {
      "type": "stdio",
      "command": "bunx",
      "args": ["--bun", "@aeriondyseti/vector-memory-mcp"]
    }
  }
}
```

### Prerequisites

- [Bun](https://bun.sh/) 1.0+
- An MCP-compatible client (Claude Code, Claude Desktop, etc.)

---

## Tools

Restart your MCP client after installation. You now have access to:

| Tool | Description |
|------|-------------|
| `store_memories` | Save memories (accepts array) |
| `search_memories` | Find relevant memories semantically |
| `get_memories` | Retrieve memories by ID (accepts array) |
| `update_memories` | Update existing memories |
| `delete_memories` | Remove memories (accepts array) |
| `report_memory_usefulness` | Vote on whether a memory was useful |
| `set_waypoint` | Save session context for later |
| `get_waypoint` | Restore session context |
| `index_conversations` | Index Claude Code session logs as searchable history |
| `list_indexed_sessions` | Browse indexed conversation sessions |
| `reindex_session` | Force reindex of a specific session |

---

## Usage

**Store a memory:**
```
You: "Remember that we use Drizzle ORM for database access"
Assistant: [calls store_memories]
```

**Search memories:**
```
You: "What did we decide about the database?"
Assistant: [calls search_memories with relevant query]
```

**Session waypoints:**
```
You: "Save context for next session"
Assistant: [calls set_waypoint with summary, completed items, next steps]
```

**Conversation history** (requires `--enable-history`):
```
You: "What did we discuss about the API design last week?"
Assistant: [calls search_memories with history_only: true, history_before/after filters]
```

---

## Configuration

CLI flags:

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--db-file <path>` | `-d` | `.vector-memory/memories.db` | Database location (relative to cwd) |
| `--port <number>` | `-p` | `3271` | HTTP server port |
| `--no-http` | | *(HTTP enabled)* | Disable HTTP/SSE transport |
| `--enable-history` | | *(disabled)* | Enable conversation history indexing |
| `--history-path` | | *(auto-detect)* | Path to session log directory |
| `--history-weight` | | `0.75` | Weight for history results in unified search |

---

## Release Channels

**Plugin users:** The plugin tracks the repo's default branch. To switch channels, reinstall from a specific branch or tag.

**npm users:** The stable release is what you get by default:

```bash
bun install -g @aeriondyseti/vector-memory-mcp
```

Pre-release channels are available for testing upcoming changes. **These are unstable and may break without notice — use at your own risk.**

| Channel | npm | Description |
|---------|-----|-------------|
| `@latest` | *(default)* | Stable releases |
| `@rc` | `@aeriondyseti/vector-memory-mcp@rc` | Release candidates — final testing before stable |
| `@dev` | `@aeriondyseti/vector-memory-mcp@dev` | Development builds — latest features, least stable |

```bash
# Install the dev channel
bun install -g @aeriondyseti/vector-memory-mcp@dev

# Pin to a specific pre-release version
bun install -g @aeriondyseti/vector-memory-mcp@2.1.0-dev.1

# Go back to stable
bun install -g @aeriondyseti/vector-memory-mcp@latest
```

> **Warning:** Pre-release versions may include breaking changes, incomplete features, or data migration requirements that haven't been finalized. Do not use them in production workflows you depend on.

---

## Migrating from 1.x (LanceDB)

Version 2.0 replaced LanceDB with SQLite (sqlite-vec) for storage. If you have existing data from 1.x, the server will detect it automatically and prompt you to migrate:

```bash
vector-memory-mcp migrate
```

This reads your LanceDB directory, writes a new SQLite file, and prints instructions to swap them. Your original data is preserved until you manually remove it.

**What changed:**
- Storage: LanceDB directory (~845 files) → single `.db` file
- Dependencies: 223MB (`@lancedb/lancedb` + `apache-arrow`) → 24KB (`sqlite-vec`)
- Runtime: Node.js support dropped, Bun required (for `bun:sqlite`)

---

## Development

```bash
git clone https://github.com/AerionDyseti/vector-memory-mcp.git
cd vector-memory-mcp
bun install

bun run test      # Run all tests
bun run dev       # Watch mode
bun run typecheck # Type checking
```

See [CHANGELOG.md](CHANGELOG.md) for release history and [ROADMAP.md](ROADMAP.md) for planned features.

---

## Contributing

Contributions welcome! See [issues](https://github.com/AerionDyseti/vector-memory-mcp/issues) for areas we'd love help with.

## License

MIT - see [LICENSE](LICENSE)

---

Built with [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), [sqlite-vec](https://github.com/asg017/sqlite-vec), and [Transformers.js](https://huggingface.co/docs/transformers.js)
