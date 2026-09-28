import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHash } from "crypto";
import { createServer } from "net";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { MemoryService } from "../../core/memory.service";
import type { Config } from "../../config/index";
import { isDeleted } from "../../core/memory";
import { createMcpRoutes } from "./mcp-transport";
import type { Memory, SearchIntent } from "../../core/memory";
import { resolveDateFilters } from "../../core/time-expr";

const VALID_INTENTS = new Set(["continuity", "fact_check", "frequent", "associative", "explore"]);


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
 * Per-project lock path under the global data directory. Keyed by a hash of
 * the canonical project path so hooks (which know their cwd) can compute the
 * same path without any per-repo files. Must stay in sync with the copy in
 * plugin/hooks/scripts/hooks-lib.ts.
 */
export function globalLockPath(project: string): string {
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(homedir(), ".vector-memory", "locks", `${hash}.lock`);
}

function legacyLockPath(): string {
  return join(process.cwd(), ".vector-memory", "server.lock");
}

/**
 * Write lockfiles so hooks can discover which port this server bound to.
 * Written after the HTTP server successfully binds.
 *
 * Writes the global per-project lock, plus the legacy per-repo lock when a
 * `.vector-memory/` directory already exists in the repo (so pre-2.5 plugins
 * keep working without us creating new per-repo litter). Legacy dual-write
 * is temporary — remove after one stable release cycle.
 */
function writeLockfiles(port: number, project: string): void {
  const payload = JSON.stringify({ port, pid: process.pid, project });

  const globalPath = globalLockPath(project);
  mkdirSync(join(homedir(), ".vector-memory", "locks"), { recursive: true });
  writeFileSync(globalPath, payload, "utf8");

  if (existsSync(join(process.cwd(), ".vector-memory"))) {
    writeFileSync(legacyLockPath(), payload, "utf8");
  }
}

/**
 * Remove this process's lockfiles on clean shutdown. Only deletes a lock
 * whose recorded pid is ours — another session in the same project may have
 * written its own lock since.
 */
export function removeLockfiles(project: string): void {
  for (const path of [globalLockPath(project), legacyLockPath()]) {
    try {
      const { pid } = JSON.parse(readFileSync(path, "utf8"));
      if (pid === process.pid) unlinkSync(path);
    } catch {
      // missing or unreadable — fine
    }
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
      if (!query || typeof query !== "string") {
        return c.json({ error: "Missing or invalid 'query' field" }, 400);
      }
      if (body.intent && !VALID_INTENTS.has(body.intent)) {
        return c.json({ error: "Invalid 'intent' value" }, 400);
      }
      const intent = (body.intent as SearchIntent) ?? "fact_check";
      const limit = Math.max(1, Math.min(1000, Math.floor(typeof body.limit === "number" ? body.limit : 10)));

      let dateFilters: { after?: Date; before?: Date };
      try {
        dateFilters = resolveDateFilters({ after: body.after, before: body.before, time_expr: body.time_expr });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }

      const results = await memoryService.search(query, intent, {
        limit,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        ...dateFilters,
      });

      return c.json({
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          source: r.source,
          confidence: r.confidence,
          project: r.project,
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
      const { content, embeddingText } = body;

      if (!content || typeof content !== "string") {
        return c.json({ error: "Missing or invalid 'content' field" }, 400);
      }

      const metadata = typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : {};

      const memory = await memoryService.store(
        content,
        metadata,
        typeof embeddingText === "string" ? embeddingText : undefined,
        typeof body.project === "string" ? body.project : undefined
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
      if (typeof body.since === "string") {
        since = new Date(body.since);
        if (isNaN(since.getTime())) {
          return c.json({ error: "Invalid 'since' date format" }, 400);
        }
      }
      const path = typeof body.path === "string" ? body.path : undefined;
      const result = await conversationService.indexConversations(path, since);

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

  writeLockfiles(actualPort, config.project);
  console.error(
    `[vector-memory-mcp] HTTP server listening on http://${config.httpHost}:${actualPort}`
  );

  return {
    stop: () => { removeLockfiles(config.project); server.stop(); },
    port: actualPort,
  };
}
