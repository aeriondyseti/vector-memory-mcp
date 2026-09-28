import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { BackupService } from "../server/core/backup.service";
import { removeDir, fakeEmbedding } from "./utils/test-helpers";

describe("BackupService", () => {
  let db: Database;
  let repository: MemoryRepository;
  let tmpDir: string;
  let dbPath: string;
  let service: BackupService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-backup-test-"));
    dbPath = join(tmpDir, "test.db");
    db = connectToDatabase(dbPath);
    repository = new MemoryRepository(db);

    await repository.insert({
      id: "mem-1",
      content: "hello backup world",
      embedding: fakeEmbedding(),
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      supersededBy: null,
      usefulness: 0,
      accessCount: 0,
      lastAccessed: new Date(),
      project: null,
    });

    // Close the handle before any backup/restore that copies the db file —
    // on Windows an open bun:sqlite handle keeps the file locked.
    db.close();

    service = new BackupService(dbPath);
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  test("create() copies the db and records metadata", () => {
    const record = service.create("initial backup");

    expect(existsSync(record.path)).toBe(true);
    expect(record.description).toBe("initial backup");
    expect(record.sizeBytes).toBeGreaterThan(0);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.id.length).toBeGreaterThan(0);
  });

  test("create() writes an index file with the record", () => {
    const record = service.create();
    const list = service.list();

    expect(list.length).toBe(1);
    expect(list[0].id).toBe(record.id);
  });

  test("list() returns newest first", () => {
    const first = service.create("first");
    const second = service.create("second");

    const list = service.list();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
  });

  test("list() returns empty array when no backups exist", () => {
    expect(service.list()).toEqual([]);
  });

  test("list() tolerates a missing/corrupt index file", () => {
    const record = service.create();
    // Corrupt the index sidecar directly.
    const indexPath = join(tmpDir, "backups", "backups-index.json");
    writeFileSync(indexPath, "{ not valid json");

    // Reading via a fresh service instance should treat it as empty rather
    // than throw.
    const fresh = new BackupService(dbPath);
    expect(fresh.list()).toEqual([]);
    // The backup file itself is untouched.
    expect(existsSync(record.path)).toBe(true);
  });

  test("verify() reports valid for an untouched backup", () => {
    const record = service.create();
    const result = service.verify(record.id);

    expect(result.exists).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.expectedSha256).toBe(record.sha256);
    expect(result.actualSha256).toBe(record.sha256);
  });

  test("verify() reports invalid for a corrupted backup file", () => {
    const record = service.create();
    writeFileSync(record.path, Buffer.from("corrupted bytes"));

    const result = service.verify(record.id);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.actualSha256).not.toBe(result.expectedSha256);
  });

  test("verify() reports not-exists for an unknown id", () => {
    const result = service.verify("does-not-exist");
    expect(result.exists).toBe(false);
    expect(result.valid).toBe(false);
  });

  test("restore() requires confirmation", () => {
    const record = service.create();
    const result = service.restore(record.id, false);

    expect(result.restored).toBe(false);
    expect(result.reason).toBe("confirmation required");
  });

  test("restore() with confirm restores db and creates a safety backup", () => {
    const record = service.create("to restore");

    // Mutate the live db so we can tell restore actually overwrote it.
    writeFileSync(dbPath, Buffer.from("mutated content"));

    const result = service.restore(record.id, true);

    expect(result.restored).toBe(true);
    expect(result.safetyBackupId).toBeDefined();

    // The safety backup should now exist in the index/list.
    const list = service.list();
    const safety = list.find((b) => b.id === result.safetyBackupId);
    expect(safety).toBeDefined();
    expect(existsSync(safety!.path)).toBe(true);

    // The db content should now match the restored backup file's bytes.
    const restoredBytes = readFileSync(dbPath);
    const backupBytes = readFileSync(record.path);
    expect(restoredBytes.equals(backupBytes)).toBe(true);
  });

  test("restore() returns not found for an unknown id", () => {
    const result = service.restore("nope", true);
    expect(result.restored).toBe(false);
    expect(result.reason).toBe("not found");
  });

  test("purge() keeps only the newest N backups", () => {
    const first = service.create("1");
    const second = service.create("2");
    const third = service.create("3");

    const result = service.purge(1);

    expect(result.deleted.sort()).toEqual([first.id, second.id].sort());
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
    expect(existsSync(third.path)).toBe(true);

    const remaining = service.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(third.id);
  });
});
