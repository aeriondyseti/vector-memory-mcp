#!/usr/bin/env bun

import { loadConfig, parseCliArgs } from "./config/index";
import { connectToDatabase } from "./core/connection";
import { backfillVectors } from "./core/migrations";
import { MemoryRepository } from "./core/memory.repository";
import { ConversationRepository } from "./core/conversation.repository";
import { EmbeddingsService } from "./core/embeddings.service";
import { MemoryService } from "./core/memory.service";
import { ConversationHistoryService } from "./core/conversation.service";
import { startServer } from "./transports/mcp/server";
import { startHttpServer } from "./transports/http/server";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for warmup command
  if (args[0] === "warmup") {
    const { warmup } = await import("../scripts/warmup.js");
    await warmup();
    return;
  }

  // Parse CLI args and load config
  const overrides = parseCliArgs(args);
  const config = loadConfig(overrides);

  // Initialize database and backfill any missing vectors before services start
  const db = connectToDatabase(config.dbPath);
  const embeddings = new EmbeddingsService(config.embeddingModel, config.embeddingDimension);
  await backfillVectors(db, embeddings);

  // Initialize layers
  const repository = new MemoryRepository(db);
  const memoryService = new MemoryService(repository, embeddings);

  if (config.pluginMode) {
    console.error("[vector-memory-mcp] Running in plugin mode");
  }

  // Conditionally initialize conversation history indexing
  if (config.conversationHistory.enabled) {
    const conversationRepository = new ConversationRepository(db);
    const conversationService = new ConversationHistoryService(
      conversationRepository,
      embeddings,
      config.conversationHistory,
      config.dbPath
    );
    memoryService.setConversationService(conversationService);
    console.error("[vector-memory-mcp] Conversation history indexing enabled");
  }

  // Track cleanup functions
  let httpStop: (() => void) | null = null;

  // Graceful shutdown handler
  const shutdown = () => {
    console.error("[vector-memory-mcp] Shutting down...");
    if (httpStop) httpStop();
    db.close();
    process.exit(0);
  };

  // Handle signals and stdin close (parent process exit)
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.on("end", shutdown);

  // Start HTTP server if transport mode includes it
  if (config.enableHttp) {
    const http = await startHttpServer(memoryService, config);
    httpStop = http.stop;
    console.error(
      `[vector-memory-mcp] MCP available at http://${config.httpHost}:${config.httpPort}/mcp`
    );
  }

  // Start stdio transport unless in HTTP-only mode
  if (config.transportMode !== "http") {
    await startServer(memoryService);
  } else {
    // In HTTP-only mode, keep the process running
    console.error("[vector-memory-mcp] Running in HTTP-only mode (no stdio)");
    // Keep process alive - the HTTP server runs indefinitely
    await new Promise(() => {});
  }
}

main().catch(console.error);
