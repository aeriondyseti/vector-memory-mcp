#!/usr/bin/env bun

import { loadConfig, parseCliArgs } from "./config/index.js";
import { connectToDatabase } from "./core/connection.js";
import { MemoryRepository } from "./core/memory.repository.js";
import { ConversationRepository } from "./core/conversation.repository.js";
import { EmbeddingsService } from "./core/embeddings.service.js";
import { MemoryService } from "./core/memory.service.js";
import { ConversationHistoryService } from "./core/conversation.service.js";
import { startServer } from "./transports/mcp/server.js";
import { startHttpServer, removeLockfile } from "./transports/http/server.js";
import { isLanceDbDirectory, migrate, formatMigrationSummary } from "./migration.js";

async function runMigrate(args: string[]): Promise<void> {
  const overrides = parseCliArgs(args.slice(1)); // skip "migrate"
  const config = loadConfig(overrides);

  const source = config.dbPath;
  const target = source.endsWith(".sqlite") ? source.replace(/\.sqlite$/, "-migrated.sqlite") : source + ".sqlite";

  if (!isLanceDbDirectory(source)) {
    console.error(
      `[vector-memory-mcp] No LanceDB data found at ${source}\n` +
      `  Nothing to migrate. The server will create a fresh SQLite database on startup.`
    );
    return;
  }

  const result = await migrate({ source, target });
  console.error(formatMigrationSummary(source, target, result));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for warmup command
  if (args[0] === "warmup") {
    const { warmup } = await import("../scripts/warmup.js");
    await warmup();
    return;
  }

  // Check for migrate command
  if (args[0] === "migrate") {
    await runMigrate(args);
    return;
  }

  // Parse CLI args and load config
  const overrides = parseCliArgs(args);
  const config = loadConfig(overrides);

  // Detect legacy LanceDB data and warn
  if (isLanceDbDirectory(config.dbPath)) {
    console.error(
      `[vector-memory-mcp] ⚠️  Legacy LanceDB data detected at ${config.dbPath}\n` +
      `  Your data must be migrated to the new SQLite format.\n` +
      `  Run: vector-memory-mcp migrate\n` +
      `  Or:  bun run server/index.ts migrate\n`
    );
    process.exit(1);
  }

  // Initialize database
  const db = connectToDatabase(config.dbPath);

  // Initialize layers
  const repository = new MemoryRepository(db);
  const embeddings = new EmbeddingsService(config.embeddingModel, config.embeddingDimension);
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
    removeLockfile();
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
