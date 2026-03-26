# Installation Guide for Testing

## Quick Local Setup

To test the MCP memory server in an MCP-compatible client:

### 1. Install dependencies
```bash
cd <path-to-vector-memory-mcp>
bun install
```

### 2. Configure your MCP client

Edit `~/.claude/config.json` and add:

```json
{
  "mcpServers": {
    "memory": {
      "command": "bun",
      "args": ["run", "<path-to-vector-memory-mcp>/server/index.ts"]
    }
  }
}
```

> **Note:** This server requires running with Bun.

### 3. Restart your client

Restart your MCP client/session to load the new MCP server.

### 4. Test the Memory Tools

Try these commands in your client:

```
You: "Remember that we use TypeScript for this project"
[Your client/agent should call the store_memory tool]

You: "What language are we using?"
[Your client/agent should call search_memories and find the answer]
```

## Available Tools

Once installed, your client will have access to these tools:

- `store_memory` - Store a new memory with optional metadata
- `search_memories` - Search for memories using semantic similarity
- `get_memory` - Retrieve a specific memory by ID
- `delete_memory` - Delete a memory by ID

## Database Location

Memories are stored in (by default):
```
./.claude/vector-memories.db
```

You can inspect the database using LanceDB tools if needed.

## Troubleshooting

### Test the server manually
```bash
cd <path-to-vector-memory-mcp>
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | bun run server/index.ts
```

You should see a JSON response with server info.

### Check client logs

If the server isn't loading, check your client logs for error messages.

### Verify Bun is installed
```bash
bun --version
```

Should show Bun 1.0 or higher.

## Development Mode

For development with auto-reload:
```bash
bun run dev
```

This will watch for file changes and restart the server automatically.
