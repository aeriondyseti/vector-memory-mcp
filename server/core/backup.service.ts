import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";

export interface BackupInfo {
  id: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  description?: string;
}

export interface VerifyResult {
  id: string;
  exists: boolean;
  valid: boolean;
  expectedSha256: string | null;
  actualSha256: string | null;
}

export interface RestoreResult {
  restored: boolean;
  reason?: string;
  safetyBackupId?: string;
}

export interface PurgeResult {
  deleted: string[];
}

/**
 * File-copy backup/restore for the SQLite database (Feature 26). Backups live
 * next to the database in a `backups/` directory, with a sidecar JSON index
 * (`backups-index.json`) holding metadata. Index writes are best-effort —
 * they never throw — since losing audit metadata is preferable to failing a
 * backup that otherwise succeeded.
 */
export class BackupService {
  private readonly backupsDir: string;
  private readonly indexPath: string;

  constructor(private dbPath: string) {
    this.backupsDir = join(dirname(dbPath), "backups");
    this.indexPath = join(this.backupsDir, "backups-index.json");
  }

  private readIndex(): BackupInfo[] {
    try {
      const raw = readFileSync(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as BackupInfo[]) : [];
    } catch {
      // missing or corrupt index — treat as empty
      return [];
    }
  }

  private writeIndex(entries: BackupInfo[]): void {
    try {
      mkdirSync(this.backupsDir, { recursive: true });
      writeFileSync(this.indexPath, JSON.stringify(entries, null, 2));
    } catch {
      // best-effort — never fail a backup op on index write error
    }
  }

  private static timestampStem(now: Date): string {
    return now.toISOString().replace(/[:.]/g, "-");
  }

  private sha256Of(filePath: string): string {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }

  create(description?: string): BackupInfo {
    mkdirSync(this.backupsDir, { recursive: true });

    const now = new Date();
    const stem = BackupService.timestampStem(now);
    // Guard against two backups landing in the same millisecond (the ISO
    // timestamp's resolution) by disambiguating with a numeric suffix.
    let id = stem;
    let fileName = `backup-${id}.db`;
    let path = join(this.backupsDir, fileName);
    for (let n = 2; existsSync(path); n++) {
      id = `${stem}-${n}`;
      fileName = `backup-${id}.db`;
      path = join(this.backupsDir, fileName);
    }

    copyFileSync(this.dbPath, path);
    const sha256 = this.sha256Of(path);
    const sizeBytes = statSync(path).size;

    const record: BackupInfo = {
      id,
      fileName,
      path,
      sizeBytes,
      sha256,
      createdAt: now.toISOString(),
      ...(description !== undefined ? { description } : {}),
    };

    const entries = this.readIndex();
    entries.push(record);
    this.writeIndex(entries);

    return record;
  }

  list(): BackupInfo[] {
    return [...this.readIndex()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  verify(id: string): VerifyResult {
    const entry = this.readIndex().find((e) => e.id === id);
    if (!entry) {
      return { id, exists: false, valid: false, expectedSha256: null, actualSha256: null };
    }
    if (!existsSync(entry.path)) {
      return {
        id,
        exists: false,
        valid: false,
        expectedSha256: entry.sha256,
        actualSha256: null,
      };
    }
    const actualSha256 = this.sha256Of(entry.path);
    return {
      id,
      exists: true,
      valid: actualSha256 === entry.sha256,
      expectedSha256: entry.sha256,
      actualSha256,
    };
  }

  restore(id: string, confirm: boolean): RestoreResult {
    if (!confirm) {
      return { restored: false, reason: "confirmation required" };
    }

    const entry = this.readIndex().find((e) => e.id === id);
    if (!entry || !existsSync(entry.path)) {
      return { restored: false, reason: "not found" };
    }

    const safety = this.create("pre-restore safety");
    copyFileSync(entry.path, this.dbPath);

    return { restored: true, safetyBackupId: safety.id };
  }

  purge(keepLastN: number): PurgeResult {
    const entries = this.list(); // newest first
    const toKeep = entries.slice(0, Math.max(0, keepLastN));
    const toRemove = entries.slice(Math.max(0, keepLastN));

    const deleted: string[] = [];
    for (const entry of toRemove) {
      try {
        if (existsSync(entry.path)) unlinkSync(entry.path);
      } catch {
        // best-effort file removal
      }
      deleted.push(entry.id);
    }

    this.writeIndex(toKeep);
    return { deleted };
  }
}
