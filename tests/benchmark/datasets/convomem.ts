/**
 * ConvoMem Dataset Loader
 *
 * Loads a subset of the Salesforce ConvoMem benchmark for retrieval evaluation.
 * Downloads on first run and caches locally.
 *
 * Default: ~50 evidence items per category + 5x filler noise.
 */

import { ConvoMemSource } from "../loaders/sources/convomem";
import { CacheManager } from "../loaders/cache";
import type { BenchmarkDataset } from "../types";

const CACHE_DIR = ".vector-memory/benchmark-cache";

export interface ConvoMemOptions {
  /** Evidence items per category (default: 50) */
  perCategory?: number;
  /** Random seed (default: 42) */
  seed?: number;
  /** Skip cache (default: false) */
  forceRefresh?: boolean;
}

/**
 * Load the ConvoMem dataset, fetching from HuggingFace if not cached.
 */
export async function loadConvoMemDataset(
  options: ConvoMemOptions = {}
): Promise<BenchmarkDataset> {
  const { perCategory = 50, seed = 42, forceRefresh = false } = options;
  const limit = perCategory * 6; // 6 evidence categories

  const cache = new CacheManager(CACHE_DIR);
  const source = new ConvoMemSource();
  const cacheKey = `convomem-${perCategory}-${seed}`;

  // Try cache first
  if (!forceRefresh) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      console.log(`  ConvoMem: loaded ${cached.length} samples from cache`);
      return source.toDataset(cached, { idPrefix: "convomem" });
    }
  }

  // Fetch fresh
  const samples = await source.fetch({ limit, seed });
  await cache.set(cacheKey, samples);
  return source.toDataset(samples, { idPrefix: "convomem" });
}
