import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EmbeddingsService, modelCacheDir } from "../server/core/embeddings.service";
import { RerankerService } from "../server/core/reranker.service";

// A model name no cache holds, so every load goes to the (stubbed) network.
const MODEL = "test-org/no-such-model";

describe("model cache and retries", () => {
  const realFetch = globalThis.fetch;
  const realDir = process.env.VECTOR_MEMORY_MODEL_DIR;
  let dir: string;
  let fetched: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vm-models-"));
    process.env.VECTOR_MEMORY_MODEL_DIR = dir;
    fetched = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realDir === undefined) delete process.env.VECTOR_MEMORY_MODEL_DIR;
    else process.env.VECTOR_MEMORY_MODEL_DIR = realDir;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Stub the network: each request is recorded, then `respond` answers it. */
  function stubFetch(respond: () => Response) {
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return respond();
    }) as typeof fetch;
  }

  const droppedSocket = () => {
    throw new Error("The socket connection was closed unexpectedly.");
  };

  test("models are cached under VECTOR_MEMORY_MODEL_DIR, not the package", () => {
    expect(modelCacheDir()).toBe(dir);
  });

  test("an embedding load that failed is retried on the next call", async () => {
    stubFetch(droppedSocket);
    const embeddings = new EmbeddingsService(MODEL, 384);

    await expect(embeddings.embed("a")).rejects.toThrow("socket connection was closed");
    await expect(embeddings.embed("b")).rejects.toThrow("socket connection was closed");

    expect(fetched.length).toBe(2); // tried again, not the first failure replayed
  });

  test("a reranker load that failed is retried on the next call", async () => {
    stubFetch(droppedSocket);
    const reranker = new RerankerService(MODEL);

    await expect(reranker.score("q", ["p"])).rejects.toThrow("socket connection was closed");
    await expect(reranker.score("q", ["p"])).rejects.toThrow("socket connection was closed");

    expect(fetched.length).toBe(2);
  });

  test("a download lands whole in the cache, with no partial file left", async () => {
    stubFetch(() => new Response("not really a model"));
    const embeddings = new EmbeddingsService(MODEL, 384);

    // The bytes are no ONNX model, so loading fails after the download.
    await expect(embeddings.embed("a")).rejects.toThrow();

    const onnxDir = join(dir, MODEL, "onnx");
    expect(existsSync(join(onnxDir, "model.onnx"))).toBe(true);
    expect(readdirSync(onnxDir).filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(fetched[0]).toBe(`https://huggingface.co/${MODEL}/resolve/main/onnx/model.onnx`);
  });
});
