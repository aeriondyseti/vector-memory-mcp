import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase, relocateLegacyLanceDir } from "../server/core/connection";
import { removeDir } from "./utils/test-helpers";

describe("relocateLegacyLanceDir", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-conn-test-"));
    dbPath = join(tmpDir, "memories.db");
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  const makeLanceDir = (path: string) => {
    mkdirSync(join(path, "memories.lance", "_versions"), { recursive: true });
  };

  test("returns null when the path does not exist", () => {
    expect(relocateLegacyLanceDir(dbPath)).toBeNull();
  });

  test("returns null when the path is a regular file", () => {
    writeFileSync(dbPath, "");
    expect(relocateLegacyLanceDir(dbPath)).toBeNull();
  });

  test("moves a LanceDB directory aside and reports the target", () => {
    makeLanceDir(dbPath);
    const target = relocateLegacyLanceDir(dbPath);
    expect(target).toBe(`${dbPath}.lancedb`);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(target!, "memories.lance"))).toBe(true);
  });

  test("picks a numbered target when .lancedb already exists", () => {
    makeLanceDir(dbPath);
    mkdirSync(`${dbPath}.lancedb`);
    const target = relocateLegacyLanceDir(dbPath);
    expect(target).toBe(`${dbPath}.lancedb.1`);
    expect(existsSync(join(target!, "memories.lance"))).toBe(true);
  });

  test("throws a clear error for a non-LanceDB directory", () => {
    mkdirSync(dbPath);
    writeFileSync(join(dbPath, "random.txt"), "");
    expect(() => relocateLegacyLanceDir(dbPath)).toThrow(/is a directory/);
  });

  test("connectToDatabase recovers when a LanceDB directory occupies the db path", () => {
    makeLanceDir(dbPath);
    const db = connectToDatabase(dbPath);
    try {
      // Fresh SQLite db was created and migrated where the directory used to be
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memories'")
        .get();
      expect(row).not.toBeNull();
    } finally {
      db.close();
    }
    expect(existsSync(`${dbPath}.lancedb`)).toBe(true);
  });
});
