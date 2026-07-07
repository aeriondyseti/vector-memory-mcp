import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import {
  ConsolidationService,
  discoverSourceDbs,
} from "../server/core/consolidation.service";
import { MemoryRepository } from "../server/core/memory.repository";
import { normalizeProject } from "../server/core/project";
import { safeParseJsonObject } from "../server/core/sqlite-utils";
import type { Memory } from "../server/core/memory";
import { createMockEmbeddings, fakeEmbedding, EMBEDDING_DIM, removeDir } from "./utils/test-helpers";

const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

function waypointIdFor(project: string): string {
  // Mirror production: waypoints are keyed by the CANONICAL project id, so
  // normalize first (identity on POSIX; prepends "/" to Windows drive paths).
  const hex = createHash("sha256")
    .update(`waypoint:${normalizeProject(project).trim().toLowerCase()}`)
    .digest("hex");
  return `wp:${hex.slice(0, 32)}`;
}

function makeMemory(
  id: string,
  content: string,
  overrides: Partial<Memory> = {},
): Memory {
  return {
    id,
    content,
    embedding: fakeEmbedding(),
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    supersededBy: null,
    usefulness: 2,
    accessCount: 7,
    lastAccessed: new Date("2026-02-01T00:00:00Z"),
    project: null,
    ...overrides,
  };
}

/** Create a repo-local database under <root>/<name>/.vector-memory/memories.db */
function makeRepoDb(root: string, name: string): {
  repoPath: string;
  dbPath: string;
  repository: MemoryRepository;
  close: () => void;
} {
  const repoPath = join(root, name);
  const dir = join(repoPath, ".vector-memory");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "memories.db");
  const db = connectToDatabase(dbPath);
  return {
    repoPath,
    dbPath,
    repository: new MemoryRepository(db),
    close: () => db.close(),
  };
}

describe("consolidation", () => {
  let tmpDir: string;
  let globalDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "consolidation-test-"));
    globalDbPath = join(tmpDir, "global", "memories.db");
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  test("discoverSourceDbs finds direct and recursive repo dbs", () => {
    const a = makeRepoDb(tmpDir, "repo-a");
    const b = makeRepoDb(join(tmpDir, "nested"), "repo-b");
    a.close();
    b.close();

    expect(discoverSourceDbs(a.repoPath, false)).toEqual([a.dbPath]);
    const recursive = discoverSourceDbs(tmpDir, true).sort();
    expect(recursive).toEqual([a.dbPath, b.dbPath].sort());
  });

  test("imports, re-keys collisions, remaps references, preserves vectors", async () => {
    const repoA = makeRepoDb(tmpDir, "repo-a");
    const repoB = makeRepoDb(tmpDir, "repo-b");
    const projectA = repoA.repoPath;
    const projectB = repoB.repoPath;

    // Same ID, different content in both repos → B's gets re-keyed
    const dupVectorA = fakeEmbedding();
    await repoA.repository.insert(
      makeMemory("dup-id", "content from A", { embedding: dupVectorA }),
    );
    await repoB.repository.insert(makeMemory("dup-id", "content from B"));

    // Pre-migration waypoints stored under UUID_ZERO, referencing dup-id
    const zeroVec = new Array(EMBEDDING_DIM).fill(0);
    await repoA.repository.insert(
      makeMemory(UUID_ZERO, "# Waypoint A\n## Memory IDs\n- dup-id", {
        embedding: zeroVec,
        metadata: { type: "waypoint", project: "repo-a", memory_ids: ["dup-id"] },
      }),
    );
    await repoB.repository.insert(
      makeMemory(UUID_ZERO, "# Waypoint B\n## Memory IDs\n- dup-id", {
        embedding: zeroVec,
        metadata: { type: "waypoint", project: "repo-b", memory_ids: ["dup-id"] },
      }),
    );
    repoA.close();
    repoB.close();

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );

      const summary = await service.consolidate({
        root: tmpDir,
        recursive: true,
        dryRun: false,
        archive: false,
        force: true,
      });

      expect(summary.sources.length).toBe(2);
      for (const s of summary.sources) {
        expect(s.errors).toEqual([]);
      }

      const targetRepo = new MemoryRepository(target);

      // First-imported dup keeps its ID; the second is re-keyed
      const dup = await targetRepo.findById("dup-id");
      expect(dup).not.toBeNull();
      const all = target
        .prepare("SELECT id, content, metadata, project FROM memories")
        .all() as Array<{ id: string; content: string; metadata: string; project: string }>;

      const rekeyed = all.find(
        (m) => m.id !== "dup-id" && !m.id.startsWith("wp:") &&
          safeParseJsonObject(m.metadata).original_id === "dup-id",
      );
      expect(rekeyed).toBeDefined();
      expect(new Set([dup!.content, rekeyed!.content])).toEqual(
        new Set(["content from A", "content from B"]),
      );

      // Waypoints re-keyed to canonical per-project IDs
      const wpA = await targetRepo.findById(waypointIdFor(projectA));
      const wpB = await targetRepo.findById(waypointIdFor(projectB));
      expect(wpA?.content).toContain("Waypoint A");
      expect(wpB?.content).toContain("Waypoint B");
      expect(await targetRepo.findById(UUID_ZERO)).toBeNull();

      // The repo whose dup was re-keyed has its waypoint references remapped
      // (metadata AND rendered content)
      const wpForRekeyed = dup!.content === "content from A" ? wpB! : wpA!;
      expect(wpForRekeyed.metadata.memory_ids).toEqual([rekeyed!.id]);
      expect(wpForRekeyed.content).toContain(rekeyed!.id);

      // The other waypoint still points at the surviving dup-id
      const wpForKept = dup!.content === "content from A" ? wpA! : wpB!;
      expect(wpForKept.metadata.memory_ids).toEqual(["dup-id"]);

      // Project stamped on the column and metadata; import batch recorded
      for (const m of all) {
        expect(m.project.startsWith("/")).toBe(true);
        const meta = safeParseJsonObject(m.metadata);
        expect(meta.import_batch).toBe(summary.importBatch);
      }

      // Vector blobs preserved byte-for-byte (no re-embedding)
      const vec = target
        .prepare("SELECT vector FROM memories_vec WHERE id = ?")
        .get("dup-id") as { vector: Buffer };
      const expected = Buffer.from(
        new Float32Array(
          dup!.content === "content from A" ? dupVectorA : [],
        ).buffer,
      );
      if (dup!.content === "content from A") {
        expect(Buffer.compare(vec.vector, expected)).toBe(0);
      }

      // Waypoints keep zero vectors
      const wpVec = target
        .prepare("SELECT vector FROM memories_vec WHERE id = ?")
        .get(waypointIdFor(projectA)) as { vector: Buffer };
      expect(new Float32Array(wpVec.vector.buffer, wpVec.vector.byteOffset, EMBEDDING_DIM)
        .every((v) => v === 0)).toBe(true);
    } finally {
      target.close();
    }
  });

  test("dry run plans the same counts but writes nothing", async () => {
    const repo = makeRepoDb(tmpDir, "repo-dry");
    await repo.repository.insert(makeMemory("m1", "memory one"));
    await repo.repository.insert(
      makeMemory(UUID_ZERO, "# Waypoint\nsummary", {
        embedding: new Array(EMBEDDING_DIM).fill(0),
        metadata: { type: "waypoint", project: "repo-dry" },
      }),
    );
    repo.close();

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );

      const dry = await service.consolidate({
        root: repo.repoPath,
        recursive: false,
        dryRun: true,
        archive: false,
        force: true,
      });
      expect(dry.sources[0].memoriesImported).toBe(2);
      expect(dry.sources[0].memoriesRekeyed).toBe(1); // UUID_ZERO -> wp:...
      expect(dry.backupPath).toBeNull();
      expect(
        (target.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n,
      ).toBe(0);

      const real = await service.consolidate({
        root: repo.repoPath,
        recursive: false,
        dryRun: false,
        archive: false,
        force: true,
      });
      expect(real.sources[0].memoriesImported).toBe(dry.sources[0].memoriesImported);
      expect(real.sources[0].memoriesRekeyed).toBe(dry.sources[0].memoriesRekeyed);
      expect(
        (target.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n,
      ).toBe(2);
    } finally {
      target.close();
    }
  });

  test("identical rows are skipped on re-run (idempotent)", async () => {
    const repo = makeRepoDb(tmpDir, "repo-idem");
    await repo.repository.insert(makeMemory("m1", "same content"));
    repo.close();

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );
      const opts = {
        root: repo.repoPath,
        recursive: false,
        dryRun: false,
        archive: false,
        force: true,
      };

      const first = await service.consolidate(opts);
      expect(first.sources[0].memoriesImported).toBe(1);

      const second = await service.consolidate(opts);
      expect(second.sources[0].memoriesImported).toBe(0);
      expect(second.sources[0].memoriesSkipped).toBe(1);
    } finally {
      target.close();
    }
  });

  test("creates a backup of the global db before writing", async () => {
    const repo = makeRepoDb(tmpDir, "repo-backup");
    await repo.repository.insert(makeMemory("m1", "content"));
    repo.close();

    // Pre-existing global db
    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );
      const summary = await service.consolidate({
        root: repo.repoPath,
        recursive: false,
        dryRun: false,
        archive: false,
        force: true,
      });

      expect(summary.backupPath).not.toBeNull();
      expect(existsSync(summary.backupPath!)).toBe(true);
    } finally {
      target.close();
    }
  });

  test("archive renames the source .vector-memory directory", async () => {
    const repo = makeRepoDb(tmpDir, "repo-archive");
    await repo.repository.insert(makeMemory("m1", "content"));
    repo.close();

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );
      await service.consolidate({
        root: repo.repoPath,
        recursive: false,
        dryRun: false,
        archive: true,
        force: true,
      });

      expect(existsSync(join(repo.repoPath, ".vector-memory"))).toBe(false);
      expect(
        existsSync(join(repo.repoPath, ".vector-memory.migrated", "memories.db")),
      ).toBe(true);
    } finally {
      target.close();
    }
  });

  test("imports conversation history with canonical project stamping", async () => {
    const repo = makeRepoDb(tmpDir, "repo-conv");
    const sourceDb = connectToDatabase(repo.dbPath);
    sourceDb
      .prepare(
        `INSERT INTO conversation_history (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("c1", "chunk content", "{}", 1, "sess-1", "user", 0, 0, "repo/conv");
    sourceDb.close();
    repo.close();

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );
      const summary = await service.consolidate({
        root: repo.repoPath,
        recursive: false,
        dryRun: false,
        archive: false,
        force: true,
      });

      expect(summary.sources[0].conversationsImported).toBe(1);
      const row = target
        .prepare("SELECT project FROM conversation_history WHERE id = 'c1'")
        .get() as { project: string };
      expect(row.project).toBe(normalizeProject(repo.repoPath));
    } finally {
      target.close();
    }
  });

  test("re-embeds memories when the source vec table is unreadable", async () => {
    const repo = makeRepoDb(tmpDir, "repo-novec");
    await repo.repository.insert(makeMemory("m1", "vectorless memory"));
    repo.close();

    // Simulate a legacy vec0-era source: the vector table can't be read
    const sourceDb = connectToDatabase(repo.dbPath);
    sourceDb.exec("DROP TABLE memories_vec");
    sourceDb.close();

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );
      const summary = await service.consolidate({
        root: repo.repoPath,
        recursive: false,
        dryRun: false,
        archive: false,
        force: true,
      });

      expect(summary.sources[0].errors).toEqual([]);
      expect(summary.sources[0].memoriesImported).toBe(1);
      const vec = target
        .prepare("SELECT length(vector) AS len FROM memories_vec WHERE id = 'm1'")
        .get() as { len: number };
      expect(vec.len).toBe(EMBEDDING_DIM * 4);
    } finally {
      target.close();
    }
  });

  test("skips an empty directory at the db path without error", async () => {
    const dir = join(tmpDir, "repo-empty", ".vector-memory", "memories.db");
    mkdirSync(dir, { recursive: true });

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );
      const summary = await service.consolidate({
        root: join(tmpDir, "repo-empty"),
        recursive: false,
        dryRun: false,
        archive: false,
        force: true,
      });

      expect(summary.sources[0].errors).toEqual([]);
      expect(summary.sources[0].memoriesImported).toBe(0);
    } finally {
      target.close();
    }
  });

  test("reports an error for a non-LanceDB directory at the db path", async () => {
    const dir = join(tmpDir, "repo-junk", ".vector-memory", "memories.db");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "junk.txt"), "not a database");

    const target = connectToDatabase(globalDbPath);
    try {
      const service = new ConsolidationService(
        target,
        globalDbPath,
        createMockEmbeddings(),
      );
      const summary = await service.consolidate({
        root: join(tmpDir, "repo-junk"),
        recursive: false,
        dryRun: false,
        archive: false,
        force: true,
      });

      expect(summary.sources[0].errors).toHaveLength(1);
      expect(summary.sources[0].errors[0]).toContain("not a LanceDB store");
    } finally {
      target.close();
    }
  });
});
