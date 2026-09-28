import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { EmbeddingsService } from "./embeddings.service";
import { normalizeProject } from "./project";
import { safeParseJsonObject, serializeVector } from "./sqlite-utils";

const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

export interface ConsolidationOptions {
  /** Directory to scan for a .vector-memory/memories.db (default: cwd). */
  root: string;
  /** Walk the tree under root and consolidate every repo-local db found. */
  recursive: boolean;
  /** Plan everything (including re-keys) but write nothing. */
  dryRun: boolean;
  /** Rename .vector-memory/ to .vector-memory.migrated/ after success. */
  archive: boolean;
  /** Proceed even if live servers appear to be using the databases. */
  force: boolean;
}

export interface SourceReport {
  sourceDb: string;
  project: string;
  memoriesImported: number;
  memoriesSkipped: number;
  memoriesRekeyed: number;
  conversationsImported: number;
  conversationsSkipped: number;
  indexStateImported: number;
  rekeyMap: Record<string, string>;
  unresolvedReferences: string[];
  errors: string[];
}

export interface ConsolidationSummary {
  targetDb: string;
  backupPath: string | null;
  importBatch: string;
  dryRun: boolean;
  sources: SourceReport[];
}

interface SourceMemoryRow {
  id: string;
  content: string;
  metadata: string;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  usefulness: number;
  access_count: number;
  last_accessed: number | null;
  vector: Buffer | null;
}

interface SourceConversationRow {
  id: string;
  content: string;
  metadata: string;
  created_at: number;
  session_id: string;
  role: string;
  message_index_start: number;
  message_index_end: number;
  project: string;
  vector: Buffer | null;
}

/**
 * LanceDB-era repo stores used `.vector-memory/memories.db` as a *directory*.
 * Extraction shells out because @lancedb/lancedb's native bindings cannot
 * coexist with bun:sqlite in one process.
 */
function isLanceDir(entries: string[]): boolean {
  return entries.some(
    (e) => e.endsWith(".lance") || e === "_versions" || e === "_indices",
  );
}

async function extractLanceData(path: string): Promise<{
  memories: Array<Omit<SourceMemoryRow, "vector"> & { vector: number[] }>;
  conversations: Array<
    Omit<SourceConversationRow, "vector"> & { vector: number[] }
  >;
}> {
  const script = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "scripts",
    "lancedb-extract.ts",
  );
  if (!existsSync(script)) {
    throw new Error(`LanceDB extract script not found at ${script}`);
  }
  const proc = Bun.spawn([process.execPath, script, path], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`LanceDB extraction failed (exit code ${exitCode})`);
  }
  return JSON.parse(output);
}

/**
 * Old schema versions stored vectors in vec0 virtual tables, which need the
 * sqlite-vec extension to query. Sources are opened read-only without it, so
 * treat those vectors as unreadable — rows are re-embedded on import.
 */
function vecTableReadable(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(name) as { sql: string | null } | null;
  return row != null && !(row.sql ?? "").includes("vec0");
}

/** Mirrors MemoryService.waypointId — must stay byte-identical. */
function waypointIdFor(project: string): string {
  const normalized = project.trim().toLowerCase();
  const hex = createHash("sha256")
    .update(`waypoint:${normalized}`)
    .digest("hex");
  return `wp:${hex.slice(0, 32)}`;
}

function isWaypointRow(row: SourceMemoryRow): boolean {
  if (row.id === UUID_ZERO || row.id.startsWith("wp:")) return true;
  const metadata = safeParseJsonObject(row.metadata);
  return metadata.type === "waypoint";
}

/** Find repo-local databases: <repo>/.vector-memory/memories.db */
export function discoverSourceDbs(root: string, recursive: boolean): string[] {
  const found: string[] = [];
  const direct = join(root, ".vector-memory", "memories.db");
  if (existsSync(direct)) found.push(direct);
  if (!recursive) return found;

  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".vector-memory",
    ".vector-memory.migrated",
    ".cache",
  ]);

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".vector-memory") continue;
      const sub = join(dir, entry.name);
      const candidate = join(sub, ".vector-memory", "memories.db");
      if (existsSync(candidate)) found.push(candidate);
      walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Lock files (global + per-repo) whose recorded pid is still alive. */
export function findLiveServerLocks(sourceDirs: string[]): string[] {
  const lockPaths: string[] = [];
  const globalLocksDir = join(homedir(), ".vector-memory", "locks");
  try {
    for (const name of readdirSync(globalLocksDir)) {
      if (name.endsWith(".lock")) lockPaths.push(join(globalLocksDir, name));
    }
  } catch {
    // no locks dir — fine
  }
  for (const dir of sourceDirs) {
    lockPaths.push(join(dir, "server.lock"));
  }

  const live: string[] = [];
  for (const path of lockPaths) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
      if (typeof raw.pid !== "number") continue;
      process.kill(raw.pid, 0);
      live.push(path);
    } catch {
      // missing, unreadable, or dead pid — not live
    }
  }
  return live;
}

export class ConsolidationService {
  constructor(
    private target: Database,
    private targetDbPath: string,
    private embeddings: EmbeddingsService,
  ) {}

  async consolidate(options: ConsolidationOptions): Promise<ConsolidationSummary> {
    const sources = discoverSourceDbs(options.root, options.recursive);
    const importBatch = randomUUID();

    const summary: ConsolidationSummary = {
      targetDb: this.targetDbPath,
      backupPath: null,
      importBatch,
      dryRun: options.dryRun,
      sources: [],
    };

    if (sources.length === 0) return summary;

    // Refuse to run against live servers unless forced — a live server's
    // waypoint write racing the import could be clobbered.
    if (!options.force) {
      const live = findLiveServerLocks(sources.map((s) => dirname(s)));
      if (live.length > 0) {
        throw new Error(
          `Live vector-memory servers detected (${live.join(", ")}). ` +
            `Close those sessions first, or re-run with --force.`,
        );
      }
    }

    // Backup the global db before the first write
    if (!options.dryRun && existsSync(this.targetDbPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      summary.backupPath = `${this.targetDbPath}.pre-consolidate-${stamp}`;
      copyFileSync(this.targetDbPath, summary.backupPath);
    }

    for (const sourceDb of sources) {
      const report = await this.consolidateOne(sourceDb, importBatch, options);
      summary.sources.push(report);

      if (!options.dryRun && options.archive && report.errors.length === 0) {
        const dir = dirname(sourceDb);
        try {
          renameDirReleasing(dir, `${dir}.migrated`);
        } catch (e) {
          report.errors.push(
            `archive failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    return summary;
  }

  private async consolidateOne(
    sourceDbPath: string,
    importBatch: string,
    options: ConsolidationOptions,
  ): Promise<SourceReport> {
    // <repo>/.vector-memory/memories.db → project = <repo>
    const project = normalizeProject(dirname(dirname(sourceDbPath)));

    const report: SourceReport = {
      sourceDb: sourceDbPath,
      project,
      memoriesImported: 0,
      memoriesSkipped: 0,
      memoriesRekeyed: 0,
      conversationsImported: 0,
      conversationsSkipped: 0,
      indexStateImported: 0,
      rekeyMap: {},
      unresolvedReferences: [],
      errors: [],
    };

    // LanceDB-era stores are directories, not SQLite files
    if (statSync(sourceDbPath).isDirectory()) {
      await this.consolidateLanceSource(
        sourceDbPath,
        project,
        importBatch,
        options,
        report,
      );
      return report;
    }

    let source: Database;
    try {
      source = new Database(sourceDbPath, { readonly: true });
    } catch (e) {
      report.errors.push(
        `cannot open source: ${e instanceof Error ? e.message : String(e)}`,
      );
      return report;
    }

    try {
      await this.importMemories(source, project, importBatch, options, report);
      this.importConversations(source, project, importBatch, options, report);
      await this.importIndexState(source, sourceDbPath, project, options, report);
    } catch (e) {
      report.errors.push(e instanceof Error ? e.message : String(e));
    } finally {
      source.close();
    }

    return report;
  }

  private async consolidateLanceSource(
    sourceDbPath: string,
    project: string,
    importBatch: string,
    options: ConsolidationOptions,
    report: SourceReport,
  ): Promise<void> {
    const entries = readdirSync(sourceDbPath);
    if (entries.length === 0) return; // failed init left an empty dir — nothing to import
    if (!isLanceDir(entries)) {
      report.errors.push(
        `source is a directory but not a LanceDB store: ${sourceDbPath}`,
      );
      return;
    }

    let data: Awaited<ReturnType<typeof extractLanceData>>;
    try {
      data = await extractLanceData(sourceDbPath);
    } catch (e) {
      report.errors.push(
        `LanceDB extraction failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    const expectedBytes = this.embeddings.dimension * 4;
    const toBuffer = (vector: number[]): Buffer | null => {
      const buf = vector.length > 0 ? serializeVector(vector) : null;
      // Wrong-dimension vectors (model change) are dropped → re-embedded
      return buf && buf.byteLength === expectedBytes ? buf : null;
    };

    const memoryRows: SourceMemoryRow[] = data.memories.map((m) => ({
      ...m,
      vector: toBuffer(m.vector),
    }));
    const conversationRows: SourceConversationRow[] = data.conversations.map(
      (c) => ({ ...c, vector: toBuffer(c.vector) }),
    );

    try {
      await this.processMemoryRows(
        memoryRows,
        project,
        importBatch,
        options,
        report,
      );
      this.processConversationRows(
        conversationRows,
        project,
        importBatch,
        options,
        report,
      );
      await this.importIndexState(null, sourceDbPath, project, options, report);
    } catch (e) {
      report.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Memories ────────────────────────────────────────────────────────

  private async importMemories(
    source: Database,
    project: string,
    importBatch: string,
    options: ConsolidationOptions,
    report: SourceReport,
  ): Promise<void> {
    if (!tableExists(source, "memories")) return;

    const rows = (
      vecTableReadable(source, "memories_vec")
        ? source.prepare(
            `SELECT m.*, v.vector FROM memories m
             LEFT JOIN memories_vec v ON m.id = v.id`,
          )
        : source.prepare("SELECT m.*, NULL AS vector FROM memories m")
    ).all() as SourceMemoryRow[];

    await this.processMemoryRows(rows, project, importBatch, options, report);
  }

  private async processMemoryRows(
    rows: SourceMemoryRow[],
    project: string,
    importBatch: string,
    options: ConsolidationOptions,
    report: SourceReport,
  ): Promise<void> {
    if (rows.length === 0) return;

    const targetGet = this.target.prepare(
      "SELECT content FROM memories WHERE id = ?",
    );

    // Plan re-keys first so references can be remapped before any insert.
    // Waypoints collapse to the canonical per-project ID (newest wins);
    // other ID collisions with different content get fresh UUIDs.
    const canonicalWaypointId = waypointIdFor(project);
    const waypoints = rows
      .filter(isWaypointRow)
      .sort((a, b) => b.updated_at - a.updated_at);
    const sourceIds = new Set(rows.map((r) => r.id));
    const toImport: SourceMemoryRow[] = [];

    for (const row of rows) {
      if (isWaypointRow(row)) {
        if (row !== waypoints[0]) {
          report.memoriesSkipped++; // older duplicate waypoint copies
          continue;
        }
        if (row.id !== canonicalWaypointId) {
          report.rekeyMap[row.id] = canonicalWaypointId;
          report.memoriesRekeyed++;
        }
        toImport.push(row);
        continue;
      }

      const existing = targetGet.get(row.id) as { content: string } | null;
      if (existing) {
        if (existing.content === row.content) {
          report.memoriesSkipped++;
          continue;
        }
        const fresh = randomUUID();
        report.rekeyMap[row.id] = fresh;
        report.memoriesRekeyed++;
      }
      toImport.push(row);
    }

    // The target waypoint may also already exist — keep whichever is newer.
    const existingWaypoint = this.target
      .prepare("SELECT updated_at FROM memories WHERE id = ?")
      .get(canonicalWaypointId) as { updated_at: number } | null;
    if (existingWaypoint && waypoints[0]) {
      const idx = toImport.indexOf(waypoints[0]);
      if (idx !== -1 && existingWaypoint.updated_at >= waypoints[0].updated_at) {
        // Target's waypoint is newer — drop the source copy. The rekeyMap
        // entry stays: references remap to the surviving target waypoint.
        toImport.splice(idx, 1);
        report.memoriesSkipped++;
      }
    }

    if (options.dryRun) {
      report.memoriesImported = toImport.length;
      this.collectUnresolved(rows, sourceIds, report);
      return;
    }

    // Pre-compute embeddings for rows whose vectors are missing or have the
    // wrong dimension (model change) — outside any transaction.
    const expectedBytes = this.embeddings.dimension * 4;
    const reEmbedded = new Map<string, number[]>();
    for (const row of toImport) {
      if (isWaypointRow(row)) continue; // waypoints keep zero vectors
      if (row.vector && row.vector.byteLength === expectedBytes) continue;
      reEmbedded.set(row.id, await this.embeddings.embed(row.content));
    }
    const zeroVector = serializeVector(
      new Array(this.embeddings.dimension).fill(0),
    );

    const insertMain = this.target.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at, superseded_by, usefulness, access_count, last_accessed, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const replaceMain = this.target.prepare(
      `INSERT OR REPLACE INTO memories (id, content, metadata, created_at, updated_at, superseded_by, usefulness, access_count, last_accessed, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteVec = this.target.prepare(
      "DELETE FROM memories_vec WHERE id = ?",
    );
    const insertVec = this.target.prepare(
      "INSERT OR REPLACE INTO memories_vec (id, vector) VALUES (?, ?)",
    );
    const deleteFts = this.target.prepare(
      "DELETE FROM memories_fts WHERE id = ?",
    );
    const insertFts = this.target.prepare(
      "INSERT INTO memories_fts (id, content) VALUES (?, ?)",
    );
    const existsStmt = this.target.prepare(
      "SELECT 1 FROM memories WHERE id = ?",
    );

    const rekey = (id: string | null): string | null =>
      id === null ? null : (report.rekeyMap[id] ?? id);

    const tx = this.target.transaction(() => {
      for (const row of toImport) {
        const newId = rekey(row.id)!;
        const isWaypoint = isWaypointRow(row);

        // Remap references in metadata and rendered content
        const metadata = safeParseJsonObject(row.metadata);
        let content = row.content;
        for (const field of ["memory_ids", "related_memory_ids"]) {
          const value = metadata[field];
          if (Array.isArray(value)) {
            metadata[field] = value.map((v) =>
              typeof v === "string" ? rekey(v) : v,
            );
          }
        }
        for (const [oldId, mapped] of Object.entries(report.rekeyMap)) {
          if (oldId !== newId) content = content.replaceAll(oldId, mapped);
        }

        const originalProject = metadata.project;
        if (
          typeof originalProject === "string" &&
          originalProject.length > 0 &&
          normalizeProject(originalProject) !== project
        ) {
          metadata.original_project = originalProject;
        }
        metadata.project = project;
        metadata.import_batch = importBatch;
        if (newId !== row.id) metadata.original_id = row.id;

        // Re-check existence inside the transaction (no TOCTOU against a
        // live writer). Waypoints may replace the canonical row (newest-wins
        // was decided above); everything else never overwrites.
        const exists = existsStmt.get(newId) != null;
        if (exists && !isWaypoint) {
          report.memoriesSkipped++;
          continue;
        }

        const vector = isWaypoint
          ? zeroVector
          : reEmbedded.has(row.id)
            ? serializeVector(reEmbedded.get(row.id)!)
            : row.vector!;

        (exists ? replaceMain : insertMain).run(
          newId,
          content,
          JSON.stringify(metadata),
          row.created_at,
          row.updated_at,
          rekey(row.superseded_by),
          row.usefulness,
          row.access_count,
          row.last_accessed,
          project,
        );
        deleteVec.run(newId);
        insertVec.run(newId, vector);
        deleteFts.run(newId);
        insertFts.run(newId, content);
        report.memoriesImported++;
      }
    });
    tx();

    this.collectUnresolved(rows, sourceIds, report);
  }

  /** Report references that point at IDs in neither the source nor target. */
  private collectUnresolved(
    rows: SourceMemoryRow[],
    sourceIds: Set<string>,
    report: SourceReport,
  ): void {
    const targetHas = this.target.prepare("SELECT 1 FROM memories WHERE id = ?");
    for (const row of rows) {
      const metadata = safeParseJsonObject(row.metadata);
      const refs = [
        ...(Array.isArray(metadata.memory_ids) ? metadata.memory_ids : []),
        ...(Array.isArray(metadata.related_memory_ids)
          ? metadata.related_memory_ids
          : []),
        ...(row.superseded_by && row.superseded_by !== "DELETED"
          ? [row.superseded_by]
          : []),
      ].filter((r): r is string => typeof r === "string");

      for (const ref of refs) {
        const mapped = report.rekeyMap[ref] ?? ref;
        if (sourceIds.has(ref)) continue;
        if (targetHas.get(mapped) != null) continue;
        report.unresolvedReferences.push(`${row.id} -> ${ref}`);
      }
    }
  }

  // ── Conversation history ────────────────────────────────────────────

  private importConversations(
    source: Database,
    project: string,
    importBatch: string,
    options: ConsolidationOptions,
    report: SourceReport,
  ): void {
    if (!tableExists(source, "conversation_history")) return;

    const rows = (
      vecTableReadable(source, "conversation_history_vec")
        ? source.prepare(
            `SELECT c.*, v.vector FROM conversation_history c
             LEFT JOIN conversation_history_vec v ON c.id = v.id`,
          )
        : source.prepare(
            "SELECT c.*, NULL AS vector FROM conversation_history c",
          )
    ).all() as SourceConversationRow[];

    this.processConversationRows(rows, project, importBatch, options, report);
  }

  private processConversationRows(
    rows: SourceConversationRow[],
    project: string,
    importBatch: string,
    options: ConsolidationOptions,
    report: SourceReport,
  ): void {
    if (rows.length === 0) return;

    const existsStmt = this.target.prepare(
      "SELECT 1 FROM conversation_history WHERE id = ?",
    );

    if (options.dryRun) {
      for (const row of rows) {
        if (existsStmt.get(row.id) != null) report.conversationsSkipped++;
        else report.conversationsImported++;
      }
      return;
    }

    const insertMain = this.target.prepare(
      `INSERT INTO conversation_history
        (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVec = this.target.prepare(
      "INSERT OR REPLACE INTO conversation_history_vec (id, vector) VALUES (?, ?)",
    );
    const insertFts = this.target.prepare(
      "INSERT INTO conversation_history_fts (id, content) VALUES (?, ?)",
    );

    const tx = this.target.transaction(() => {
      for (const row of rows) {
        if (existsStmt.get(row.id) != null) {
          report.conversationsSkipped++;
          continue;
        }
        // Sessions in a repo-local db were indexed from that repo — stamp
        // the canonical project unless the row already carries one.
        const rowProject = row.project.startsWith("/") ? row.project : project;
        const metadata = safeParseJsonObject(row.metadata);
        metadata.project = rowProject;
        metadata.import_batch = importBatch;

        insertMain.run(
          row.id,
          row.content,
          JSON.stringify(metadata),
          row.created_at,
          row.session_id,
          row.role,
          row.message_index_start,
          row.message_index_end,
          rowProject,
        );
        if (row.vector) insertVec.run(row.id, row.vector);
        insertFts.run(row.id, row.content);
        report.conversationsImported++;
      }
    });
    tx();
  }

  // ── Conversation index state ────────────────────────────────────────

  private async importIndexState(
    source: Database | null,
    sourceDbPath: string,
    project: string,
    options: ConsolidationOptions,
    report: SourceReport,
  ): Promise<void> {
    type StateRow = {
      session_id: string;
      file_path: string;
      project: string;
      last_modified: number;
      chunk_count: number;
      message_count: number;
      indexed_at: number;
      first_message_at: number;
      last_message_at: number;
    };

    const entries: StateRow[] = [];
    if (source && tableExists(source, "conversation_index_state")) {
      entries.push(
        ...(source
          .prepare("SELECT * FROM conversation_index_state")
          .all() as StateRow[]),
      );
    }

    // Legacy JSON state next to the source db
    try {
      const raw = await readFile(
        join(dirname(sourceDbPath), "conversation_index_state.json"),
        "utf-8",
      );
      const legacy = JSON.parse(raw) as Array<{
        sessionId: string;
        filePath: string;
        project: string;
        lastModified: number;
        chunkCount: number;
        messageCount: number;
        indexedAt: string;
        firstMessageAt: string;
        lastMessageAt: string;
      }>;
      const seen = new Set(entries.map((e) => e.session_id));
      for (const e of legacy) {
        if (seen.has(e.sessionId)) continue;
        entries.push({
          session_id: e.sessionId,
          file_path: e.filePath,
          project: e.project,
          last_modified: e.lastModified,
          chunk_count: e.chunkCount,
          message_count: e.messageCount,
          indexed_at: new Date(e.indexedAt).getTime(),
          first_message_at: new Date(e.firstMessageAt).getTime(),
          last_message_at: new Date(e.lastMessageAt).getTime(),
        });
      }
    } catch {
      // no legacy file — fine
    }

    if (entries.length === 0 || options.dryRun) {
      if (options.dryRun) report.indexStateImported = entries.length;
      return;
    }

    const insert = this.target.prepare(
      `INSERT OR IGNORE INTO conversation_index_state
        (session_id, file_path, project, last_modified, chunk_count, message_count, indexed_at, first_message_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.target.transaction(() => {
      for (const e of entries) {
        const result = insert.run(
          e.session_id,
          e.file_path,
          e.project.startsWith("/") ? e.project : project,
          e.last_modified,
          e.chunk_count,
          e.message_count,
          e.indexed_at,
          e.first_message_at,
          e.last_message_at,
        );
        if (result.changes > 0) report.indexStateImported++;
      }
    });
    tx();
  }
}

/**
 * Rename a directory, tolerating Windows' delayed file-handle release.
 *
 * bun:sqlite does not finalize prepared-statement handles on `Database.close()`
 * — they linger until GC. On Windows those handles keep the source db file
 * locked, so renaming the enclosing `.vector-memory/` directory throws
 * EBUSY/EPERM even though every connection was already closed. Forcing a GC
 * pass releases them; retry with backoff as a fallback if release is delayed.
 * A no-op cost on POSIX, where the first rename succeeds immediately.
 */
function renameDirReleasing(from: string, to: string, maxAttempts = 10): void {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt === maxAttempts) {
        throw e;
      }
      if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
        Bun.gc(true);
      }
      Bun.sleepSync(50 * attempt);
    }
  }
}

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) != null
  );
}
