import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { repairConversationProjects, runMigrations } from "../server/core/migrations";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { normalizeProject, projectDisplayName } from "../server/core/project";
import { globalLockPath } from "../server/transports/http/server";
import type { Memory } from "../server/core/memory";
import { createMockEmbeddings, fakeEmbedding, EMBEDDING_DIM, removeDir } from "./utils/test-helpers";

function makeMemory(id: string, content: string, project: string | null): Memory {
  return {
    id,
    content,
    embedding: fakeEmbedding(),
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    supersededBy: null,
    usefulness: 0,
    accessCount: 0,
    lastAccessed: null,
    project,
  };
}

describe("normalizeProject", () => {
  test("canonicalizes paths", () => {
    expect(normalizeProject("/home/user/repo")).toBe("/home/user/repo");
    expect(normalizeProject("/home/user/repo/")).toBe("/home/user/repo");
    expect(normalizeProject("home/user/repo")).toBe("/home/user/repo");
    expect(normalizeProject("  /home/user/repo  ")).toBe("/home/user/repo");
    expect(normalizeProject("/")).toBe("/");
    expect(normalizeProject("")).toBe("");
  });

  test("display name is the basename", () => {
    expect(projectDisplayName("/home/user/my-repo")).toBe("my-repo");
  });
});

describe("versioned migration (project column)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "global-store-migration-"));
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  test("adds project column to a pre-existing database and backfills from metadata", () => {
    const dbPath = join(tmpDir, "old.db");

    // Build an old-schema database (no project column, user_version 0)
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        superseded_by TEXT, usefulness REAL NOT NULL DEFAULT 0.0,
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed INTEGER
      )
    `);
    old
      .prepare(
        "INSERT INTO memories (id, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("m1", "hello", JSON.stringify({ project: "legacy-name" }), 1, 1);
    old
      .prepare(
        "INSERT INTO memories (id, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("m2", "no project", "{}", 1, 1);
    old.close();

    const db = connectToDatabase(dbPath);
    const rows = db
      .prepare("SELECT id, project FROM memories ORDER BY id")
      .all() as Array<{ id: string; project: string | null }>;
    expect(rows[0].project).toBe("legacy-name");
    expect(rows[1].project).toBeNull();

    const version = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    expect(version).toBeGreaterThanOrEqual(1);

    // Re-running migrations is a no-op (no duplicate-column crash)
    runMigrations(db);
    db.close();
  });

  test("fresh databases get the project column via CREATE TABLE", () => {
    const db = connectToDatabase(join(tmpDir, "fresh.db"));
    const columns = db
      .prepare("PRAGMA table_info(memories)")
      .all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === "project")).toBe(true);
    db.close();
  });
});

describe("repairConversationProjects", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "global-store-repair-"));
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  test("re-derives legacy project values from the session file cwd", async () => {
    const dbPath = join(tmpDir, "repair.db");
    const db = connectToDatabase(dbPath);

    // Session file with a cwd that the lossy decode would mangle
    const sessionFile = join(tmpDir, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "user",
        cwd: "/home/user/my-dashed-repo",
        message: { role: "user", content: "hi" },
      }) + "\n",
    );

    db.prepare(
      `INSERT INTO conversation_history (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "chunk", "{}", 1, "sess-1", "user", 0, 0, "home/user/my/dashed/repo");
    db.prepare(
      `INSERT INTO conversation_index_state (session_id, file_path, project, last_modified, chunk_count, message_count, indexed_at, first_message_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess-1", sessionFile, "home/user/my/dashed/repo", 1, 1, 1, 1, 1, 1);

    await repairConversationProjects(db, dbPath);

    const row = db
      .prepare("SELECT project FROM conversation_history WHERE id = 'c1'")
      .get() as { project: string };
    expect(row.project).toBe("/home/user/my-dashed-repo");

    const state = db
      .prepare("SELECT project FROM conversation_index_state WHERE session_id = 'sess-1'")
      .get() as { project: string };
    expect(state.project).toBe("/home/user/my-dashed-repo");
    db.close();
  });

  test("best-effort slash prefix when the session file is gone", async () => {
    const dbPath = join(tmpDir, "repair2.db");
    const db = connectToDatabase(dbPath);
    db.prepare(
      `INSERT INTO conversation_history (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "chunk", "{}", 1, "gone", "user", 0, 0, "home/user/repo");

    await repairConversationProjects(db, dbPath);

    const row = db
      .prepare("SELECT project FROM conversation_history WHERE id = 'c1'")
      .get() as { project: string };
    expect(row.project).toBe("/home/user/repo");
    db.close();
  });
});

describe("pre-filtered project search", () => {
  let tmpDir: string;
  let db: ReturnType<typeof connectToDatabase>;
  let repository: MemoryRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "global-store-search-"));
    db = connectToDatabase(join(tmpDir, "search.db"));
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("small project returns its matches even inside a large shared db", async () => {
    // 200 memories for project A drown out 5 for project B in any global top-K
    for (let i = 0; i < 200; i++) {
      await repository.insert(makeMemory(`a-${i}`, `alpha content ${i}`, "/proj/a"));
    }
    for (let i = 0; i < 5; i++) {
      await repository.insert(makeMemory(`b-${i}`, `beta content ${i}`, "/proj/b"));
    }

    const results = await repository.findHybrid(
      fakeEmbedding(),
      "beta content",
      10,
      { project: "/proj/b" },
    );

    expect(results.length).toBe(5);
    expect(results.every((r) => r.project === "/proj/b")).toBe(true);
  });

  test("unfiltered search spans all projects", async () => {
    await repository.insert(makeMemory("a-1", "shared topic from a", "/proj/a"));
    await repository.insert(makeMemory("b-1", "shared topic from b", "/proj/b"));

    const results = await repository.findHybrid(fakeEmbedding(), "shared topic", 10);
    const projects = new Set(results.map((r) => r.project));
    expect(projects.has("/proj/a")).toBe(true);
    expect(projects.has("/proj/b")).toBe(true);
  });
});

describe("MemoryService project behavior", () => {
  let tmpDir: string;
  let db: ReturnType<typeof connectToDatabase>;
  let repository: MemoryRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "global-store-service-"));
    db = connectToDatabase(join(tmpDir, "service.db"));
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("store stamps the configured project; per-item override is normalized", async () => {
    const service = new MemoryService(repository, createMockEmbeddings(), "/proj/a");

    const stamped = await service.store("auto-tagged");
    expect(stamped.project).toBe("/proj/a");

    const overridden = await service.store("explicit", {}, undefined, "proj/b/");
    expect(overridden.project).toBe("/proj/b");

    const persisted = await repository.findById(stamped.id);
    expect(persisted?.project).toBe("/proj/a");
  });

  test("waypoints are isolated per project (no UUID_ZERO clobber)", async () => {
    const serviceA = new MemoryService(repository, createMockEmbeddings(), "/proj/a");
    const serviceB = new MemoryService(repository, createMockEmbeddings(), "/proj/b");

    await serviceA.setWaypoint({ summary: "waypoint for A" });
    await serviceB.setWaypoint({ summary: "waypoint for B" });

    const a = await serviceA.getLatestWaypoint();
    const b = await serviceB.getLatestWaypoint();
    expect(a?.content).toContain("waypoint for A");
    expect(b?.content).toContain("waypoint for B");

    // No global UUID_ZERO copy is written anymore
    const zero = await repository.findById("00000000-0000-0000-0000-000000000000");
    expect(zero).toBeNull();
  });

  test("legacy basename-keyed waypoint is found and migrated", async () => {
    const project = "/home/user/my-repo";
    const service = new MemoryService(repository, createMockEmbeddings(), project);

    // Simulate a pre-migration waypoint keyed by the skill-supplied basename
    const legacyHex = createHash("sha256")
      .update("waypoint:my-repo")
      .digest("hex");
    const legacyId = `wp:${legacyHex.slice(0, 32)}`;
    await repository.upsert({
      ...makeMemory(legacyId, "# Waypoint - my-repo\nlegacy waypoint", null),
      embedding: new Array(EMBEDDING_DIM).fill(0),
      metadata: { type: "waypoint", project: "my-repo" },
    });

    const found = await service.getLatestWaypoint();
    expect(found?.content).toContain("legacy waypoint");

    // Migrated under the canonical path-derived ID
    const canonicalHex = createHash("sha256")
      .update(`waypoint:${project.toLowerCase()}`)
      .digest("hex");
    const canonical = await repository.findById(`wp:${canonicalHex.slice(0, 32)}`);
    expect(canonical?.content).toContain("legacy waypoint");
  });

  test("UUID_ZERO fallback only matches its own project", async () => {
    const service = new MemoryService(
      repository,
      createMockEmbeddings(),
      "/home/user/other-repo",
    );

    await repository.upsert({
      ...makeMemory(
        "00000000-0000-0000-0000-000000000000",
        "# Waypoint - some-repo\nnot yours",
        null,
      ),
      embedding: new Array(EMBEDDING_DIM).fill(0),
      metadata: { type: "waypoint", project: "some-repo" },
    });

    // other-repo must not see some-repo's pre-migration waypoint
    expect(await service.getLatestWaypoint()).toBeNull();
  });

  test("scope filters service search; scope all attributes projects", async () => {
    const embeddings = createMockEmbeddings();
    const service = new MemoryService(repository, embeddings, "/proj/a");
    await service.store("topic alpha in project a");
    await service.store("topic alpha in project b", {}, undefined, "/proj/b");

    const scoped = await service.search("topic alpha", "fact_check", {
      scope: "project",
      includeHistory: false,
    });
    expect(scoped.length).toBe(1);
    expect(scoped[0].project).toBe("/proj/a");

    const all = await service.search("topic alpha", "fact_check", {
      includeHistory: false,
    });
    const projects = new Set(all.map((r) => r.project));
    expect(projects.has("/proj/a")).toBe(true);
    expect(projects.has("/proj/b")).toBe(true);

    const explicit = await service.search("topic alpha", "fact_check", {
      scope: "/proj/b",
      includeHistory: false,
    });
    expect(explicit.length).toBe(1);
    expect(explicit[0].project).toBe("/proj/b");
  });
});

describe("lockfile path parity", () => {
  test("server hash matches the hooks-lib algorithm", () => {
    const project = "/home/user/some-repo";
    // hooks-lib uses Bun.CryptoHasher; server uses node:crypto — same algorithm
    const hooksHash = new Bun.CryptoHasher("sha256")
      .update(project)
      .digest("hex")
      .slice(0, 16);
    expect(globalLockPath(project)).toBe(
      join(homedir(), ".vector-memory", "locks", `${hooksHash}.lock`),
    );
  });
});
