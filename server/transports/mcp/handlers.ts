import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryService } from "../../core/memory.service";
import type { ConversationHistoryService } from "../../core/conversation.service";
import type {
  SearchIntent,
  MemoryAttributes,
  MemoryConfidence,
  MemoryImportance,
} from "../../core/memory";
import {
  coerceConfidence,
  coerceImportance,
  MEMORY_CONFIDENCE_LEVELS,
  MEMORY_IMPORTANCE_LEVELS,
} from "../../core/memory";
import { MaintenanceService } from "../../core/maintenance.service";
import type { HistoryFilters, SearchResult } from "../../core/conversation";
import { resolveDateFilters } from "../../core/time-expr";
import { DEBUG } from "../../config/index";

/**
 * Safely coerce a tool argument to an array. Handles the case where the MCP
 * transport delivers a JSON-serialized string instead of a parsed array.
 */
function asArray<T>(value: unknown, fieldName: string): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    if (DEBUG) {
      console.error(
        `[vector-memory-mcp] DEBUG: ${fieldName} received as string (${value.length} chars) instead of array — parsing`
      );
    }
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (DEBUG) {
        console.error(
          `[vector-memory-mcp] DEBUG: ${fieldName} parsed as ${typeof parsed}, not array`
        );
      }
    } catch { /* fall through */ }
  } else if (DEBUG) {
    console.error(
      `[vector-memory-mcp] DEBUG: ${fieldName} has unexpected type: ${typeof value}`
    );
  }
  throw new Error(`${fieldName} must be an array`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function parseDate(value: unknown, fieldName: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value as string);
  if (isNaN(date.getTime())) {
    throw new Error(`${fieldName} is not a valid date`);
  }
  return date;
}

function requireString(args: Record<string, unknown> | undefined, field: string): string {
  const value = args?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value;
}

const VALID_INTENTS = new Set(["continuity", "fact_check", "frequent", "associative", "explore"]);

function asIntent(value: unknown): SearchIntent {
  if (typeof value === "string" && VALID_INTENTS.has(value)) return value as SearchIntent;
  return "fact_check";
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringLevel<T extends string>(
  value: unknown,
  valid: readonly T[],
): T | undefined {
  return typeof value === "string" && (valid as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Parse the schema-v2 memory attributes from a tool argument object, validating
 * enum values. Throws on an invalid confidence/importance so bad input surfaces
 * at the tool boundary. `expires_at` accepts an ISO date or null; `ttl_seconds`
 * is a convenience that computes expires_at from now.
 */
function parseAttributes(obj: Record<string, unknown>): MemoryAttributes {
  const a: MemoryAttributes = {};
  if (typeof obj.pinned === "boolean") a.pinned = obj.pinned;
  if (typeof obj.archived === "boolean") a.archived = obj.archived;

  const conf = coerceConfidence(obj.confidence);
  if (conf !== undefined) a.confidence = conf;
  const imp = coerceImportance(obj.importance);
  if (imp !== undefined) a.importance = imp;

  if (obj.expires_at !== undefined) {
    a.expiresAt = obj.expires_at === null
      ? null
      : parseDate(obj.expires_at, "expires_at") ?? null;
  } else if (typeof obj.ttl_seconds === "number" && Number.isFinite(obj.ttl_seconds)) {
    a.expiresAt = new Date(Date.now() + obj.ttl_seconds * 1000);
  }

  if (obj.episode_id !== undefined) {
    a.episodeId = typeof obj.episode_id === "string" ? obj.episode_id : null;
  }
  if (typeof obj.sequence_number === "number" && Number.isFinite(obj.sequence_number)) {
    a.sequenceNumber = Math.floor(obj.sequence_number);
  }
  if (obj.preceding_memory_id !== undefined) {
    a.precedingMemoryId =
      typeof obj.preceding_memory_id === "string" ? obj.preceding_memory_id : null;
  }
  return a;
}

/** Build a MaintenanceService bound to the service's live db connection. */
function maintenanceFor(service: MemoryService): MaintenanceService {
  const repo = service.getRepository();
  const db = repo.getDb();
  const dbPath =
    (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>)
      .find((r) => r.name === "main")?.file ?? "";
  return new MaintenanceService(db, dbPath, repo);
}

export async function handleStoreMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let memories: Array<{
    content: string;
    embedding_text?: string;
    metadata?: Record<string, unknown>;
    project?: string;
  }>;
  try {
    memories = asArray(args?.memories, "memories");
  } catch (e) {
    return errorResult(errorText(e));
  }

  const ids: string[] = [];
  try {
    for (const item of memories) {
      const memory = await service.store(
        item.content,
        item.metadata ?? {},
        item.embedding_text,
        typeof item.project === "string" ? item.project : undefined,
        parseAttributes(item as Record<string, unknown>)
      );
      ids.push(memory.id);
    }
  } catch (e) {
    return errorResult(errorText(e));
  }

  return {
    content: [
      {
        type: "text",
        text:
          ids.length === 1
            ? `Memory stored with ID: ${ids[0]}`
            : `Stored ${ids.length} memories:\n${ids.map((id) => `- ${id}`).join("\n")}`,
      },
    ],
  };
}

export async function handleDeleteMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  // Selectors: ids, tags, and/or a creation-date range (after/before/time_expr).
  let ids: string[] | undefined;
  if (args?.ids !== undefined) {
    try {
      ids = asArray(args.ids, "ids");
    } catch (e) {
      return errorResult(errorText(e));
    }
  }

  let tags: string[] | undefined;
  if (args?.tags !== undefined) {
    try {
      tags = asArray(args.tags, "tags");
    } catch (e) {
      return errorResult(errorText(e));
    }
  }

  let dateFilters: { after?: Date; before?: Date };
  try {
    dateFilters = resolveDateFilters({
      after: args?.after,
      before: args?.before,
      time_expr: args?.time_expr,
    });
  } catch (e) {
    return errorResult(errorText(e));
  }

  const tagMatch = args?.tag_match === "all" ? "all" : "any";
  const dryRun = asBool(args?.dry_run, false);
  const force = asBool(args?.force, false);

  let result;
  try {
    result = await service.deleteMemories({
      ids,
      tags,
      tagMatch,
      after: dateFilters.after,
      before: dateFilters.before,
      dryRun,
      force,
    });
  } catch (e) {
    return errorResult(errorText(e));
  }

  const lines: string[] = [];
  lines.push(
    dryRun
      ? `Dry run: ${result.deletedIds.length} memories would be deleted (${result.matched} matched).`
      : `Deleted ${result.deletedIds.length} memories (${result.matched} matched).`,
  );
  if (result.skippedProtected.length > 0) {
    lines.push(
      `Skipped ${result.skippedProtected.length} protected (pinned/critical) memories — pass force: true to include them.`,
    );
  }
  if (result.deletedIds.length > 0) {
    lines.push("IDs:");
    lines.push(...result.deletedIds.map((id) => `- ${id}`));
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}


export async function handleUpdateMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let updates: Array<{
    id: string;
    content?: string;
    embedding_text?: string;
    metadata?: Record<string, unknown>;
  }>;
  try {
    updates = asArray(args?.updates, "updates");
  } catch (e) {
    return errorResult(errorText(e));
  }

  const results: string[] = [];

  for (const update of updates) {
    if (!update.id || typeof update.id !== "string") {
      results.push("Skipped update: missing required id field");
      continue;
    }

    let memory;
    try {
      memory = await service.update(update.id, {
        content: update.content,
        embeddingText: update.embedding_text,
        metadata: update.metadata,
        attributes: parseAttributes(update as Record<string, unknown>),
      });
    } catch (e) {
      results.push(`Memory ${update.id}: ${errorText(e)}`);
      continue;
    }

    if (memory) {
      results.push(`Memory ${update.id} updated successfully`);
    } else {
      results.push(`Memory ${update.id} not found`);
    }
  }

  return {
    content: [
      {
        type: "text",
        text: results.join("\n"),
      },
    ],
  };
}

export async function handleSearchMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const query = args?.query;
  if (typeof query !== "string" || query.trim() === "") {
    return errorResult("query is required and must be a non-empty string");
  }
  const intent = asIntent(args?.intent);
  const limit = asInt(args?.limit, 10, 1, 1000);
  const offset = asInt(args?.offset, 0, 0, 10000);
  const includeDeleted = asBool(args?.include_deleted, false);
  const historyOnly = asBool(args?.history_only, false);
  // history_only implies include_history
  const includeHistory = historyOnly ? true : (typeof args?.include_history === "boolean" ? args.include_history : undefined);

  let historyFilters: HistoryFilters;
  try {
    historyFilters = parseHistoryFilters(args);
  } catch (e) {
    return errorResult(errorText(e));
  }

  let dateFilters: { after?: Date; before?: Date };
  try {
    dateFilters = resolveDateFilters({
      after: args?.after,
      before: args?.before,
      time_expr: args?.time_expr,
    });
  } catch (e) {
    return errorResult(errorText(e));
  }

  let tags: string[] | undefined;
  if (args?.tags !== undefined) {
    try {
      tags = asArray(args.tags, "tags");
    } catch (e) {
      return errorResult(errorText(e));
    }
  }

  const results = await service.search(query, intent, {
    limit,
    scope: asOptionalString(args?.scope),
    includeDeleted,
    includeHistory,
    historyOnly,
    historyFilters,
    offset,
    after: dateFilters.after,
    before: dateFilters.before,
    includeArchived: asBool(args?.include_archived, false),
    includeExpired: asBool(args?.include_expired, false),
    minConfidence: asStringLevel<MemoryConfidence>(args?.min_confidence, MEMORY_CONFIDENCE_LEVELS),
    minImportance: asStringLevel<MemoryImportance>(args?.min_importance, MEMORY_IMPORTANCE_LEVELS),
    type: asOptionalString(args?.type),
    tags,
    tagMatch: args?.tag_match === "all" ? "all" : "any",
    mode:
      args?.mode === "exact" || args?.mode === "hybrid" ? args.mode : "semantic",
  });

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "No results found matching your query." }],
    };
  }

  const formatted = results.map((r) => formatSearchResult(r, includeDeleted));
  const maxChars = asInt(args?.max_response_chars, 0, 0, 1_000_000);
  const text = joinWithinBudget(formatted, "\n\n---\n\n", maxChars);

  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Join formatted blocks with a separator, stopping at whole-block boundaries
 * once the character budget would be exceeded (Feature 7). A budget of 0 means
 * unlimited. Appends a truncation notice with the omitted count.
 */
function joinWithinBudget(blocks: string[], sep: string, maxChars: number): string {
  if (maxChars <= 0 || blocks.length === 0) return blocks.join(sep);
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const addition = kept.length === 0 ? block.length : sep.length + block.length;
    if (used + addition > maxChars && kept.length > 0) break;
    kept.push(block);
    used += addition;
  }
  const omitted = blocks.length - kept.length;
  const text = kept.join(sep);
  return omitted > 0
    ? `${text}${sep}[truncated: ${omitted} more result${omitted === 1 ? "" : "s"} omitted to fit max_response_chars]`
    : text;
}

function formatMemoryDetail(
  memoryId: string,
  memory: Awaited<ReturnType<MemoryService["get"]>>
): string {
  if (!memory) {
    return `Memory ${memoryId} not found`;
  }

  let result = `ID: ${memory.id}\nContent: ${memory.content}`;
  if (memory.metadata && Object.keys(memory.metadata).length > 0) {
    result += `\nMetadata: ${JSON.stringify(memory.metadata)}`;
  }
  const flags: string[] = [];
  if (memory.pinned) flags.push("pinned");
  if (memory.archived) flags.push("archived");
  if (memory.importance) flags.push(`importance:${memory.importance}`);
  if (memory.confidence) flags.push(`confidence:${memory.confidence}`);
  if (memory.expiresAt) flags.push(`expires:${memory.expiresAt.toISOString()}`);
  if (memory.episodeId) flags.push(`episode:${memory.episodeId}`);
  if (flags.length > 0) result += `\nAttributes: ${flags.join(", ")}`;
  result += `\nCreated: ${memory.createdAt.toISOString()}`;
  result += `\nUpdated: ${memory.updatedAt.toISOString()}`;
  if (memory.supersededBy) {
    result += `\nSuperseded by: ${memory.supersededBy}`;
  }
  return result;
}

function formatSearchResult(r: SearchResult, includeDeleted: boolean): string {
  let result = `[${r.source}] ID: ${r.id}\nConfidence: ${r.confidence.toFixed(2)}`;
  if (r.pinned) result += ` | 📌 pinned`;
  if (r.importance && r.importance !== "normal") result += ` | importance: ${r.importance}`;
  if (r.project) {
    result += `\nProject: ${r.project}`;
  }
  result += `\nContent: ${r.content}`;
  if (r.metadata && Object.keys(r.metadata).length > 0) {
    result += `\nMetadata: ${JSON.stringify(r.metadata)}`;
  }
  if (r.source === "memory" && includeDeleted && r.supersededBy) {
    result += `\n[DELETED]`;
  }
  if (r.source === "conversation_history" && r.sessionId) {
    result += `\nSession: ${r.sessionId}`;
  }
  return result;
}

export async function handleGetMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let ids: string[];
  try {
    ids = asArray(args?.ids, "ids");
  } catch (e) {
    return errorResult(errorText(e));
  }

  const memories = await service.getMultiple(ids);
  const memoryMap = new Map(memories.map((m) => [m.id, m]));

  // Preserve requested order; show "not found" for missing IDs
  const blocks = ids.map((id) => formatMemoryDetail(id, memoryMap.get(id) ?? null));

  return {
    content: [{ type: "text", text: blocks.join("\n\n---\n\n") }],
  };
}

export async function handleReportMemoryUsefulness(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const memoryId = requireString(args, "memory_id");
  const useful = args?.useful;
  if (typeof useful !== "boolean") {
    return errorResult("useful is required and must be a boolean");
  }

  const memory = await service.vote(memoryId, useful ? 1 : -1);

  if (!memory) {
    return errorResult(`Memory ${memoryId} not found`);
  }

  return {
    content: [
      {
        type: "text",
        text: `Memory ${memoryId} marked as ${useful ? "useful" : "not useful"}. New usefulness score: ${memory.usefulness}`,
      },
    ],
  };
}

export async function handleSetWaypoint(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let summary: string;
  try {
    summary = requireString(args, "summary");
  } catch (e) {
    return errorResult(errorText(e));
  }

  const memory = await service.setWaypoint({
    project: asOptionalString(args?.project),
    branch: asOptionalString(args?.branch),
    summary,
    completed: args?.completed ? asArray(args.completed, "completed") : [],
    in_progress_blocked: args?.in_progress_blocked ? asArray(args.in_progress_blocked, "in_progress_blocked") : [],
    key_decisions: args?.key_decisions ? asArray(args.key_decisions, "key_decisions") : [],
    next_steps: args?.next_steps ? asArray(args.next_steps, "next_steps") : [],
    memory_ids: args?.memory_ids ? asArray(args.memory_ids, "memory_ids") : [],
    metadata: asObject(args?.metadata),
  });

  return {
    content: [{ type: "text", text: `Waypoint stored with memory ID: ${memory.id}` }],
  };
}

export async function handleGetWaypoint(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const project = asOptionalString(args?.project);
  const waypoint = await service.getLatestWaypoint(project);

  if (!waypoint) {
    return {
      content: [{ type: "text", text: "No stored waypoint found." }],
    };
  }

  // Fetch referenced memories in batch
  const memoryIds = (waypoint.metadata.memory_ids as string[] | undefined) ?? [];
  let memoriesSection = "";

  if (memoryIds.length > 0) {
    const fetched = await service.getMultiple(memoryIds);
    const blocks = fetched.map((m) => `### Memory: ${m.id}\n${m.content}`);
    if (blocks.length > 0) {
      memoriesSection = `\n\n## Referenced Memories\n\n${blocks.join("\n\n")}`;
    }
  }

  return {
    content: [{ type: "text", text: waypoint.content + memoriesSection }],
  };
}

function parseHistoryFilters(
  args: Record<string, unknown> | undefined
): HistoryFilters {
  return {
    sessionId: asOptionalString(args?.session_id),
    role: asOptionalString(args?.role_filter),
    after: parseDate(args?.history_after, "history_after"),
    before: parseDate(args?.history_before, "history_before"),
  };
}

function requireConversationService(
  service: MemoryService
): { service: ConversationHistoryService } | { error: CallToolResult } {
  const conversationService = service.getConversationService();
  if (!conversationService) {
    return {
      error: errorResult(
        "Conversation history indexing is not enabled. Enable it with --enable-history."
      ),
    };
  }
  return { service: conversationService };
}

export async function handleIndexConversations(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const conv = requireConversationService(service);
  if ("error" in conv) return conv.error;
  const conversationService = conv.service;

  const path = asOptionalString(args?.path);
  const sinceStr = asOptionalString(args?.since);
  const since = sinceStr ? new Date(sinceStr) : undefined;
  if (since && isNaN(since.getTime())) {
    return errorResult("Invalid 'since' date format");
  }

  const result = await conversationService.indexConversations(path, since);

  return {
    content: [
      {
        type: "text",
        text:
          `Indexing complete:\n- Indexed: ${result.indexed} sessions\n- Skipped: ${result.skipped} sessions (unchanged)\n` +
          (result.errors.length > 0
            ? `- Errors: ${result.errors.length}\n${result.errors.map((e) => `  - ${e}`).join("\n")}`
            : "- No errors"),
      },
    ],
  };
}

export async function handleListIndexedSessions(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const conv = requireConversationService(service);
  if ("error" in conv) return conv.error;
  const conversationService = conv.service;

  const limit = asInt(args?.limit, 20, 1, 1000);
  const offset = asInt(args?.offset, 0, 0, 10000);
  const { sessions, total } =
    await conversationService.listIndexedSessions(limit, offset);

  if (sessions.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No indexed sessions found. Run index_conversations first.",
        },
      ],
    };
  }

  const lines = sessions.map(
    (s) =>
      `Session: ${s.sessionId}\n  Project: ${s.project}\n  Messages: ${s.messageCount} | Chunks: ${s.chunkCount}\n  Period: ${s.firstMessageAt.toISOString()} to ${s.lastMessageAt.toISOString()}\n  Indexed: ${s.indexedAt.toISOString()}`
  );

  return {
    content: [
      {
        type: "text",
        text: `Showing ${offset + 1}-${offset + sessions.length} of ${total} sessions:\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

export async function handleReindexSession(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const conv = requireConversationService(service);
  if ("error" in conv) return conv.error;
  const conversationService = conv.service;

  const sessionId = asOptionalString(args?.session_id);
  if (!sessionId) {
    return errorResult("session_id is required");
  }
  const result = await conversationService.reindexSession(sessionId);

  if (!result.success) {
    return errorResult(`Reindex failed: ${result.error}`);
  }

  return {
    content: [
      {
        type: "text",
        text: `Session ${sessionId} reindexed successfully. ${result.chunkCount} chunks created.`,
      },
    ],
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function handleMemoryHealth(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const h = maintenanceFor(service).health();
  const lines = [
    "Memory Health",
    `- Total records: ${h.total} (live: ${h.live}, deleted: ${h.deleted})`,
    `- Archived: ${h.archived} | Pinned: ${h.pinned} | Expired: ${h.expired}`,
    `- Avg usefulness: ${h.avgUsefulness.toFixed(3)} | Total accesses: ${h.totalAccessCount}`,
    `- Conversation chunks: ${h.conversationChunks}`,
    `- Schema version: ${h.schemaVersion} | Journal: ${h.journalMode} | Backend: ${h.backend}`,
    `- Database: ${h.dbPath}`,
  ];
  return textResult(lines.join("\n"));
}

export async function handleStorageStats(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const s = maintenanceFor(service).storageStats();
  const lines = [
    "Storage Stats",
    `- File size: ${formatBytes(s.fileSizeBytes)} (WAL: ${formatBytes(s.walSizeBytes)})`,
    `- Pages: ${s.pageCount} × ${s.pageSize} B | Free pages: ${s.freelistPages} (${(s.fragmentation * 100).toFixed(1)}% fragmentation)`,
    `- Rows — memories: ${s.memoryRows}, conversation_history: ${s.conversationRows}`,
    `- Database: ${s.dbPath}`,
  ];
  return textResult(lines.join("\n"));
}

export async function handleOptimizeDatabase(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const r = maintenanceFor(service).optimize();
  return textResult(
    `Database optimized (VACUUM + ANALYZE).\n- Pages: ${r.pagesBefore} → ${r.pagesAfter}\n- Reclaimed: ${formatBytes(r.freedBytes)}`,
  );
}

export async function handleCleanupOrphans(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const repair = asBool(args?.repair, false);
  const r = maintenanceFor(service).cleanupOrphans(repair);
  const lines = [
    repair ? "Orphan cleanup (repair)" : "Orphan cleanup (report only)",
    `- Memories missing vectors: ${r.memoriesWithoutVector.length}${r.memoriesWithoutVector.length ? " (run backfill / re-embed)" : ""}`,
    `- Dangling vectors (no memory): ${r.vectorsWithoutMemory.length}`,
    `- Memories missing FTS entries: ${r.memoriesWithoutFts.length}`,
    `- Dangling FTS entries (no memory): ${r.ftsWithoutMemory.length}`,
  ];
  if (repair) {
    lines.push(
      `- Removed dangling vectors: ${r.removedDanglingVectors}, FTS entries: ${r.removedDanglingFts}`,
    );
  } else if (
    r.vectorsWithoutMemory.length > 0 ||
    r.ftsWithoutMemory.length > 0
  ) {
    lines.push("Pass repair: true to remove dangling sidecar entries.");
  }
  return textResult(lines.join("\n"));
}

export async function handleMaintenanceHistory(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const limit = asInt(args?.limit, 50, 1, 1000);
  const entries = maintenanceFor(service).getHistory(limit);
  if (entries.length === 0) {
    return textResult("No maintenance history recorded yet.");
  }
  const lines = entries.map(
    (e) => `${e.timestamp} — ${e.action}: ${JSON.stringify(e.details)}`,
  );
  return textResult(`Maintenance history (most recent first):\n${lines.join("\n")}`);
}

export async function handleFindStaleMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const staleDays = asInt(args?.stale_days, 90, 1, 100000);
  const excludePinned = asBool(args?.exclude_pinned, true);
  const limit = asInt(args?.limit, 100, 1, 1000);
  let excludeImportance: MemoryImportance[] | undefined;
  if (args?.exclude_importance !== undefined) {
    try {
      excludeImportance = asArray<MemoryImportance>(args.exclude_importance, "exclude_importance");
    } catch (e) {
      return errorResult(errorText(e));
    }
  }

  const stale = await service.findStale({
    staleDays,
    excludePinned,
    excludeImportance,
    limit,
  });
  if (stale.length === 0) {
    return textResult(`No memories stale beyond ${staleDays} days.`);
  }
  const now = Date.now();
  const lines = stale.map((m) => {
    const last = m.lastAccessed ?? m.createdAt;
    const days = Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000));
    return `- ${m.id} | last accessed ${days}d ago | usefulness ${m.usefulness} | ${m.content.slice(0, 80)}`;
  });
  return textResult(`Stale memories (>${staleDays}d):\n${lines.join("\n")}`);
}

export async function handleSearchByTags(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let tags: string[];
  try {
    tags = asArray(args?.tags, "tags");
  } catch (e) {
    return errorResult(errorText(e));
  }
  if (tags.length === 0) return errorResult("tags must be a non-empty array");

  const tagMatch = args?.tag_match === "all" ? "all" : "any";
  const limit = asInt(args?.limit, 20, 1, 1000);
  const offset = asInt(args?.offset, 0, 0, 10000);

  const memories = await service.searchByTags(tags, tagMatch, limit, offset);
  if (memories.length === 0) {
    return textResult(`No memories found with tags [${tags.join(", ")}] (match: ${tagMatch}).`);
  }
  const blocks = memories.map((m) => formatMemoryDetail(m.id, m));
  return textResult(blocks.join("\n\n---\n\n"));
}

export async function handleGetSessionContext(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const scope = args?.scope === "all" ? "all" : "project";
  const maxChars = asInt(args?.max_chars, 4000, 100, 100000);
  const project = asOptionalString(args?.project);

  const ctx = await service.getSessionContext({ project, scope, maxChars });
  if (ctx.memories.length === 0) {
    return textResult(
      "No pinned or critical memories for this project. Pin important memories (update_memories with pinned: true) or mark them importance: \"critical\" to build a session-context menu.",
    );
  }
  const header = `Session context — ${ctx.memories.length} always-relevant memor${ctx.memories.length === 1 ? "y" : "ies"}${ctx.truncated ? " (truncated to fit budget)" : ""}:`;
  return textResult(`${header}\n${ctx.text}`);
}

export async function handleArchiveMemory(
  args: Record<string, unknown> | undefined,
  service: MemoryService,
  archived: boolean
): Promise<CallToolResult> {
  let ids: string[];
  try {
    ids = asArray(args?.ids, "ids");
  } catch (e) {
    return errorResult(errorText(e));
  }
  const changed = await service.setArchived(ids, archived);
  return textResult(
    `${archived ? "Archived" : "Unarchived"} ${changed} of ${ids.length} memories.`,
  );
}

export async function handleExpireMemories(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const ids = await service.expireMemories();
  if (ids.length === 0) return textResult("No expired memories to tombstone.");
  return textResult(
    `Tombstoned ${ids.length} expired memories:\n${ids.map((id) => `- ${id}`).join("\n")}`,
  );
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  switch (name) {
    case "store_memories":
      return handleStoreMemories(args, service);
    case "update_memories":
      return handleUpdateMemories(args, service);
    case "delete_memories":
      return handleDeleteMemories(args, service);
    case "search_memories":
      return handleSearchMemories(args, service);
    case "get_memories":
      return handleGetMemories(args, service);
    case "report_memory_usefulness":
      return handleReportMemoryUsefulness(args, service);
    case "set_waypoint":
      return handleSetWaypoint(args, service);
    case "get_waypoint":
      return handleGetWaypoint(args, service);
    case "index_conversations":
      return handleIndexConversations(args, service);
    case "list_indexed_sessions":
      return handleListIndexedSessions(args, service);
    case "reindex_session":
      return handleReindexSession(args, service);
    case "memory_health":
      return handleMemoryHealth(args, service);
    case "get_storage_stats":
      return handleStorageStats(args, service);
    case "optimize_database":
      return handleOptimizeDatabase(args, service);
    case "cleanup_orphans":
      return handleCleanupOrphans(args, service);
    case "get_maintenance_history":
      return handleMaintenanceHistory(args, service);
    case "find_stale_memories":
      return handleFindStaleMemories(args, service);
    case "search_by_tags":
      return handleSearchByTags(args, service);
    case "get_session_context":
      return handleGetSessionContext(args, service);
    case "archive_memory":
      return handleArchiveMemory(args, service, true);
    case "unarchive_memory":
      return handleArchiveMemory(args, service, false);
    case "expire_memories":
      return handleExpireMemories(args, service);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
