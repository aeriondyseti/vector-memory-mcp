import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, statSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { serializeVector } from "./sqlite-utils.js";
import type { MemoryRepository } from "./memory.repository.js";
import type { EmbeddingsService } from "./embeddings.service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BATCH_SIZE = 100;

// ── Types ────────────────────────────────────────────────────────────

export interface NormalizedMemory {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  supersededBy: string | null;
  usefulness: number;
  accessCount: number;
  lastAccessed: number | null;
}

export interface NormalizedConversation {
  id: string;
  content: string;
  metadata: string;
  createdAt: number;
  sessionId: string;
  role: string;
  messageIndexStart: number;
  messageIndexEnd: number;
  project: string;
}

export interface MigrationSummary {
  source: string;
  format: string;
  memoriesImported: number;
  memoriesSkipped: number;
  conversationsImported: number;
  conversationsSkipped: number;
  errors: string[];
  durationMs: number;
}

type SourceFormat =
  | { type: "lancedb"; path: string }
  | { type: "own-sqlite"; path: string }
  | { type: "cccmemory"; path: string }
  | { type: "mcp-memory-service"; path: string }
  | { type: "mif-json"; path: string };

// ── Service ──────────────────────────────────────────────────────────

export class MigrationService {
  constructor(
    private repository: MemoryRepository,
    private embeddings: EmbeddingsService,
    private db: Database,
  ) {}

  async migrate(sourcePath: string): Promise<MigrationSummary> {
    const start = Date.now();
    const summary: MigrationSummary = {
      source: sourcePath,
      format: "unknown",
      memoriesImported: 0,
      memoriesSkipped: 0,
      conversationsImported: 0,
      conversationsSkipped: 0,
      errors: [],
      durationMs: 0,
    };

    const format = this.detectFormat(sourcePath);
    summary.format = format.type;

    let memories: NormalizedMemory[] = [];
    let conversations: NormalizedConversation[] = [];

    switch (format.type) {
      case "lancedb": {
        const data = await this.extractFromLanceDb(format.path);
        memories = data.memories;
        conversations = data.conversations;
        break;
      }
      case "own-sqlite": {
        const data = this.extractFromOwnSqlite(format.path);
        memories = data.memories;
        conversations = data.conversations;
        break;
      }
      case "cccmemory": {
        memories = this.extractFromCccMemory(format.path);
        break;
      }
      case "mcp-memory-service": {
        memories = this.extractFromMcpMemoryService(format.path);
        break;
      }
      case "mif-json": {
        memories = await this.extractFromMif(format.path);
        break;
      }
    }

    await this.importMemories(memories, summary);
    await this.importConversations(conversations, summary);

    summary.durationMs = Date.now() - start;
    return summary;
  }

  // ── Format Detection ─────────────────────────────────────────────

  private detectFormat(sourcePath: string): SourceFormat {
    if (!existsSync(sourcePath)) {
      throw new Error(`Source not found: ${sourcePath}`);
    }

    const stat = statSync(sourcePath);

    if (stat.isDirectory()) {
      const entries = readdirSync(sourcePath);
      const hasLance = entries.some(
        (e) => e.endsWith(".lance") || e === "_versions" || e === "_indices",
      );
      if (hasLance) {
        return { type: "lancedb", path: sourcePath };
      }
      throw new Error(
        `Unrecognized directory format at ${sourcePath}. Expected a LanceDB directory.`,
      );
    }

    if (sourcePath.endsWith(".json")) {
      return { type: "mif-json", path: sourcePath };
    }

    // Assume SQLite file — probe schema
    return this.detectSqliteFormat(sourcePath);
  }

  private detectSqliteFormat(sourcePath: string): SourceFormat {
    let sourceDb: Database | null = null;
    try {
      sourceDb = new Database(sourcePath, { readonly: true });
      const tables = this.getTableNames(sourceDb);

      if (tables.includes("memories")) {
        const columns = this.getColumnNames(sourceDb, "memories");
        if (columns.includes("usefulness")) {
          return { type: "own-sqlite", path: sourcePath };
        }
        if (columns.includes("content_hash")) {
          return { type: "mcp-memory-service", path: sourcePath };
        }
        // Fallback: any memories table we'll try as own-sqlite
        return { type: "own-sqlite", path: sourcePath };
      }

      if (
        tables.includes("decisions") &&
        tables.includes("mistakes") &&
        tables.includes("working_memory")
      ) {
        return { type: "cccmemory", path: sourcePath };
      }

      throw new Error(
        `Unrecognized SQLite schema at ${sourcePath}. Found tables: ${tables.join(", ")}`,
      );
    } finally {
      sourceDb?.close();
    }
  }

  private getTableNames(db: Database): string[] {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  private getColumnNames(db: Database, table: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return rows.map((r) => r.name);
  }

  // ── LanceDB Extraction ───────────────────────────────────────────

  private async extractFromLanceDb(
    path: string,
  ): Promise<{
    memories: NormalizedMemory[];
    conversations: NormalizedConversation[];
  }> {
    const extractScript = resolve(
      __dirname,
      "..",
      "..",
      "scripts",
      "lancedb-extract.ts",
    );
    const proc = Bun.spawn(["bun", extractScript, path], {
      stdout: "pipe",
      stderr: "inherit",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`LanceDB extraction failed (exit code ${exitCode})`);
    }

    const data = JSON.parse(output) as {
      memories: Array<{
        id: string;
        content: string;
        metadata: string;
        created_at: number;
        updated_at: number;
        last_accessed: number | null;
        superseded_by: string | null;
        usefulness: number;
        access_count: number;
      }>;
      conversations: Array<{
        id: string;
        content: string;
        metadata: string;
        created_at: number;
        session_id: string;
        role: string;
        message_index_start: number;
        message_index_end: number;
        project: string;
      }>;
    };

    const memories: NormalizedMemory[] = data.memories.map((row) => ({
      id: row.id,
      content: row.content,
      metadata: this.safeParseJson(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      supersededBy: row.superseded_by,
      usefulness: row.usefulness ?? 0,
      accessCount: row.access_count ?? 0,
      lastAccessed: row.last_accessed,
    }));

    const conversations: NormalizedConversation[] = data.conversations.map(
      (row) => ({
        id: row.id,
        content: row.content,
        metadata: row.metadata ?? "{}",
        createdAt: row.created_at,
        sessionId: row.session_id,
        role: row.role,
        messageIndexStart: row.message_index_start ?? 0,
        messageIndexEnd: row.message_index_end ?? 0,
        project: row.project ?? "",
      }),
    );

    return { memories, conversations };
  }

  // ── Own SQLite Extraction ────────────────────────────────────────

  private extractFromOwnSqlite(path: string): {
    memories: NormalizedMemory[];
    conversations: NormalizedConversation[];
  } {
    const sourceDb = new Database(path, { readonly: true });
    try {
      const memories = this.extractOwnMemories(sourceDb);
      const conversations = this.extractOwnConversations(sourceDb);
      return { memories, conversations };
    } finally {
      sourceDb.close();
    }
  }

  private extractOwnMemories(sourceDb: Database): NormalizedMemory[] {
    const columns = this.getColumnNames(sourceDb, "memories");
    const hasUsefulness = columns.includes("usefulness");
    const hasAccessCount = columns.includes("access_count");
    const hasLastAccessed = columns.includes("last_accessed");

    const rows = sourceDb
      .prepare("SELECT * FROM memories")
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      metadata: this.safeParseJson(row.metadata as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      supersededBy: (row.superseded_by as string) ?? null,
      usefulness: hasUsefulness ? ((row.usefulness as number) ?? 0) : 0,
      accessCount: hasAccessCount ? ((row.access_count as number) ?? 0) : 0,
      lastAccessed: hasLastAccessed
        ? ((row.last_accessed as number) ?? null)
        : null,
    }));
  }

  private extractOwnConversations(
    sourceDb: Database,
  ): NormalizedConversation[] {
    const tables = this.getTableNames(sourceDb);
    if (!tables.includes("conversation_history")) return [];

    const rows = sourceDb
      .prepare("SELECT * FROM conversation_history")
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      metadata: (row.metadata as string) ?? "{}",
      createdAt: row.created_at as number,
      sessionId: (row.session_id as string) ?? "",
      role: (row.role as string) ?? "unknown",
      messageIndexStart: (row.message_index_start as number) ?? 0,
      messageIndexEnd: (row.message_index_end as number) ?? 0,
      project: (row.project as string) ?? "",
    }));
  }

  // ── CCCMemory Extraction ─────────────────────────────────────────

  private extractFromCccMemory(path: string): NormalizedMemory[] {
    const sourceDb = new Database(path, { readonly: true });
    try {
      const tables = this.getTableNames(sourceDb);
      const memories: NormalizedMemory[] = [];

      if (tables.includes("decisions")) {
        memories.push(...this.extractCccDecisions(sourceDb));
      }
      if (tables.includes("mistakes")) {
        memories.push(...this.extractCccMistakes(sourceDb));
      }
      if (tables.includes("methodologies")) {
        memories.push(...this.extractCccMethodologies(sourceDb));
      }
      if (tables.includes("research_findings")) {
        memories.push(...this.extractCccResearch(sourceDb));
      }
      if (tables.includes("solution_patterns")) {
        memories.push(...this.extractCccPatterns(sourceDb));
      }
      if (tables.includes("working_memory")) {
        memories.push(...this.extractCccWorkingMemory(sourceDb));
      }

      return memories;
    } finally {
      sourceDb.close();
    }
  }

  private cccId(table: string, id: string | number): string {
    const hex = createHash("sha256")
      .update(`cccmemory:${table}:${id}`)
      .digest("hex");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  private extractCccDecisions(sourceDb: Database): NormalizedMemory[] {
    const rows = sourceDb.prepare("SELECT * FROM decisions").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => {
      const ts = (row.timestamp as number) ?? Date.now();
      return {
        id: this.cccId("decisions", row.id as number),
        content: `Decision: ${row.decision_text as string}${row.rationale ? `\nRationale: ${row.rationale}` : ""}`,
        metadata: {
          source_type: "cccmemory",
          memory_type: "decision",
          rationale: row.rationale ?? null,
          alternatives_considered: row.alternatives_considered ?? null,
          rejected_reasons: row.rejected_reasons ?? null,
          context: row.context ?? null,
          related_files: row.related_files ?? null,
        },
        createdAt: ts,
        updatedAt: ts,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: null,
      };
    });
  }

  private extractCccMistakes(sourceDb: Database): NormalizedMemory[] {
    const rows = sourceDb.prepare("SELECT * FROM mistakes").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => {
      const ts = (row.timestamp as number) ?? Date.now();
      return {
        id: this.cccId("mistakes", row.id as number),
        content: `Mistake (${row.mistake_type}): ${row.what_went_wrong as string}${row.correction ? `\nCorrection: ${row.correction}` : ""}`,
        metadata: {
          source_type: "cccmemory",
          memory_type: "mistake",
          mistake_type: row.mistake_type ?? null,
          correction: row.correction ?? null,
          user_correction_message: row.user_correction_message ?? null,
          files_affected: row.files_affected ?? null,
        },
        createdAt: ts,
        updatedAt: ts,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: null,
      };
    });
  }

  private extractCccMethodologies(sourceDb: Database): NormalizedMemory[] {
    const rows = sourceDb
      .prepare("SELECT * FROM methodologies")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const ts = (row.created_at as number) ?? Date.now();
      return {
        id: this.cccId("methodologies", row.id as string),
        content: `Problem: ${row.problem_statement}\nApproach: ${row.approach}\nOutcome: ${row.outcome}${row.what_worked ? `\nWhat worked: ${row.what_worked}` : ""}${row.what_didnt_work ? `\nWhat didn't work: ${row.what_didnt_work}` : ""}`,
        metadata: {
          source_type: "cccmemory",
          memory_type: "methodology",
          steps_taken: row.steps_taken ?? null,
          tools_used: row.tools_used ?? null,
          files_involved: row.files_involved ?? null,
        },
        createdAt: ts,
        updatedAt: ts,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: null,
      };
    });
  }

  private extractCccResearch(sourceDb: Database): NormalizedMemory[] {
    const rows = sourceDb
      .prepare("SELECT * FROM research_findings")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const ts = (row.created_at as number) ?? Date.now();
      return {
        id: this.cccId("research_findings", row.id as string),
        content: `Research - ${row.topic}: ${row.discovery}`,
        metadata: {
          source_type: "cccmemory",
          memory_type: "research",
          source_type_detail: row.source_type ?? null,
          source_reference: row.source_reference ?? null,
          relevance: row.relevance ?? null,
          confidence: row.confidence ?? null,
          related_to: row.related_to ?? null,
        },
        createdAt: ts,
        updatedAt: ts,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: null,
      };
    });
  }

  private extractCccPatterns(sourceDb: Database): NormalizedMemory[] {
    const rows = sourceDb
      .prepare("SELECT * FROM solution_patterns")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const ts = (row.created_at as number) ?? Date.now();
      return {
        id: this.cccId("solution_patterns", row.id as string),
        content: `Problem: ${row.problem_description}\nSolution: ${row.solution_summary}\nApplies when: ${row.applies_when}${row.avoid_when ? `\nAvoid when: ${row.avoid_when}` : ""}`,
        metadata: {
          source_type: "cccmemory",
          memory_type: "solution_pattern",
          problem_category: row.problem_category ?? null,
          solution_steps: row.solution_steps ?? null,
          code_pattern: row.code_pattern ?? null,
          technology: row.technology ?? null,
          prerequisites: row.prerequisites ?? null,
          effectiveness: row.effectiveness ?? null,
        },
        createdAt: ts,
        updatedAt: ts,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: null,
      };
    });
  }

  private extractCccWorkingMemory(sourceDb: Database): NormalizedMemory[] {
    const rows = sourceDb
      .prepare("SELECT * FROM working_memory")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const ts = (row.created_at as number) ?? Date.now();
      return {
        id: this.cccId("working_memory", row.id as string),
        content: `${row.key}: ${row.value}${row.context ? `\nContext: ${row.context}` : ""}`,
        metadata: {
          source_type: "cccmemory",
          memory_type: "working_memory",
          key: row.key ?? null,
          tags: row.tags ?? null,
          session_id: row.session_id ?? null,
          project_path: row.project_path ?? null,
        },
        createdAt: ts,
        updatedAt: (row.updated_at as number) ?? ts,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: null,
      };
    });
  }

  // ── MCP Memory Service Extraction ────────────────────────────────

  private extractFromMcpMemoryService(path: string): NormalizedMemory[] {
    const sourceDb = new Database(path, { readonly: true });
    try {
      const rows = sourceDb
        .prepare("SELECT * FROM memories WHERE deleted_at IS NULL")
        .all() as Array<Record<string, unknown>>;

      return rows.map((row) => {
        // created_at/updated_at are REAL (unix timestamp as float, seconds)
        const createdAt = row.created_at
          ? Math.floor((row.created_at as number) * 1000)
          : Date.now();
        const updatedAt = row.updated_at
          ? Math.floor((row.updated_at as number) * 1000)
          : createdAt;

        let tags: string[] = [];
        if (row.tags) {
          try {
            tags = JSON.parse(row.tags as string);
          } catch {
            tags = (row.tags as string)
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
          }
        }

        return {
          id: this.cccId("mcp-memory-service", row.content_hash as string),
          content: row.content as string,
          metadata: {
            source_type: "mcp-memory-service",
            memory_type: row.memory_type ?? null,
            tags,
            content_hash: row.content_hash ?? null,
            ...this.safeParseJson((row.metadata as string) ?? "{}"),
          },
          createdAt,
          updatedAt,
          supersededBy: null,
          usefulness: 0,
          accessCount: 0,
          lastAccessed: null,
        };
      });
    } finally {
      sourceDb.close();
    }
  }

  // ── MIF JSON Extraction ──────────────────────────────────────────

  private async extractFromMif(path: string): Promise<NormalizedMemory[]> {
    const file = Bun.file(path);
    const data = (await file.json()) as {
      memories?: Array<{
        id?: string;
        content?: string;
        memory_type?: string;
        created_at?: string;
        tags?: string[];
        entities?: Array<{
          name: string;
          entity_type: string;
          confidence: number;
        }>;
        metadata?: Record<string, string>;
        source?: {
          source_type?: string;
          session_id?: string;
          agent?: string;
        };
        parent_id?: string;
        related_memory_ids?: string[];
      }>;
    };

    if (!data.memories || !Array.isArray(data.memories)) {
      throw new Error("MIF JSON file has no 'memories' array");
    }

    return data.memories
      .filter((m) => m.content)
      .map((m) => {
        const createdAt = m.created_at
          ? new Date(m.created_at).getTime()
          : Date.now();

        return {
          id: m.id ?? this.cccId("mif", m.content!),
          content: m.content!,
          metadata: {
            source_type: "mif",
            memory_type: m.memory_type ?? null,
            tags: m.tags ?? [],
            entities: m.entities ?? [],
            source: m.source ?? null,
            parent_id: m.parent_id ?? null,
            related_memory_ids: m.related_memory_ids ?? [],
            ...(m.metadata ?? {}),
          },
          createdAt,
          updatedAt: createdAt,
          supersededBy: null,
          usefulness: 0,
          accessCount: 0,
          lastAccessed: null,
        };
      });
  }

  // ── Import Logic ─────────────────────────────────────────────────

  private async importMemories(
    memories: NormalizedMemory[],
    summary: MigrationSummary,
  ): Promise<void> {
    if (memories.length === 0) return;

    const insertMain = this.db.prepare(
      `INSERT OR REPLACE INTO memories
        (id, content, metadata, created_at, updated_at, superseded_by, usefulness, access_count, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteVec = this.db.prepare(
      "DELETE FROM memories_vec WHERE id = ?",
    );
    const insertVec = this.db.prepare(
      "INSERT INTO memories_vec (id, vector) VALUES (?, ?)",
    );
    const insertFts = this.db.prepare(
      "INSERT OR REPLACE INTO memories_fts (id, content) VALUES (?, ?)",
    );

    for (let i = 0; i < memories.length; i += BATCH_SIZE) {
      const batch = memories.slice(i, i + BATCH_SIZE);

      // Check for existing IDs
      const ids = batch.map((m) => m.id);
      const placeholders = ids.map(() => "?").join(",");
      const existing = new Set(
        (
          this.db
            .prepare(`SELECT id FROM memories WHERE id IN (${placeholders})`)
            .all(...ids) as Array<{ id: string }>
        ).map((r) => r.id),
      );

      const toImport = batch.filter((m) => {
        if (existing.has(m.id)) {
          summary.memoriesSkipped++;
          return false;
        }
        return true;
      });

      if (toImport.length === 0) continue;

      // Generate embeddings for the batch
      const embeddings: number[][] = [];
      for (const mem of toImport) {
        try {
          embeddings.push(await this.embeddings.embed(mem.content));
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unknown embed error";
          summary.errors.push(`Failed to embed memory ${mem.id}: ${msg}`);
          embeddings.push([]);
        }
      }

      // Insert batch in a transaction
      const tx = this.db.transaction(() => {
        for (let j = 0; j < toImport.length; j++) {
          const mem = toImport[j];
          const embedding = embeddings[j];

          if (embedding.length === 0) {
            summary.errors.push(
              `Skipping memory ${mem.id}: no embedding generated`,
            );
            continue;
          }

          try {
            insertMain.run(
              mem.id,
              mem.content,
              JSON.stringify(mem.metadata),
              mem.createdAt,
              mem.updatedAt,
              mem.supersededBy,
              mem.usefulness,
              mem.accessCount,
              mem.lastAccessed,
            );
            deleteVec.run(mem.id);
            insertVec.run(mem.id, serializeVector(embedding));
            insertFts.run(mem.id, mem.content);
            summary.memoriesImported++;
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown insert error";
            summary.errors.push(`Failed to insert memory ${mem.id}: ${msg}`);
          }
        }
      });
      tx();
    }
  }

  private async importConversations(
    conversations: NormalizedConversation[],
    summary: MigrationSummary,
  ): Promise<void> {
    if (conversations.length === 0) return;

    const insertMain = this.db.prepare(
      `INSERT OR REPLACE INTO conversation_history
        (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteVec = this.db.prepare(
      "DELETE FROM conversation_history_vec WHERE id = ?",
    );
    const insertVec = this.db.prepare(
      "INSERT INTO conversation_history_vec (id, vector) VALUES (?, ?)",
    );
    const insertFts = this.db.prepare(
      "INSERT OR REPLACE INTO conversation_history_fts (id, content) VALUES (?, ?)",
    );

    for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
      const batch = conversations.slice(i, i + BATCH_SIZE);

      const ids = batch.map((c) => c.id);
      const placeholders = ids.map(() => "?").join(",");
      const existing = new Set(
        (
          this.db
            .prepare(
              `SELECT id FROM conversation_history WHERE id IN (${placeholders})`,
            )
            .all(...ids) as Array<{ id: string }>
        ).map((r) => r.id),
      );

      const toImport = batch.filter((c) => {
        if (existing.has(c.id)) {
          summary.conversationsSkipped++;
          return false;
        }
        return true;
      });

      if (toImport.length === 0) continue;

      const embeddings: number[][] = [];
      for (const conv of toImport) {
        try {
          embeddings.push(await this.embeddings.embed(conv.content));
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unknown embed error";
          summary.errors.push(
            `Failed to embed conversation ${conv.id}: ${msg}`,
          );
          embeddings.push([]);
        }
      }

      const tx = this.db.transaction(() => {
        for (let j = 0; j < toImport.length; j++) {
          const conv = toImport[j];
          const embedding = embeddings[j];

          if (embedding.length === 0) {
            summary.errors.push(
              `Skipping conversation ${conv.id}: no embedding generated`,
            );
            continue;
          }

          try {
            insertMain.run(
              conv.id,
              conv.content,
              conv.metadata,
              conv.createdAt,
              conv.sessionId,
              conv.role,
              conv.messageIndexStart,
              conv.messageIndexEnd,
              conv.project,
            );
            deleteVec.run(conv.id);
            insertVec.run(conv.id, serializeVector(embedding));
            insertFts.run(conv.id, conv.content);
            summary.conversationsImported++;
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown insert error";
            summary.errors.push(
              `Failed to insert conversation ${conv.id}: ${msg}`,
            );
          }
        }
      });
      tx();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private safeParseJson(value: unknown): Record<string, unknown> {
    if (typeof value !== "string") return {};
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
}
