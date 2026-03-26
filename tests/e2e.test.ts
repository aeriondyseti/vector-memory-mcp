/**
 * E2E tests that spawn actual server processes and test full workflows.
 * Tests both stdio and HTTP transports.
 *
 * NOTE: These tests are skipped in CI because they spawn Node.js processes
 * and require reliable process management that's flaky in CI environments.
 * Run locally with: bun test tests/e2e.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Skip E2E tests in CI - they require spawning Node processes which is flaky
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const describeE2E = isCI ? describe.skip : describe;

// Use source directly with bun — bun:sqlite requires the Bun runtime
const SERVER_PATH = join(import.meta.dir, "../server/index.ts");

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

/**
 * Extract memory ID from store response text like "Memory stored with ID: xxx"
 */
function extractMemoryId(text: string): string {
  const match = text.match(/ID: ([a-f0-9-]+)/i);
  if (!match) throw new Error(`Could not extract ID from: ${text}`);
  return match[1];
}

/**
 * Check if text contains a memory ID
 */
function containsMemoryId(text: string, id: string): boolean {
  return text.includes(id);
}

/**
 * Helper to send a JSON-RPC request over stdio and read response
 */
async function sendStdioRequest(
  proc: Subprocess,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  // Write request to stdin
  proc.stdin.write(JSON.stringify(request) + "\n");
  proc.stdin.flush();

  // Read response line from stdout
  const reader = proc.stdout.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    if (buffer.includes("\n")) break;
  }
  reader.releaseLock();

  const line = buffer.split("\n")[0];
  return JSON.parse(line);
}

/**
 * Helper to call an MCP tool over stdio
 */
async function callToolStdio(
  proc: Subprocess,
  id: number,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const response = await sendStdioRequest(proc, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  if (response.error) {
    throw new Error(`Tool error: ${response.error.message}`);
  }

  return response.result?.content[0]?.text ?? "";
}

/**
 * Helper to call an MCP tool over HTTP
 */
async function callToolHttp(
  baseUrl: string,
  sessionId: string,
  id: number,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const response: JsonRpcResponse = await res.json();

  if (response.error) {
    throw new Error(`Tool error: ${response.error.message}`);
  }

  return response.result?.content[0]?.text ?? "";
}

describeE2E("E2E: Stdio Transport", () => {
  let proc: Subprocess;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-e2e-stdio-"));
    const dbPath = join(tmpDir, "test.db");

    proc = spawn(["bun", "run", SERVER_PATH, "--db-file", dbPath, "--no-http"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Initialize MCP session
    const initResponse = await sendStdioRequest(proc, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-test", version: "1.0" },
      },
    });

    expect(initResponse.result).toBeDefined();
  });

  afterAll(() => {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("full memory lifecycle: store → search → update → get → delete", async () => {
    // 1. Store a memory
    const storeText = await callToolStdio(proc, 1, "store_memories", {
      memories: [{ content: "E2E test memory for stdio transport", metadata: { test: true } }],
    });
    expect(storeText).toContain("Memory stored with ID:");
    const memoryId = extractMemoryId(storeText);

    // 2. Search for the memory
    const searchText = await callToolStdio(proc, 2, "search_memories", {
      query: "E2E test stdio transport",
      limit: 5,
    });
    expect(containsMemoryId(searchText, memoryId)).toBe(true);

    // 3. Update the memory
    const updateText = await callToolStdio(proc, 3, "update_memories", {
      updates: [{ id: memoryId, metadata: { test: true, updated: true } }],
    });
    expect(updateText).toContain("updated successfully");

    // 4. Get the updated memory
    const getText = await callToolStdio(proc, 4, "get_memories", {
      ids: [memoryId],
    });
    expect(containsMemoryId(getText, memoryId)).toBe(true);
    expect(getText).toContain("updated");

    // 5. Delete the memory
    const deleteText = await callToolStdio(proc, 5, "delete_memories", {
      ids: [memoryId],
    });
    expect(deleteText).toContain("deleted successfully");

    // 6. Search should NOT find deleted memory
    const searchAfterDelete = await callToolStdio(proc, 6, "search_memories", {
      query: "E2E test stdio transport",
      limit: 5,
    });
    expect(containsMemoryId(searchAfterDelete, memoryId)).toBe(false);

    // 7. Search with include_deleted SHOULD find it
    const searchWithDeleted = await callToolStdio(proc, 7, "search_memories", {
      query: "E2E test stdio transport",
      limit: 5,
      include_deleted: true,
    });
    expect(containsMemoryId(searchWithDeleted, memoryId)).toBe(true);
    expect(searchWithDeleted).toContain("[DELETED]");
  });
});

describeE2E("E2E: HTTP Transport", () => {
  let proc: Subprocess;
  let tmpDir: string;
  let dbPath: string;
  let sessionId: string;
  const port = 3272; // Use different port to avoid conflicts
  const baseUrl = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-e2e-http-"));
    dbPath = join(tmpDir, "test.db");

    proc = spawn(["bun", "run", SERVER_PATH, "--db-file", dbPath, "--plugin", "--port", String(port)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Initialize MCP session over HTTP
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "1.0" },
        },
      }),
    });

    sessionId = initRes.headers.get("mcp-session-id")!;
    expect(sessionId).toBeDefined();
  });

  afterAll(() => {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("health endpoint returns ok with correct config", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.config).toBeDefined();
    expect(body.config.dbPath).toBe(dbPath);
    expect(body.config.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
    expect(body.config.embeddingDimension).toBe(384);
  });

  test("full memory lifecycle: store → search → update → get → delete", async () => {
    // 1. Store a memory
    const storeText = await callToolHttp(baseUrl, sessionId, 1, "store_memories", {
      memories: [{ content: "E2E test memory for HTTP transport", metadata: { test: true } }],
    });
    expect(storeText).toContain("Memory stored with ID:");
    const memoryId = extractMemoryId(storeText);

    // 2. Search for the memory
    const searchText = await callToolHttp(baseUrl, sessionId, 2, "search_memories", {
      query: "E2E test HTTP transport",
      limit: 5,
    });
    expect(containsMemoryId(searchText, memoryId)).toBe(true);

    // 3. Update the memory
    const updateText = await callToolHttp(baseUrl, sessionId, 3, "update_memories", {
      updates: [{ id: memoryId, metadata: { test: true, updated: true } }],
    });
    expect(updateText).toContain("updated successfully");

    // 4. Get the updated memory
    const getText = await callToolHttp(baseUrl, sessionId, 4, "get_memories", {
      ids: [memoryId],
    });
    expect(containsMemoryId(getText, memoryId)).toBe(true);
    expect(getText).toContain("updated");

    // 5. Delete the memory
    const deleteText = await callToolHttp(baseUrl, sessionId, 5, "delete_memories", {
      ids: [memoryId],
    });
    expect(deleteText).toContain("deleted successfully");

    // 6. Search should NOT find deleted memory
    const searchAfterDelete = await callToolHttp(baseUrl, sessionId, 6, "search_memories", {
      query: "E2E test HTTP transport",
      limit: 5,
    });
    expect(containsMemoryId(searchAfterDelete, memoryId)).toBe(false);

    // 7. Search with include_deleted SHOULD find it
    const searchWithDeleted = await callToolHttp(baseUrl, sessionId, 7, "search_memories", {
      query: "E2E test HTTP transport",
      limit: 5,
      include_deleted: true,
    });
    expect(containsMemoryId(searchWithDeleted, memoryId)).toBe(true);
    expect(searchWithDeleted).toContain("[DELETED]");
  });
});
