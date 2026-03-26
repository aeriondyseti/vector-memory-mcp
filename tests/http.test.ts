import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { EmbeddingsService } from "../server/core/embeddings.service";
import { MemoryService } from "../server/core/memory.service";
import { createHttpApp, startHttpServer } from "../server/transports/http/server";
import type { Config } from "../server/config/index";

function createTestConfig(dbPath: string): Config {
  return {
    dbPath,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDimension: 384,
    httpPort: 3271,
    httpHost: "127.0.0.1",
    enableHttp: true,
    transportMode: "stdio",
    conversationHistory: {
      enabled: false,
      sessionLogPath: null,
      historyWeight: 0.75,
      chunkOverlap: 1,
      maxChunkMessages: 10,
      indexSubagents: false,
    },
  };
}

describe("HTTP API", () => {
  let memoryService: MemoryService;
  let app: ReturnType<typeof createHttpApp>;
  let tmpDir: string;
  let testConfig: Config;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-http-test-"));
    const dbPath = join(tmpDir, "test.db");
    testConfig = createTestConfig(dbPath);
    const db = connectToDatabase(dbPath);
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    memoryService = new MemoryService(repository, embeddings);
    app = createHttpApp(memoryService, testConfig);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("GET /health", () => {
    test("returns ok status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("POST /store", () => {
    test("stores a memory and returns id", async () => {
      const res = await app.request("/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Test memory for HTTP API",
          metadata: { type: "test", project: "http-tests" },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.createdAt).toBeDefined();
    });

    test("stores with embeddingText", async () => {
      const res = await app.request("/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Very long content that would be truncated for embedding purposes...",
          embeddingText: "long content summary",
          metadata: { type: "test" },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeDefined();
    });

    test("returns 400 for missing content", async () => {
      const res = await app.request("/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("content");
    });
  });

  describe("POST /search", () => {
    test("finds stored memories", async () => {
      // Store a memory first
      await app.request("/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Authentication uses JWT tokens with refresh capability",
          metadata: { type: "decision", project: "search-test" },
        }),
      });

      // Search for it
      const res = await app.request("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "JWT authentication", limit: 5 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toBeInstanceOf(Array);
      expect(body.count).toBeGreaterThan(0);

      const found = body.results.some((r: { content: string }) =>
        r.content.includes("JWT")
      );
      expect(found).toBe(true);
    });

    test("returns 400 for missing query", async () => {
      const res = await app.request("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      });

      expect(res.status).toBe(400);
    });
  });


  describe("GET /memories/:id", () => {
    test("retrieves a specific memory", async () => {
      // Store a memory
      const storeRes = await app.request("/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Specific memory to retrieve by ID",
          metadata: { type: "test" },
        }),
      });
      const { id } = await storeRes.json();

      // Retrieve it
      const res = await app.request(`/memories/${id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe(id);
      expect(body.content).toBe("Specific memory to retrieve by ID");
      expect(body.metadata.type).toBe("test");
    });

    test("returns 404 for non-existent memory", async () => {
      const res = await app.request("/memories/non-existent-id-12345");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /waypoint", () => {
    test("returns 404 when no waypoint exists", async () => {
      const res = await app.request("/waypoint");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("No waypoint");
    });

    test("returns waypoint after storing one", async () => {
      await memoryService.setWaypoint({
        project: "test-project",
        branch: "main",
        summary: "Test waypoint",
        completed: ["Task A"],
        next_steps: ["Task B"],
      });

      const res = await app.request("/waypoint?project=test-project");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toContain("test-project");
      expect(body.metadata.project).toBe("test-project");
      expect(body.updatedAt).toBeDefined();
    });

    test("includes referenced memories", async () => {
      const mem = await memoryService.store("Referenced memory content");
      await memoryService.setWaypoint({
        project: "ref-test",
        summary: "Waypoint with refs",
        memory_ids: [mem.id],
      });

      const res = await app.request("/waypoint?project=ref-test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.referencedMemories).toBeArray();
      expect(body.referencedMemories.length).toBeGreaterThanOrEqual(1);
      expect(body.referencedMemories[0].content).toBe("Referenced memory content");
    });
  });

  describe("DELETE /memories/:id", () => {
    test("deletes a memory", async () => {
      // Store a memory
      const storeRes = await app.request("/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Memory to delete",
          metadata: { type: "test" },
        }),
      });
      const { id } = await storeRes.json();

      // Delete it
      const deleteRes = await app.request(`/memories/${id}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);
      const deleteBody = await deleteRes.json();
      expect(deleteBody.deleted).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/memories/${id}`);
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for non-existent memory", async () => {
      const res = await app.request("/memories/non-existent-id-67890", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});

describe("MCP Transport", () => {
  let memoryService: MemoryService;
  let app: ReturnType<typeof createHttpApp>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-transport-test-"));
    const dbPath = join(tmpDir, "test.db");
    const testConfig = createTestConfig(dbPath);
    const db = connectToDatabase(dbPath);
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    memoryService = new MemoryService(repository, embeddings);
    app = createHttpApp(memoryService, testConfig);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("POST /mcp", () => {
    test("initializes session with initialize request", async () => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      expect(res.status).toBe(200);
      const sessionId = res.headers.get("mcp-session-id");
      expect(sessionId).toBeDefined();

      const body = await res.json();
      expect(body.result).toBeDefined();
      expect(body.result.serverInfo.name).toBe("vector-memory-mcp");
    });

    test("returns error for non-initialize request without session", async () => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32000);
    });

    test("returns error for invalid session ID", async () => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": "invalid-session-id",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    test("reuses existing session with valid session ID", async () => {
      // First, initialize a session
      const initRes = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      const sessionId = initRes.headers.get("mcp-session-id")!;

      // Now make another request with the session ID
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
      expect(body.result.tools).toBeInstanceOf(Array);
    });
  });

  describe("GET /mcp", () => {
    test("returns error without session ID", async () => {
      const res = await app.request("/mcp", { method: "GET" });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("session");
    });

    test("returns error with invalid session ID", async () => {
      const res = await app.request("/mcp", {
        method: "GET",
        headers: { "mcp-session-id": "invalid-session" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /mcp", () => {
    test("returns error without session ID", async () => {
      const res = await app.request("/mcp", { method: "DELETE" });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    test("returns error with invalid session ID", async () => {
      const res = await app.request("/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": "invalid-session" },
      });

      expect(res.status).toBe(400);
    });

    test("successfully closes valid session", async () => {
      // First, initialize a session
      const initRes = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      const sessionId = initRes.headers.get("mcp-session-id")!;

      // Delete the session
      const deleteRes = await app.request("/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
      });

      expect(deleteRes.status).toBe(200);
      const body = await deleteRes.json();
      expect(body.success).toBe(true);

      // Verify session is gone - subsequent request should fail
      const verifyRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      expect(verifyRes.status).toBe(400);
    });
  });
});

describe("HTTP API Integration", () => {
  let memoryService: MemoryService;
  let app: ReturnType<typeof createHttpApp>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-http-integration-"));
    const dbPath = join(tmpDir, "test.db");
    const testConfig = createTestConfig(dbPath);
    const db = connectToDatabase(dbPath);
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    memoryService = new MemoryService(repository, embeddings);
    app = createHttpApp(memoryService, testConfig);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("end-to-end: store, search, delete workflow", async () => {
    // 1. Store multiple memories
    const memories = [
      { content: "API uses REST with JSON payloads", metadata: { type: "decision" } },
      { content: "Authentication handled via OAuth 2.0", metadata: { type: "decision" } },
      { content: "Database is PostgreSQL with Prisma ORM", metadata: { type: "pattern" } },
    ];

    const ids: string[] = [];
    for (const mem of memories) {
      const res = await app.request("/store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mem),
      });
      const { id } = await res.json();
      ids.push(id);
    }

    expect(ids).toHaveLength(3);

    // 2. Search for authentication-related memories
    const searchRes = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "authentication OAuth", limit: 10 }),
    });
    const searchBody = await searchRes.json();
    expect(searchBody.results.length).toBeGreaterThan(0);

    // 3. Delete one memory
    const deleteRes = await app.request(`/memories/${ids[0]}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    // 5. Verify deletion
    const getRes = await app.request(`/memories/${ids[0]}`);
    expect(getRes.status).toBe(404);

    // 6. Remaining memories still searchable
    const finalSearch = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "database PostgreSQL", limit: 10 }),
    });
    const finalBody = await finalSearch.json();
    expect(finalBody.results.length).toBeGreaterThan(0);
  });
});

describe("startHttpServer", () => {
  let tmpDir: string;
  let memoryService: MemoryService;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-start-test-"));
    const dbPath = join(tmpDir, "test.db");
    const db = connectToDatabase(dbPath);
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    memoryService = new MemoryService(repository, embeddings);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("starts server on configured port and stops cleanly", async () => {
    const config = createTestConfig(join(tmpDir, "test.db"));
    config.httpPort = 49152 + Math.floor(Math.random() * 1000);

    const { stop, port } = await startHttpServer(memoryService, config);
    expect(port).toBe(config.httpPort);

    // Verify server is responding
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    stop();
  });

  test("finds alternative port when preferred is in use", async () => {
    const config = createTestConfig(join(tmpDir, "test.db"));
    config.httpPort = 49152 + Math.floor(Math.random() * 1000);

    // Start first server on that port
    const server1 = await startHttpServer(memoryService, config);
    expect(server1.port).toBe(config.httpPort);

    // Start second server on same port — should find alternative
    const server2 = await startHttpServer(memoryService, config);
    expect(server2.port).toBeGreaterThan(0);
    expect(server2.port).not.toBe(server1.port);

    server1.stop();
    server2.stop();
  });
});

describe("HTTP error handling", () => {
  let app: ReturnType<typeof createHttpApp>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-error-test-"));
    const dbPath = join(tmpDir, "test.db");
    const testConfig = createTestConfig(dbPath);
    const db = connectToDatabase(dbPath);
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);

    // Create a proxy service that can throw on demand
    const realService = new MemoryService(repository, embeddings);
    const throwingService = new Proxy(realService, {
      get(target, prop) {
        if (prop === "search" || prop === "store" || prop === "delete" ||
            prop === "get" || prop === "getLatestWaypoint") {
          return () => { throw new Error("Simulated failure"); };
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }) as MemoryService;

    app = createHttpApp(throwingService, testConfig);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("POST /search returns 500 on service error", async () => {
    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Simulated failure");
  });

  test("POST /store returns 500 on service error", async () => {
    const res = await app.request("/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Simulated failure");
  });

  test("DELETE /memories/:id returns 500 on service error", async () => {
    const res = await app.request("/memories/some-id", { method: "DELETE" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Simulated failure");
  });

  test("GET /memories/:id returns 500 on service error", async () => {
    const res = await app.request("/memories/some-id");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Simulated failure");
  });

  test("GET /waypoint returns 500 on service error", async () => {
    const res = await app.request("/waypoint");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Simulated failure");
  });
});
