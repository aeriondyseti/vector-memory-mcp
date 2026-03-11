import { mock } from "bun:test";
import type { EmbeddingsService } from "../../src/services/embeddings.service.js";

export const EMBEDDING_DIM = 384;

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
