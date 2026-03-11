#!/usr/bin/env bun
/**
 * SessionStart hook for Claude Code
 *
 * 1. Triggers incremental conversation history indexing (if enabled)
 * 2. Loads and outputs the latest checkpoint with referenced memories
 *
 * Requires the vector-memory-mcp server to be running with HTTP enabled.
 *
 * Usage in ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [{
 *       "hooks": [{
 *         "type": "command",
 *         "command": "bun /path/to/vector-memory-mcp/hooks/session-start.ts"
 *       }]
 *     }]
 *   }
 * }
 */

const VECTOR_MEMORY_URL =
  process.env.VECTOR_MEMORY_URL ?? "http://127.0.0.1:3271";

interface HealthResponse {
  status: string;
  config: {
    dbPath: string;
    embeddingModel: string;
    embeddingDimension: number;
    historyEnabled: boolean;
  };
}

interface CheckpointResponse {
  content: string;
  metadata: Record<string, unknown>;
  referencedMemories: Array<{ id: string; content: string }>;
  updatedAt: string;
}

async function main() {
  // Step 1: Check server is running and get config
  let health: HealthResponse;
  try {
    const response = await fetch(`${VECTOR_MEMORY_URL}/health`);
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    health = await response.json();
  } catch (error) {
    if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
      console.log("Vector memory server not running. Starting fresh session.");
      return;
    }
    throw error;
  }

  // Step 2: Trigger conversation history indexing (if enabled)
  if (health.config.historyEnabled) {
    try {
      const indexResponse = await fetch(
        `${VECTOR_MEMORY_URL}/index-conversations`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      if (indexResponse.ok) {
        const result = await indexResponse.json();
        if (result.indexed > 0 || result.errors?.length > 0) {
          console.error(
            `[vector-memory] Indexed ${result.indexed} sessions, skipped ${result.skipped}` +
              (result.errors?.length > 0
                ? `, ${result.errors.length} errors`
                : "")
          );
        }
      }
    } catch {
      // Non-fatal — indexing failure shouldn't block session start
      console.error("[vector-memory] Conversation indexing failed, continuing.");
    }
  }

  // Step 3: Load and output checkpoint
  let checkpoint: CheckpointResponse;
  try {
    const response = await fetch(`${VECTOR_MEMORY_URL}/checkpoint`);
    if (response.status === 404) {
      console.log("No checkpoint found. Starting fresh session.");
      return;
    }
    if (!response.ok) {
      throw new Error(`Checkpoint endpoint returned ${response.status}`);
    }
    checkpoint = await response.json();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[vector-memory] Failed to load checkpoint: ${msg}`);
    return;
  }

  // Format output: checkpoint content + referenced memories
  let output = checkpoint.content;

  if (checkpoint.referencedMemories.length > 0) {
    const memoriesSection = checkpoint.referencedMemories
      .map((m) => `### Memory: ${m.id}\n${m.content}`)
      .join("\n\n");
    output += `\n\n## Referenced Memories\n\n${memoriesSection}`;
  }

  console.log(output);
}

main().catch((err) => {
  console.error("Error in session-start hook:", err.message);
  process.exit(1);
});
