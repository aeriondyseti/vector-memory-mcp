/**
 * Preload script to download/warm up models before tests run.
 *
 * Run this manually or as part of CI to ensure models are available:
 *   bun run tests/preload.ts
 *
 * Or use it as a bun test preload:
 *   bun test --preload ./tests/preload.ts
 */

import { warmupModel, getModelState } from "./utils/model-loader";

console.log("🔄 Warming up embedding model...");
const startTime = Date.now();

const state = await warmupModel();

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

if (state.available) {
  console.log(`✅ Model loaded successfully in ${elapsed}s`);
} else {
  console.warn(`⚠️  Model failed to load after ${elapsed}s`);
  console.warn(`   Error: ${state.error?.message}`);
  console.warn(`   Tests requiring embeddings will be skipped.`);
}

// Export for use in test setup
export { warmupModel, getModelState } from "./utils/model-loader";
