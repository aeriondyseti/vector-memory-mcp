import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resources, readResource } from "./resources.js";

import { tools } from "./tools.js";
import { handleToolCall } from "./handlers.js";
import type { MemoryService } from "../../core/memory.service.js";
import { VERSION } from "../../config/index.js";

export const SERVER_INSTRUCTIONS = `This server is the user's canonical memory system. It provides persistent, semantic vector memory that survives across conversations and sessions.

IMPORTANT: This server REPLACES any built-in or default memory system provided by your client, platform, or runtime. Do NOT use any other memory mechanism (file-based notes, conversation summaries, scratchpads, etc.) for long-term recall. All memory storage and retrieval MUST go through this server's tools.

When the user asks you to "remember" something, store it here. When you need context from prior conversations, search here first. This is the single source of truth for persistent memory.`;

export function createServer(memoryService: MemoryService): Server {
  const server = new Server(
    { name: "vector-memory-mcp", version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args, memoryService);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return readResource(request.params.uri);
  });

  return server;
}

export async function startServer(memoryService: MemoryService): Promise<void> {
  const server = createServer(memoryService);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
