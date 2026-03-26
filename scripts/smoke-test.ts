#!/usr/bin/env bun

/**
 * Smoke test script for vector-memory-mcp 2.0
 *
 * Spawns a real server process and exercises the full HTTP API surface:
 * - Server startup & lockfile discovery
 * - Memory lifecycle (store/search/get/delete)
 * - Waypoint lifecycle (set/get via MCP + HTTP)
 * - Conversation history indexing
 * - Memory usefulness voting
 * - Lockfile cleanup on shutdown
 * - Migration detection & subcommand
 *
 * Usage: bun run scripts/smoke-test.ts
 * Exit code: 0 on success, 1 on any failure
 */

import { spawn, type Subprocess } from "bun";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ─────────────────────────────────────────────────────────

const SERVER_PATH = join(import.meta.dir, "../server/index.ts");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, description: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${description}`);
  } else {
    failed++;
    failures.push(description);
    console.log(`  ❌ ${description}`);
  }
}

function assertContains(text: string, substring: string, description: string): void {
  assert(text.includes(substring), description);
}

function assertNotContains(text: string, substring: string, description: string): void {
  assert(!text.includes(substring), description);
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

async function httpGet(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function httpPost(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function httpDelete(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "DELETE" });
}

/**
 * Initialize an MCP session over HTTP and return the session ID.
 */
async function initMcpSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0" },
      },
    }),
  });

  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("No mcp-session-id header in initialize response");
  }
  return sessionId;
}

let mcpRequestId = 100;

/**
 * Call an MCP tool via HTTP JSON-RPC and return the text result.
 */
async function mcpCall(
  baseUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const id = mcpRequestId++;
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

  const response = (await res.json()) as JsonRpcResponse;

  if (response.error) {
    return `ERROR: ${response.error.message}`;
  }

  return response.result?.content[0]?.text ?? "";
}

function extractMemoryId(text: string): string {
  const match = text.match(/ID: ([a-f0-9-]+)/i);
  if (!match) throw new Error(`Could not extract ID from: ${text}`);
  return match[1];
}

/**
 * Wait for a lockfile to appear, returning its parsed contents.
 */
async function waitForLockfile(
  lockfilePath: string,
  timeoutMs: number = 30000
): Promise<{ port: number; pid: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(lockfilePath)) {
      try {
        const content = readFileSync(lockfilePath, "utf-8");
        return JSON.parse(content);
      } catch {
        // File may be partially written, retry
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Lockfile not found at ${lockfilePath} after ${timeoutMs}ms`);
}

/**
 * Wait for server health endpoint to respond.
 */
async function waitForHealth(baseUrl: string, timeoutMs: number = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server health check failed after ${timeoutMs}ms`);
}

/**
 * Collect stderr output from a subprocess.
 */
async function collectStderr(
  proc: Subprocess,
  timeoutMs: number = 10000
): Promise<string> {
  const reader = (proc.stderr as ReadableStream).getReader();
  const decoder = new TextDecoder();
  let output = "";
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), timeoutMs - (Date.now() - start))
      ),
    ]);

    if (result.done) break;
    if (result.value) output += decoder.decode(result.value);
  }

  reader.releaseLock();
  return output;
}

// ── Main Test Sections ──────────────────────────────────────────────

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-smoke-"));
  const dbPath = join(tmpDir, "smoke-test.db");
  const sessionsPath = join(tmpDir, "sessions");
  const lockfilePath = join(tmpDir, ".vector-memory", "server.lock");

  console.log(`\n🔬 vector-memory-mcp 2.0 Smoke Test`);
  console.log(`   Temp dir: ${tmpDir}\n`);

  // Pick a random high port to avoid conflicts with running servers
  const smokePort = 30000 + Math.floor(Math.random() * 30000);

  let proc: Subprocess | null = null;
  let baseUrl = "";
  let sessionId = "";
  let storedMemoryId = "";

  try {
    // ────────────────────────────────────────────────────────────────
    // Section 1: Server Startup & Health
    // ────────────────────────────────────────────────────────────────
    console.log("§1 Server Startup & Health");

    proc = spawn(
      [
        "bun", "run", SERVER_PATH,
        "--db-file", dbPath,
        "--port", String(smokePort),
        "--enable-history",
        "--history-path", sessionsPath,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpDir,
      }
    );

    // Wait for lockfile
    const lockData = await waitForLockfile(lockfilePath);
    assert(lockData.port > 0, "Lockfile contains valid port");
    assert(lockData.pid === proc.pid, "Lockfile PID matches spawned process");

    baseUrl = `http://127.0.0.1:${lockData.port}`;
    await waitForHealth(baseUrl);

    // Health check
    const healthRes = await httpGet(baseUrl, "/health");
    const health = await healthRes.json() as any;

    assert(health.status === "ok", "GET /health returns status: ok");
    assert(health.config.historyEnabled === true, "Health reports historyEnabled: true");
    assertContains(health.config.dbPath, "smoke-test.db", "Health reports correct dbPath");

    // ────────────────────────────────────────────────────────────────
    // Section 2: Memory Lifecycle (HTTP)
    // ────────────────────────────────────────────────────────────────
    console.log("\n§2 Memory Lifecycle (HTTP)");

    // Initialize MCP session for tool calls
    sessionId = await initMcpSession(baseUrl);
    assert(sessionId.length > 0, "MCP session initialized with session ID");

    // Store via HTTP endpoint
    const storeRes = await httpPost(baseUrl, "/store", {
      content: "The velocity of an unladen swallow is approximately 11 m/s",
      metadata: { category: "ornithology", source: "smoke-test" },
    });
    const storeBody = await storeRes.json() as any;
    assert(storeBody.id !== undefined, "POST /store returns memory ID");
    storedMemoryId = storeBody.id;

    // Search via HTTP
    const searchRes = await httpPost(baseUrl, "/search", {
      query: "unladen swallow velocity",
      intent: "fact_check",
    });
    const searchBody = await searchRes.json() as any;
    assert(searchBody.count > 0, "POST /search finds stored memory");
    assert(
      searchBody.results.some((r: any) => r.id === storedMemoryId),
      "Search results contain the stored memory ID"
    );

    // Get via HTTP
    const getRes = await httpGet(baseUrl, `/memories/${storedMemoryId}`);
    const getBody = await getRes.json() as any;
    assert(getBody.id === storedMemoryId, "GET /memories/:id returns correct memory");
    assertContains(
      getBody.content,
      "unladen swallow",
      "GET /memories/:id content matches"
    );

    // Delete via HTTP
    const deleteRes = await httpDelete(baseUrl, `/memories/${storedMemoryId}`);
    const deleteBody = await deleteRes.json() as any;
    assert(deleteBody.deleted === true, "DELETE /memories/:id returns deleted: true");

    // Search should NOT find deleted memory
    const searchAfterDelete = await httpPost(baseUrl, "/search", {
      query: "unladen swallow velocity",
      intent: "fact_check",
    });
    const afterDeleteBody = await searchAfterDelete.json() as any;
    const foundDeleted = afterDeleteBody.results.some(
      (r: any) => r.id === storedMemoryId
    );
    assert(!foundDeleted, "Deleted memory not found in regular search");

    // Search with include_deleted via MCP
    const searchWithDeleted = await mcpCall(baseUrl, sessionId, "search_memories", {
      query: "unladen swallow velocity",
      intent: "fact_check",
      reason_for_search: "smoke test: verify soft-delete recovery",
      include_deleted: true,
    });
    assertContains(
      searchWithDeleted,
      storedMemoryId,
      "Deleted memory found with include_deleted via MCP"
    );

    // ────────────────────────────────────────────────────────────────
    // Section 3: Waypoint Lifecycle
    // ────────────────────────────────────────────────────────────────
    console.log("\n§3 Waypoint Lifecycle");

    // Store a memory to reference from the waypoint
    const wpStoreResult = await mcpCall(baseUrl, sessionId, "store_memories", {
      memories: [
        {
          content: "Waypoint reference: migration to sqlite-vec is complete",
          metadata: { phase: "migration" },
        },
      ],
    });
    const wpMemoryId = extractMemoryId(wpStoreResult);
    assert(wpMemoryId.length > 0, "Stored waypoint reference memory");

    // Set waypoint via MCP
    const setWpResult = await mcpCall(baseUrl, sessionId, "set_waypoint", {
      project: "smoke-test",
      branch: "main",
      summary: "Completed sqlite-vec migration smoke test",
      next_steps: ["verify retrieval", "run benchmarks"],
      memory_ids: [wpMemoryId],
    });
    assertContains(setWpResult, "Waypoint", "set_waypoint returns confirmation");

    // Get waypoint via MCP
    const getWpResult = await mcpCall(baseUrl, sessionId, "get_waypoint", {});
    assertContains(
      getWpResult,
      "sqlite-vec migration",
      "get_waypoint returns summary"
    );
    assertContains(
      getWpResult,
      "verify retrieval",
      "get_waypoint returns next_steps"
    );

    // Get waypoint via HTTP
    const wpHttpRes = await httpGet(baseUrl, "/waypoint");
    const wpHttpBody = await wpHttpRes.json() as any;
    assert(wpHttpRes.status === 200, "GET /waypoint returns 200");
    assert(
      wpHttpBody.referencedMemories?.length > 0,
      "GET /waypoint includes referencedMemories"
    );
    assertContains(
      wpHttpBody.referencedMemories[0].content,
      "sqlite-vec",
      "Referenced memory content matches"
    );

    // ────────────────────────────────────────────────────────────────
    // Section 4: Conversation History Indexing
    // ────────────────────────────────────────────────────────────────
    console.log("\n§4 Conversation History Indexing");

    // Create a fake Claude Code session JSONL file
    const fakeSessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const projectDir = join(sessionsPath, "-tmp-smoke-project");
    const sessionDir = join(projectDir, fakeSessionId);
    mkdirSync(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    const sessionLines = [
      JSON.stringify({
        type: "user",
        sessionId: fakeSessionId,
        timestamp: now,
        uuid: "msg-001",
        message: {
          role: "user",
          content: "How does the sqlite-vec extension handle vector similarity search?",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: fakeSessionId,
        timestamp: now,
        uuid: "msg-002",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The sqlite-vec extension uses a virtual table to store float32 vectors and supports cosine distance for similarity queries.",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: fakeSessionId,
        timestamp: now,
        uuid: "msg-003",
        message: {
          role: "user",
          content: "What about full-text search integration?",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: fakeSessionId,
        timestamp: now,
        uuid: "msg-004",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "We use FTS5 alongside sqlite-vec for hybrid search, combining vector similarity with keyword matching for better recall.",
            },
          ],
        },
      }),
    ];

    writeFileSync(
      join(sessionDir, `${fakeSessionId}.jsonl`),
      sessionLines.join("\n") + "\n"
    );

    // Index via MCP
    const indexResult = await mcpCall(baseUrl, sessionId, "index_conversations", {
      path: sessionsPath,
    });
    assertContains(indexResult, "Indexed", "index_conversations returns indexed count (MCP)");
    // Check it didn't report 0 indexed
    assert(
      !indexResult.includes("Indexed: 0"),
      "index_conversations indexed at least 1 session (MCP)"
    );

    // Create a second session for HTTP endpoint test
    const httpSessionId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const httpSessionDir = join(projectDir, httpSessionId);
    mkdirSync(httpSessionDir, { recursive: true });
    writeFileSync(
      join(httpSessionDir, `${httpSessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user", sessionId: httpSessionId, timestamp: now, uuid: "msg-h01",
          message: { role: "user", content: "How does the warmup script download the ONNX model?" },
        }),
        JSON.stringify({
          type: "assistant", sessionId: httpSessionId, timestamp: now, uuid: "msg-h02",
          message: { role: "assistant", content: [{ type: "text", text: "The warmup script uses @huggingface/transformers to download and cache the ONNX model on first run." }] },
        }),
      ].join("\n") + "\n"
    );

    // Index via HTTP endpoint (POST /index-conversations)
    const httpIndexRes = await httpPost(baseUrl, "/index-conversations", {
      path: sessionsPath,
    });
    const httpIndexBody = await httpIndexRes.json() as any;
    assert(httpIndexRes.status === 200, "POST /index-conversations returns 200");
    assert(httpIndexBody.indexed >= 1, "POST /index-conversations indexed at least 1 new session");

    // Search history
    const historySearch = await mcpCall(baseUrl, sessionId, "search_memories", {
      query: "sqlite-vec vector similarity search",
      intent: "fact_check",
      reason_for_search: "smoke test: verify conversation history search",
      history_only: true,
    });
    assertContains(
      historySearch,
      "sqlite-vec",
      "history_only search returns conversation content"
    );

    // List indexed sessions
    const listResult = await mcpCall(baseUrl, sessionId, "list_indexed_sessions", {});
    assertContains(
      listResult,
      fakeSessionId,
      "list_indexed_sessions shows our session"
    );

    // Reindex session
    const reindexResult = await mcpCall(baseUrl, sessionId, "reindex_session", {
      session_id: fakeSessionId,
    });
    assertContains(
      reindexResult,
      "success",
      "reindex_session reports success"
    );

    // ────────────────────────────────────────────────────────────────
    // Section 5: Memory Usefulness Voting
    // ────────────────────────────────────────────────────────────────
    console.log("\n§5 Memory Usefulness Voting");

    // Store a fresh memory for voting
    const voteStoreResult = await mcpCall(baseUrl, sessionId, "store_memories", {
      memories: [
        {
          content: "Bun is faster than Node.js for starting processes",
          metadata: { topic: "runtime" },
        },
      ],
    });
    const voteMemoryId = extractMemoryId(voteStoreResult);

    // Vote useful
    const voteUpResult = await mcpCall(
      baseUrl,
      sessionId,
      "report_memory_usefulness",
      { memory_id: voteMemoryId, useful: true }
    );
    assert(
      !voteUpResult.startsWith("ERROR"),
      "report_memory_usefulness(useful: true) succeeds"
    );

    // Vote not useful
    const voteDownResult = await mcpCall(
      baseUrl,
      sessionId,
      "report_memory_usefulness",
      { memory_id: voteMemoryId, useful: false }
    );
    assert(
      !voteDownResult.startsWith("ERROR"),
      "report_memory_usefulness(useful: false) succeeds"
    );

    // ────────────────────────────────────────────────────────────────
    // Section 6: Lockfile Cleanup
    // ────────────────────────────────────────────────────────────────
    console.log("\n§6 Lockfile Cleanup");

    assert(existsSync(lockfilePath), "Lockfile exists before shutdown");

    // Send SIGTERM for graceful shutdown
    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    assert(exitCode === 0, `Server exited with code 0 (got ${exitCode})`);

    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 500));
    assert(!existsSync(lockfilePath), "Lockfile removed after SIGTERM");

    proc = null; // Mark as cleaned up

    // ────────────────────────────────────────────────────────────────
    // Section 7: Migration Detection
    // ────────────────────────────────────────────────────────────────
    console.log("\n§7 Migration Detection");

    // Create a fake LanceDB directory
    const fakeLanceDir = join(tmpDir, "fake-lance.db");
    mkdirSync(join(fakeLanceDir, "memories.lance"), { recursive: true });

    const migProc = spawn(
      ["bun", "run", SERVER_PATH, "--db-file", fakeLanceDir],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpDir,
      }
    );

    const migExitCode = await migProc.exited;
    assert(migExitCode === 1, `Server exits with code 1 on LanceDB detection (got ${migExitCode})`);

    // Read stderr for the error message
    const migStderr = await new Response(migProc.stderr as ReadableStream).text();
    assertContains(
      migStderr,
      "Legacy LanceDB data detected",
      "Stderr contains legacy data warning"
    );
    assertContains(
      migStderr,
      "migrate",
      "Stderr mentions migrate command"
    );

    // ────────────────────────────────────────────────────────────────
    // Section 8: Migrate Subcommand (No Real Data)
    // ────────────────────────────────────────────────────────────────
    console.log("\n§8 Migrate Subcommand (No Real Data)");

    const nonexistentPath = join(tmpDir, "does-not-exist.db");
    const migCmdProc = spawn(
      ["bun", "run", SERVER_PATH, "migrate", "--db-file", nonexistentPath],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpDir,
      }
    );

    const migCmdExit = await migCmdProc.exited;
    // Note: main() catches errors with .catch(console.error), so exit code may be 0
    // even on failure. We verify via stderr content instead.
    const migCmdStderr = await new Response(migCmdProc.stderr as ReadableStream).text();
    assert(
      migCmdStderr.includes("Source not found") ||
        migCmdStderr.includes("not a directory") ||
        migCmdStderr.includes("not found") ||
        migCmdStderr.includes("Error"),
      "Migrate with nonexistent source produces error message"
    );

  } catch (error) {
    failed++;
    const msg = error instanceof Error ? error.message : String(error);
    failures.push(`FATAL: ${msg}`);
    console.log(`\n  💥 FATAL ERROR: ${msg}`);
    if (error instanceof Error && error.stack) {
      console.log(`     ${error.stack.split("\n").slice(1, 4).join("\n     ")}`);
    }
  } finally {
    // Clean up server if still running
    if (proc) {
      try {
        proc.kill("SIGKILL");
        await proc.exited;
      } catch {
        // Already exited
      }
    }

    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      console.log(`  ⚠️  Could not clean up ${tmpDir}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
  }
  console.log(`${"─".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
