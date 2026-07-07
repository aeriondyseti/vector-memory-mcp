import { mock } from "bun:test";
import { rmSync } from "fs";
import type { EmbeddingsService } from "../../server/core/embeddings.service";

export const EMBEDDING_DIM = 384;

/**
 * Remove a temp directory, tolerating Windows' delayed SQLite handle release.
 *
 * bun:sqlite does not finalize prepared-statement handles on `Database.close()`
 * — they linger until GC. On Windows those handles keep the db file locked, so
 * `rmSync` throws EBUSY/EPERM even after every connection was closed. Forcing a
 * GC pass BEFORE each attempt releases them, so a just-closed handle is cleared
 * on the first try; a short bounded backoff covers stragglers.
 *
 * Best-effort by design: temp cleanup must never fail (or time out) a test, so
 * the total blocking time is capped well under bun:test's hook timeout and it
 * gives up quietly if the OS still holds the file (e.g. a spawned subprocess).
 * A no-op cost on POSIX, where the first removal succeeds immediately.
 *
 * Always call `db.close()` on any open handles BEFORE this.
 */
export function removeDir(dir: string, maxAttempts = 8): void {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // GC first so freshly-closed bun:sqlite handles are finalized before we try.
    if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") return;
      if (attempt === maxAttempts) return; // best-effort — never fail the test
      Bun.sleepSync(25 * attempt); // worst case ~700ms total, well under timeout
    }
  }
}

export function fakeEmbedding(): number[] {
  return new Array(EMBEDDING_DIM).fill(0).map(() => Math.random());
}

/**
 * Stub EmbeddingsService that returns random embeddings.
 * Avoids loading the real model in tests.
 */
export function createMockEmbeddings(): EmbeddingsService {
  return {
    dimension: EMBEDDING_DIM,
    embed: mock(async () => fakeEmbedding()),
    embedBatch: mock(async (texts: string[]) => texts.map(() => fakeEmbedding())),
  } as unknown as EmbeddingsService;
}

// -- JSONL helpers for building session parser test data --

export function userLine(
  content: string,
  opts: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    type: "user",
    sessionId: opts.sessionId ?? "test-session",
    timestamp: opts.timestamp ?? "2026-03-09T10:00:00Z",
    gitBranch: opts.gitBranch ?? "main",
    cwd: opts.cwd ?? "/project",
    message: { role: "user", content },
    uuid: "u-1",
    ...opts,
  });
}

export function assistantLine(
  blocks: Array<{ type: string; text?: string }>,
  opts: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: opts.sessionId ?? "test-session",
    timestamp: opts.timestamp ?? "2026-03-09T10:01:00Z",
    gitBranch: opts.gitBranch ?? "main",
    cwd: opts.cwd ?? "/project",
    message: { role: "assistant", content: blocks },
    uuid: "a-1",
    ...opts,
  });
}
