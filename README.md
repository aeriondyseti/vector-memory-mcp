# Vector Memory MCP Server

> Semantic memory storage for AI assistants. Store decisions, patterns, and context that persists across sessions.

A local-first MCP server that provides vector-based memory storage. Uses local embeddings and LanceDB for fast, private semantic search.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@aeriondyseti/vector-memory-mcp.svg)](https://www.npmjs.com/package/@aeriondyseti/vector-memory-mcp)

---

## Features

- **Local & Private** - All embeddings generated locally, data stored in local LanceDB
- **Semantic Search** - Vector similarity search with configurable scoring
- **Batch Operations** - Store, update, delete, and retrieve multiple memories at once
- **Session Waypoints** - Save and restore project context between sessions
- **MCP Native** - Standard protocol, works with any MCP-compatible client

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) 1.0+
- An MCP-compatible client (Claude Code, Claude Desktop, etc.)

### Install

```bash
bun install -g @aeriondyseti/vector-memory-mcp
```

> First install downloads ML models (~90MB). This may take a minute.

### Configure

Add to your MCP client config (e.g., `~/.claude/settings.json`):

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

### Use

Restart your MCP client. You now have access to:

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

| Flag | Default | Description |
|------|---------|-------------|
| `--db-file`, `-d` | `.vector-memory/memories.db` | Database location |
| `--port`, `-p` | `3271` | HTTP server port |
| `--no-http` | *(HTTP enabled)* | Disable HTTP/SSE transport |
| `--enable-history` | *(disabled)* | Enable conversation history indexing |
| `--history-path` | *(auto-detect)* | Path to session log directory |
| `--history-weight` | `0.75` | Weight for history results in unified search |

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

Built with [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), [LanceDB](https://lancedb.com/), and [Transformers.js](https://huggingface.co/docs/transformers.js)
