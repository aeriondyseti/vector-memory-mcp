/**
 * Timestamp round-trip tests.
 *
 * These tests pin down the exact UTC-preservation guarantee for all Date fields
 * stored in LanceDB and returned by the HTTP /waypoint endpoint.
 *
 * The "3 hours ago" bug: if updatedAt loses its Z suffix (or is stored as
 * local-time ms), a consumer doing `Date.now() - new Date(updatedAt).getTime()`
 * will see the UTC offset as elapsed time instead of actual age.
 */
import { describe, expect, test, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { EmbeddingsService } from "../server/core/embeddings.service";
import { MemoryService } from "../server/core/memory.service";
import { createHttpApp } from "../server/transports/http/server";
import { fakeEmbedding } from "./utils/test-helpers";
import type { Memory } from "../server/core/memory";
import type { Config } from "../server/config/index";

// A fixed UTC moment with a non-zero hour so a UTC-offset bug shifts it visibly.
const KNOWN_UTC_MS = new Date("2026-01-15T09:30:00.000Z").getTime();
const KNOWN_UTC_ISO = "2026-01-15T09:30:00.000Z";

describe("Timestamp round-trip — LanceDB UTC preservation", () => {
  let db: Database;
  let repository: MemoryRepository;
  let tmpDir: string;

  const baseMemory = (): Memory => ({
    id: "ts-test-1",
    content: "timestamp round-trip test",
    embedding: fakeEmbedding(),
    metadata: {},
    createdAt: new Date(KNOWN_UTC_MS),
    updatedAt: new Date(KNOWN_UTC_MS),
    supersededBy: null,
    usefulness: 0,
    accessCount: 0,
    lastAccessed: new Date(KNOWN_UTC_MS),
  });

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-ts-test-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true });
  });

  test("insert + findById: updatedAt round-trips as UTC", async () => {
    const memory = baseMemory();
    await repository.insert(memory);

    const result = await repository.findById("ts-test-1");
    expect(result).not.toBeNull();

    // The core assertion: the stored ms must survive unchanged.
    expect(result!.updatedAt.getTime()).toBe(KNOWN_UTC_MS);
    expect(result!.updatedAt.toISOString()).toBe(KNOWN_UTC_ISO);
  });

  test("insert + findById: createdAt round-trips as UTC", async () => {
    const memory = baseMemory();
    await repository.insert(memory);

    const result = await repository.findById("ts-test-1");
    expect(result!.createdAt.getTime()).toBe(KNOWN_UTC_MS);
    expect(result!.createdAt.toISOString()).toBe(KNOWN_UTC_ISO);
  });

  test("upsert (update path): updatedAt round-trips as UTC", async () => {
    const memory = baseMemory();
    await repository.insert(memory);

    // Update with a different known timestamp
    const laterMs = new Date("2026-01-15T10:00:00.000Z").getTime();
    const updatedMemory: Memory = { ...memory, updatedAt: new Date(laterMs) };
    await repository.upsert(updatedMemory);

    const result = await repository.findById("ts-test-1");
    expect(result!.updatedAt.getTime()).toBe(laterMs);
    expect(result!.updatedAt.toISOString()).toBe("2026-01-15T10:00:00.000Z");
  });

  test("markDeleted: updated_at is set correctly (within 5 s of now)", async () => {
    const memory = baseMemory();
    await repository.insert(memory);

    const before = Date.now();
    await repository.markDeleted("ts-test-1");
    const after = Date.now();

    const result = await repository.findById("ts-test-1");
    const updatedMs = result!.updatedAt.getTime();

    // The timestamp written by markDeleted must fall between before and after.
    expect(updatedMs).toBeGreaterThanOrEqual(before - 5000);
    expect(updatedMs).toBeLessThanOrEqual(after + 5000);
  });

  test("updatedAt is a real Date instance (not BigInt, string, or NaN)", async () => {
    const memory = baseMemory();
    await repository.insert(memory);

    const result = await repository.findById("ts-test-1");
    expect(result!.updatedAt).toBeInstanceOf(Date);
    expect(isNaN(result!.updatedAt.getTime())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP /waypoint endpoint — updatedAt serialization
// ---------------------------------------------------------------------------
// These tests simulate the exact consumer behavior described in the bug report:
//   Date.now() - new Date(response.updatedAt).getTime()
// should be small (seconds), not large (hours, because the Z suffix was missing
// and the client parsed the timestamp as local time instead of UTC).

function makeHttpConfig(dbPath: string): Config {
  return {
    dbPath,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDimension: 384,
    httpPort: 3279,
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

describe("GET /waypoint — updatedAt UTC serialization", () => {
  let app: ReturnType<typeof createHttpApp>;
  let memoryService: MemoryService;
  let httpTmpDir: string;
  let db: Database;

  beforeAll(async () => {
    httpTmpDir = mkdtempSync(join(tmpdir(), "vector-memory-http-ts-test-"));
    db = connectToDatabase(join(httpTmpDir, "test.db"));
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    memoryService = new MemoryService(repository, embeddings);
    app = createHttpApp(memoryService, makeHttpConfig(join(httpTmpDir, "test.db")));
  });

  afterAll(() => {
    db.close();
    rmSync(httpTmpDir, { recursive: true });
  });

  test("updatedAt in response ends with Z (is UTC ISO 8601)", async () => {
    await memoryService.setWaypoint({
      project: "tz-test",
      branch: "main",
      summary: "Timestamp serialization regression test",
    });

    const res = await app.request("/waypoint?project=tz-test");
    expect(res.status).toBe(200);

    const body = await res.json() as { updatedAt: string };
    expect(typeof body.updatedAt).toBe("string");
    // Must have Z suffix — without it, clients in non-UTC zones misparse as local time
    expect(body.updatedAt).toMatch(/Z$/);
    // Must be a valid ISO 8601 datetime
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("consumer simulation: age computed from updatedAt is within 10 s of actual", async () => {
    const before = Date.now();
    await memoryService.setWaypoint({
      project: "tz-consumer-test",
      branch: "main",
      summary: "Consumer age calculation test",
    });
    const after = Date.now();

    const res = await app.request("/waypoint?project=tz-consumer-test");
    const body = await res.json() as { updatedAt: string };

    // Reproduce the consumer's exact calculation
    const parsedMs = new Date(body.updatedAt).getTime();

    // The parsed timestamp must fall within the window when setWaypoint was called.
    // A 3-hour offset bug would fail this by ~10_800_000 ms.
    expect(parsedMs).toBeGreaterThanOrEqual(before - 1000);
    expect(parsedMs).toBeLessThanOrEqual(after + 1000);
  });

  test("updatedAt round-trips: new Date(updatedAt).getTime() matches stored ms", async () => {
    await memoryService.setWaypoint({
      project: "tz-roundtrip-test",
      branch: "main",
      summary: "Direct ms round-trip test",
    });

    const res = await app.request("/waypoint?project=tz-roundtrip-test");
    const body = await res.json() as { updatedAt: string };

    // getTime() on a correctly-parsed Z-suffixed string must be a valid UTC epoch ms
    const parsedMs = new Date(body.updatedAt).getTime();
    expect(isNaN(parsedMs)).toBe(false);
    // Must be within 10 s of now — not 3 hours off
    const drift = Math.abs(Date.now() - parsedMs);
    expect(drift).toBeLessThan(10_000);
  });
});
