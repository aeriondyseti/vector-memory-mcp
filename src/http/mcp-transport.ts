/**
 * MCP HTTP Transport Handler
 *
 * Provides StreamableHTTP transport for MCP over HTTP.
 * and other HTTP-based MCP clients to connect to the memory server.
 *
 * This implementation handles the MCP protocol directly using Hono's streaming
 * capabilities, since StreamableHTTPServerTransport expects Node.js req/res objects.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { tools } from "../mcp/tools.js";
import { handleToolCall } from "../mcp/handlers.js";
import { SERVER_INSTRUCTIONS } from "../mcp/server.js";
import { VERSION } from "../config/index.js";
import type { MemoryService } from "../services/memory.service.js";

interface Session {
  server: Server;
  serverTransport: InstanceType<typeof InMemoryTransport>;
  clientTransport: InstanceType<typeof InMemoryTransport>;
  pendingResponses: Map<string | number, (response: JSONRPCMessage) => void>;
  sseClients: Set<(message: JSONRPCMessage) => void>;
}

/**
 * Creates MCP routes for a Hono app.
 *
 * Uses InMemoryTransport internally and bridges to HTTP/SSE manually,
 * since StreamableHTTPServerTransport requires Node.js req/res objects.
 */
export function createMcpRoutes(memoryService: MemoryService): Hono {
  const app = new Hono();

  // Store active sessions by session ID
  const sessions: Map<string, Session> = new Map();

  /**
   * Creates a new MCP server instance configured with memory tools.
   */
  async function createSession(): Promise<Session> {
    const server = new Server(
      { name: "vector-memory-mcp", version: VERSION },
      {
        capabilities: { tools: {} },
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

    // Create linked in-memory transports
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Connect server to its transport
    await server.connect(serverTransport);

    const session: Session = {
      server,
      serverTransport,
      clientTransport,
      pendingResponses: new Map(),
      sseClients: new Set(),
    };

    // Handle messages from server (responses and notifications)
    clientTransport.onmessage = (message: JSONRPCMessage) => {
      // Check if this is a response to a pending request
      if ("id" in message && message.id !== undefined) {
        const resolver = session.pendingResponses.get(message.id);
        if (resolver) {
          resolver(message);
          session.pendingResponses.delete(message.id);
          return;
        }
      }

      // Otherwise, broadcast to SSE clients (notifications)
      for (const sendToClient of session.sseClients) {
        sendToClient(message);
      }
    };

    return session;
  }

  /**
   * Handle POST requests - session initialization and message handling
   */
  app.post("/mcp", async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    const body = await c.req.json();

    let session: Session | undefined;
    let newSessionId: string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Reuse existing session
      session = sessions.get(sessionId)!;
    } else if (isInitializeRequest(body)) {
      // New session initialization
      newSessionId = randomUUID();
      session = await createSession();
      sessions.set(newSessionId, session);
      console.error(`[vector-memory-mcp] MCP session initialized: ${newSessionId}`);
    } else {
      // Invalid request - no session ID and not an initialize request
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Invalid session. Send initialize request without session ID to start.",
          },
          id: body.id ?? null,
        },
        400
      );
    }

    // Send message to server and wait for response
    const response = await sendAndWaitForResponse(session, body);

    // Include session ID header for new sessions
    if (newSessionId) {
      c.header("mcp-session-id", newSessionId);
    }

    return c.json(response);
  });

  /**
   * Handle GET requests - SSE stream for server-to-client notifications
   */
  app.get("/mcp", async (c) => {
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId || !sessions.has(sessionId)) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid or missing session ID" },
          id: null,
        },
        400
      );
    }

    const session = sessions.get(sessionId)!;

    return streamSSE(c, async (stream) => {
      // Register this SSE client
      const sendMessage = (message: JSONRPCMessage) => {
        stream.writeSSE({
          data: JSON.stringify(message),
          event: "message",
        });
      };

      session.sseClients.add(sendMessage);

      // Keep connection open
      try {
        // Send a ping every 30 seconds to keep connection alive
        while (true) {
          await stream.sleep(30000);
          await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        session.sseClients.delete(sendMessage);
      }
    });
  });

  /**
   * Handle DELETE requests - session termination
   */
  app.delete("/mcp", async (c) => {
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId || !sessions.has(sessionId)) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid or missing session ID" },
          id: null,
        },
        400
      );
    }

    const session = sessions.get(sessionId)!;

    // Close transports
    await session.clientTransport.close();
    await session.serverTransport.close();
    await session.server.close();

    sessions.delete(sessionId);
    console.error(`[vector-memory-mcp] MCP session closed: ${sessionId}`);

    return c.json({ success: true });
  });

  return app;
}

/**
 * Send a message to the server and wait for its response.
 */
async function sendAndWaitForResponse(
  session: Session,
  message: JSONRPCRequest | JSONRPCNotification
): Promise<JSONRPCMessage> {
  return new Promise((resolve) => {
    // Register response handler for requests (messages with id)
    if ("id" in message && message.id !== undefined) {
      session.pendingResponses.set(message.id, resolve);
    }

    // Send message to server
    session.clientTransport.send(message);

    // For notifications (no id), resolve immediately with empty response
    if (!("id" in message) || message.id === undefined) {
      resolve({ jsonrpc: "2.0" } as JSONRPCMessage);
    }
  });
}

/**
 * Check if a message is an initialize request.
 */
function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    (body as { method: string }).method === "initialize"
  );
}
