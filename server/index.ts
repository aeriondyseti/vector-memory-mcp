#!/usr/bin/env bun

import { existsSync } from "fs";
import { join } from "path";
import arg from "arg";
import { loadConfig, parseCliArgs } from "./config/index";
import { connectToDatabase } from "./core/connection";
import { backfillVectors, repairConversationProjects } from "./core/migrations";
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

  // Consolidate repo-local databases into the global store
  if (args[0] === "consolidate") {
    await runConsolidate(args.slice(1));
    return;
  }

  // Parse CLI args and load config
  const overrides = parseCliArgs(args);
  const config = loadConfig(overrides);

  // Nudge: a repo-local database exists but the global store is active —
  // suggest consolidating it. Skipped when the user explicitly chose a db.
  if (
    !overrides.dbPath &&
    !process.env.VECTOR_MEMORY_DB_PATH &&
    existsSync(join(process.cwd(), ".vector-memory", "memories.db"))
  ) {
    console.error(
      "[vector-memory-mcp] Found a repo-local .vector-memory/memories.db — " +
        "memories now live in a global store (~/.vector-memory). " +
        "Run `bunx @aeriondyseti/vector-memory-mcp consolidate` to import it."
    );
  }

  // Initialize database and backfill any missing vectors before services start
  const db = connectToDatabase(config.dbPath);
  const embeddings = new EmbeddingsService(config.embeddingModel, config.embeddingDimension);
  await backfillVectors(db, embeddings);
  await repairConversationProjects(db, config.dbPath);

  // Initialize layers
  const repository = new MemoryRepository(db);
  const memoryService = new MemoryService(repository, embeddings, config.project);

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

async function runConsolidate(argv: string[]): Promise<void> {
  const flags = arg(
    {
      "--recursive": Boolean,
      "--dry-run": Boolean,
      "--archive": Boolean,
      "--force": Boolean,
      "--db-file": String,
      "-d": "--db-file",
      "-r": "--recursive",
    },
    { argv, permissive: true }
  );

  const root = flags._.find((a) => !a.startsWith("-")) ?? process.cwd();
  const config = loadConfig({ dbPath: flags["--db-file"] });

  const { ConsolidationService } = await import("./core/consolidation.service");
  const db = connectToDatabase(config.dbPath);
  const embeddings = new EmbeddingsService(
    config.embeddingModel,
    config.embeddingDimension
  );
  const service = new ConsolidationService(db, config.dbPath, embeddings);

  const summary = await service.consolidate({
    root,
    recursive: flags["--recursive"] ?? false,
    dryRun: flags["--dry-run"] ?? false,
    archive: flags["--archive"] ?? false,
    force: flags["--force"] ?? false,
  });

  const log = console.error;
  log(`\nConsolidation ${summary.dryRun ? "(dry run) " : ""}-> ${summary.targetDb}`);
  if (summary.backupPath) log(`Backup: ${summary.backupPath}`);
  log(`Import batch: ${summary.importBatch}`);

  if (summary.sources.length === 0) {
    log(`No repo-local .vector-memory/memories.db found under ${root}.`);
    db.close();
    return;
  }

  for (const s of summary.sources) {
    log(`\n${s.sourceDb}`);
    log(`  project: ${s.project}`);
    log(`  memories: ${s.memoriesImported} imported, ${s.memoriesSkipped} skipped, ${s.memoriesRekeyed} re-keyed`);
    log(`  conversations: ${s.conversationsImported} imported, ${s.conversationsSkipped} skipped`);
    log(`  index state: ${s.indexStateImported} sessions`);
    for (const [oldId, newId] of Object.entries(s.rekeyMap)) {
      log(`  re-key: ${oldId} -> ${newId}`);
    }
    for (const ref of s.unresolvedReferences) {
      log(`  unresolved reference: ${ref}`);
    }
    for (const err of s.errors) {
      log(`  ERROR: ${err}`);
    }
  }

  const failed = summary.sources.some((s) => s.errors.length > 0);
  db.close();
  if (failed) process.exit(1);
}

main().catch(console.error);
