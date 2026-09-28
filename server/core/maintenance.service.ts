import type { Database } from "bun:sqlite";
import { existsSync, statSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { MemoryRepository } from "./memory.repository";

export interface HealthReport {
  total: number;
  live: number;
  deleted: number;
  archived: number;
  pinned: number;
  expired: number;
  avgUsefulness: number;
  totalAccessCount: number;
  conversationChunks: number;
  dbPath: string;
  schemaVersion: number;
  journalMode: string;
  backend: string;
}

export interface StorageStats {
  dbPath: string;
  fileSizeBytes: number;
  walSizeBytes: number;
  pageCount: number;
  pageSize: number;
  freelistPages: number;
  /** Fraction of pages on the freelist (0–1); a rough fragmentation estimate. */
  fragmentation: number;
  memoryRows: number;
  conversationRows: number;
}

export interface OrphanReport {
  memoriesWithoutVector: string[];
  vectorsWithoutMemory: string[];
  memoriesWithoutFts: string[];
  ftsWithoutMemory: string[];
  repaired: boolean;
  removedDanglingVectors: number;
  removedDanglingFts: number;
}

export interface MaintenanceEntry {
  timestamp: string;
  action: string;
  details: Record<string, unknown>;
}

/**
 * Read-only stats plus destructive maintenance ops (VACUUM/ANALYZE, orphan
 * cleanup). Maintenance actions append to a sidecar JSON audit log next to the
 * database so history survives restarts without a schema change.
 */
export class MaintenanceService {
  constructor(
    private db: Database,
    private dbPath: string,
    private repository: MemoryRepository,
  ) {}

  private historyPath(): string {
    return join(dirname(this.dbPath), "maintenance-history.json");
  }

  private scalar(sql: string): number {
    const row = this.db.prepare(sql).get() as Record<string, number> | null;
    if (!row) return 0;
    const first = Object.values(row)[0];
    return typeof first === "number" ? first : 0;
  }

  health(now: number = Date.now()): HealthReport {
    const stats = this.repository.healthStats(now);
    const journalMode =
      (this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string })
        ?.journal_mode ?? "unknown";
    const schemaVersion =
      (this.db.prepare("PRAGMA user_version").get() as { user_version?: number })
        ?.user_version ?? 0;
    return {
      ...stats,
      conversationChunks: this.scalar("SELECT COUNT(*) AS c FROM conversation_history"),
      dbPath: this.dbPath,
      schemaVersion,
      journalMode,
      backend: "sqlite+sqlite-vec+fts5",
    };
  }

  storageStats(): StorageStats {
    const pageCount = this.scalar("PRAGMA page_count");
    const pageSize = this.scalar("PRAGMA page_size");
    const freelistPages = this.scalar("PRAGMA freelist_count");
    const sizeOf = (p: string): number =>
      existsSync(p) ? statSync(p).size : 0;

    return {
      dbPath: this.dbPath,
      fileSizeBytes: sizeOf(this.dbPath),
      walSizeBytes: sizeOf(`${this.dbPath}-wal`),
      pageCount,
      pageSize,
      freelistPages,
      fragmentation: pageCount > 0 ? freelistPages / pageCount : 0,
      memoryRows: this.scalar("SELECT COUNT(*) AS c FROM memories"),
      conversationRows: this.scalar("SELECT COUNT(*) AS c FROM conversation_history"),
    };
  }

  /** Run VACUUM + ANALYZE to reclaim space and refresh query planner stats. */
  optimize(): { pagesBefore: number; pagesAfter: number; freedBytes: number } {
    const pageSize = this.scalar("PRAGMA page_size");
    const before = this.scalar("PRAGMA page_count");
    // VACUUM cannot run inside a transaction; bun:sqlite exec runs it directly.
    this.db.exec("VACUUM");
    this.db.exec("ANALYZE");
    const after = this.scalar("PRAGMA page_count");
    const result = {
      pagesBefore: before,
      pagesAfter: after,
      freedBytes: Math.max(0, before - after) * pageSize,
    };
    this.recordHistory("optimize_database", result);
    return result;
  }

  /**
   * Detect (and optionally repair) inconsistencies between the primary table
   * and its vector/FTS sidecars. Repair only removes DANGLING sidecar rows
   * (vectors/FTS entries with no memory); it never deletes memories, and
   * missing vectors are reported for a re-embed/backfill rather than dropped.
   */
  cleanupOrphans(repair = false): OrphanReport {
    const ids = (sql: string): string[] =>
      (this.db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);

    const memoriesWithoutVector = ids(
      `SELECT m.id FROM memories m LEFT JOIN memories_vec v ON m.id = v.id
       WHERE v.id IS NULL`,
    );
    const vectorsWithoutMemory = ids(
      `SELECT v.id FROM memories_vec v LEFT JOIN memories m ON v.id = m.id
       WHERE m.id IS NULL`,
    );
    const memoriesWithoutFts = ids(
      `SELECT m.id FROM memories m LEFT JOIN memories_fts f ON m.id = f.id
       WHERE f.id IS NULL`,
    );
    const ftsWithoutMemory = ids(
      `SELECT f.id FROM memories_fts f LEFT JOIN memories m ON f.id = m.id
       WHERE m.id IS NULL`,
    );

    let removedDanglingVectors = 0;
    let removedDanglingFts = 0;
    if (repair && (vectorsWithoutMemory.length > 0 || ftsWithoutMemory.length > 0)) {
      const delVec = this.db.prepare("DELETE FROM memories_vec WHERE id = ?");
      const delFts = this.db.prepare("DELETE FROM memories_fts WHERE id = ?");
      const tx = this.db.transaction(() => {
        for (const id of vectorsWithoutMemory)
          removedDanglingVectors += delVec.run(id).changes;
        for (const id of ftsWithoutMemory)
          removedDanglingFts += delFts.run(id).changes;
      });
      tx();
    }

    const report: OrphanReport = {
      memoriesWithoutVector,
      vectorsWithoutMemory,
      memoriesWithoutFts,
      ftsWithoutMemory,
      repaired: repair,
      removedDanglingVectors,
      removedDanglingFts,
    };
    if (repair) {
      this.recordHistory("cleanup_orphans", {
        removedDanglingVectors,
        removedDanglingFts,
        memoriesWithoutVector: memoriesWithoutVector.length,
      });
    }
    return report;
  }

  getHistory(limit = 50): MaintenanceEntry[] {
    try {
      const raw = readFileSync(this.historyPath(), "utf-8");
      const entries = JSON.parse(raw) as MaintenanceEntry[];
      if (!Array.isArray(entries)) return [];
      return entries.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  private recordHistory(action: string, details: Record<string, unknown>): void {
    let entries: MaintenanceEntry[] = [];
    try {
      const raw = readFileSync(this.historyPath(), "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // no history yet — start fresh
    }
    entries.push({ timestamp: new Date().toISOString(), action, details });
    // Cap the log so it can't grow unbounded.
    if (entries.length > 500) entries = entries.slice(-500);
    try {
      writeFileSync(this.historyPath(), JSON.stringify(entries, null, 2));
    } catch {
      // best-effort audit log — never fail the maintenance op on write error
    }
  }
}
