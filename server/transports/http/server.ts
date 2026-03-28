import { Hono } from "hono";
import { cors } from "hono/cors";
import { createServer } from "net";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { MemoryService } from "../../core/memory.service";
import type { Config } from "../../config/index";
import { isDeleted } from "../../core/memory";
import { createMcpRoutes } from "./mcp-transport";
import type { Memory, SearchIntent } from "../../core/memory";
import { resolveDateFilters } from "../../core/time-expr";


/**
 * Check if a port is available by attempting to bind to it
 */
async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Find an available port, starting with the preferred port.
 * If preferred port is unavailable, picks a random available port.
 */
async function findAvailablePort(
  preferredPort: number,
  host: string
): Promise<number> {
  if (await isPortAvailable(preferredPort, host)) {
    return preferredPort;
  }

  console.error(
    `[vector-memory-mcp] Port ${preferredPort} is in use, finding an available port...`
  );

  // Let the OS pick a random available port
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.listen(0, host);
  });
}

/**
 * Write a lockfile so hooks can discover which port this server bound to.
 * Written atomically after the HTTP server successfully binds.
 */
function writeLockfile(port: number): void {
  const dir = join(process.cwd(), ".vector-memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "server.lock"),
    JSON.stringify({ port, pid: process.pid }),
    "utf8"
  );
}

/**
 * Remove the lockfile on clean shutdown so stale files don't linger.
 */
export function removeLockfile(): void {
  try {
    unlinkSync(join(process.cwd(), ".vector-memory", "server.lock"));
  } catch {
    // already gone — fine
  }
}

export interface HttpServerOptions {
  memoryService: MemoryService;
  config: Config;
}

// Track server start time for uptime calculation
const startedAt = Date.now();

export function createHttpApp(memoryService: MemoryService, config: Config): Hono {
  const app = new Hono();

  // Enable CORS for local development
  app.use("/*", cors());

  // Mount MCP routes for StreamableHTTP transport
  const mcpApp = createMcpRoutes(memoryService);
  app.route("/", mcpApp);

  // Health check endpoint with config info
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      config: {
        dbPath: config.dbPath,
        embeddingModel: config.embeddingModel,
        embeddingDimension: config.embeddingDimension,
        historyEnabled: config.conversationHistory.enabled,
        pluginMode: config.pluginMode,
        embeddingReady: memoryService.getEmbeddings().isReady,
      },
    });
  });

  // Warmup endpoint — triggers ONNX model load if not already cached
  app.post("/warmup", async (c) => {
    const embeddings = memoryService.getEmbeddings();
    if (embeddings.isReady) {
      return c.json({ status: "already_warm" });
    }
    const start = Date.now();
    await embeddings.warmup();
    return c.json({ status: "warmed", elapsed: Date.now() - start });
  });

  // Search endpoint
  app.post("/search", async (c) => {
    try {
      const body = await c.req.json();
      const query = body.query;
      const intent = (body.intent as SearchIntent) ?? "fact_check";
      const limit = body.limit ?? 10;

      if (!query || typeof query !== "string") {
        return c.json({ error: "Missing or invalid 'query' field" }, 400);
      }

      let dateFilters: { after?: Date; before?: Date };
      try {
        dateFilters = resolveDateFilters({ after: body.after, before: body.before, time_expr: body.time_expr });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }

      const results = await memoryService.search(query, intent, { limit, ...dateFilters });

      return c.json({
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          source: r.source,
          confidence: r.confidence,
          createdAt: r.createdAt.toISOString(),
        })),
        count: results.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  });

  // Store endpoint
  app.post("/store", async (c) => {
    try {
      const body = await c.req.json();
      const { content, metadata, embeddingText } = body;

      if (!content || typeof content !== "string") {
        return c.json({ error: "Missing or invalid 'content' field" }, 400);
      }

      const memory = await memoryService.store(
        content,
        metadata ?? {},
        embeddingText
      );

      return c.json({
        id: memory.id,
        createdAt: memory.createdAt.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  });

  // Delete endpoint
  app.delete("/memories/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const deleted = await memoryService.delete(id);

      if (!deleted) {
        return c.json({ error: "Memory not found" }, 404);
      }

      return c.json({ deleted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  });

  // Get latest waypoint
  app.get("/waypoint", async (c) => {
    try {
      const project = c.req.query("project");
      const waypoint = await memoryService.getLatestWaypoint(project);

      if (!waypoint) {
        return c.json({ error: "No waypoint found" }, 404);
      }

      // Fetch referenced memories in a single query
      const memoryIds = (waypoint.metadata.memory_ids as string[] | undefined) ?? [];
      const memories = await memoryService.getMultiple(memoryIds);
      const referencedMemories = memories
        .filter((m) => !isDeleted(m))
        .map((m) => ({ id: m.id, content: m.content }));

      return c.json({
        content: waypoint.content,
        metadata: waypoint.metadata,
        referencedMemories,
        updatedAt: waypoint.updatedAt.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  });

  // Index conversations (trigger incremental indexing)
  app.post("/index-conversations", async (c) => {
    try {
      const conversationService = memoryService.getConversationService();
      if (!conversationService) {
        return c.json({ error: "Conversation history indexing is not enabled" }, 400);
      }

      const body = await c.req.json().catch(() => ({}));
      let since: Date | undefined;
      if (body.since) {
        since = new Date(body.since as string);
        if (isNaN(since.getTime())) {
          return c.json({ error: "Invalid 'since' date format" }, 400);
        }
      }
      const result = await conversationService.indexConversations(
        body.path as string | undefined,
        since
      );

      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  });

  // Get single memory
  app.get("/memories/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const memory = await memoryService.get(id);

      if (!memory || isDeleted(memory)) {
        return c.json({ error: "Memory not found" }, 404);
      }

      return c.json({
        id: memory.id,
        content: memory.content,
        metadata: memory.metadata,
        createdAt: memory.createdAt.toISOString(),
        updatedAt: memory.updatedAt.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

export async function startHttpServer(
  memoryService: MemoryService,
  config: Config
): Promise<{ stop: () => void; port: number }> {
  const app = createHttpApp(memoryService, config);

  // Find an available port (uses configured port if available, otherwise picks a random one)
  const actualPort = await findAvailablePort(config.httpPort, config.httpHost);

  const server = Bun.serve({
    port: actualPort,
    hostname: config.httpHost,
    fetch: app.fetch,
  });

  writeLockfile(actualPort);
  console.error(
    `[vector-memory-mcp] HTTP server listening on http://${config.httpHost}:${actualPort}`
  );

  return {
    stop: () => { removeLockfile(); server.stop(); },
    port: actualPort,
  };
}
