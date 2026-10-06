/**
 * Persistent embedding cache for benchmarks: re-loading the same texts into
 * fresh databases (configurations, scale subsets) skips the model.
 *
 * Keyed by SHA-256 of model and text, so the file holds no plaintext — safe
 * for private datasets such as a local vault. Stored under the gitignored
 * .vector-memory/benchmark-cache/. Format: repeated [32-byte key][dim × f32].
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { EmbeddingsService } from "../../server/core/embeddings.service";

const KEY_BYTES = 32;

export class CachedEmbeddings {
  private cache = new Map<string, number[]>();
  private dirty = false;
  hits = 0;
  misses = 0;

  constructor(
    private inner: EmbeddingsService,
    private modelName: string,
    private file?: string,
  ) {
    if (file && existsSync(file)) this.read(file);
  }

  get dimension(): number {
    return this.inner.dimension;
  }

  get isReady(): boolean {
    return this.inner.isReady;
  }

  warmup(): Promise<void> {
    return this.inner.warmup();
  }

  private key(text: string): string {
    return createHash("sha256").update(this.modelName).update("\0").update(text).digest("hex");
  }

  async embed(text: string): Promise<number[]> {
    const k = this.key(text);
    const hit = this.cache.get(k);
    if (hit) {
      this.hits++;
      return hit;
    }
    this.misses++;
    const v = await this.inner.embed(text);
    this.cache.set(k, v);
    this.dirty = true;
    return v;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }

  /** Write new entries to the cache file, if one was given. */
  save(): void {
    if (!this.file || !this.dirty) return;
    const dim = this.dimension;
    const entry = KEY_BYTES + dim * 4;
    const buf = Buffer.alloc(this.cache.size * entry);
    let offset = 0;
    for (const [k, v] of this.cache) {
      Buffer.from(k, "hex").copy(buf, offset);
      Buffer.from(new Float32Array(v).buffer).copy(buf, offset + KEY_BYTES);
      offset += entry;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, buf);
    this.dirty = false;
  }

  private read(file: string): void {
    const buf = readFileSync(file);
    const dim = this.dimension;
    const entry = KEY_BYTES + dim * 4;
    for (let offset = 0; offset + entry <= buf.length; offset += entry) {
      const k = buf.subarray(offset, offset + KEY_BYTES).toString("hex");
      const floats = new Float32Array(buf.buffer.slice(buf.byteOffset + offset + KEY_BYTES, buf.byteOffset + offset + entry));
      this.cache.set(k, Array.from(floats));
    }
  }

  /** As the EmbeddingsService that MemoryService takes. */
  asService(): EmbeddingsService {
    return this as unknown as EmbeddingsService;
  }
}
