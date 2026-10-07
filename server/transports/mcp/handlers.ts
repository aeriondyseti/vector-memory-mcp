import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type MemoryService,
  PROACTIVE_CONFIDENCE_THRESHOLD,
  WRITE_DUPLICATE_SIMILARITY,
} from "../../core/memory.service";
import type { ConversationHistoryService } from "../../core/conversation.service";
import type {
  SearchIntent,
  MemoryAttributes,
  MemoryStatus,
  MemoryConfidence,
  MemoryImportance,
} from "../../core/memory";
import {
  coerceConfidence,
  coerceImportance,
  coerceStatus,
  DELETED_TOMBSTONE,
  MEMORY_CONFIDENCE_LEVELS,
  MEMORY_IMPORTANCE_LEVELS,
} from "../../core/memory";
import { MaintenanceService } from "../../core/maintenance.service";
import { BackupService } from "../../core/backup.service";
import { DocumentIngestionService } from "../../core/document-ingestion.service";
import { HandoffService } from "../../core/handoff.service";
import { GraphRepository } from "../../core/graph.repository";
import { GraphService } from "../../core/graph.service";
import type { Entity, GraphEdge } from "../../core/graph";
import { REFERENCE_EDGE_TYPES } from "../../core/graph";
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
  if (obj.context !== undefined) {
    a.context = typeof obj.context === "string" ? obj.context : null;
  }
  if (obj.occurred_at !== undefined) {
    a.occurredAt = obj.occurred_at === null ? null : parseDate(obj.occurred_at, "occurred_at") ?? null;
  }
  return a;
}

/** Resolve the on-disk path of the service's main database (from the connection). */
function dbPathFor(service: MemoryService): string {
  const db = service.getRepository().getDb();
  return (
    (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>)
      .find((r) => r.name === "main")?.file ?? ""
  );
}

/** Build a MaintenanceService bound to the service's live db connection. */
function maintenanceFor(service: MemoryService): MaintenanceService {
  const repo = service.getRepository();
  return new MaintenanceService(repo.getDb(), dbPathFor(service), repo);
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
    key?: unknown;
    status?: unknown;
    sources?: unknown;
  }>;
  try {
    memories = asArray(args?.memories, "memories");
  } catch (e) {
    return errorResult(errorText(e));
  }

  const allowDuplicates = args?.allow_duplicates === true;

  const ids: string[] = [];
  const notes: string[] = [];
  try {
    for (const item of memories) {
      const project = typeof item.project === "string" ? item.project : undefined;
      const attributes = parseAttributes(item as Record<string, unknown>);

      // A synthesis cites the memories it draws on; unknown ids are dropped.
      let metadata = lifecycleMetadata(item.metadata ?? {}, item.key, coerceStatus(item.status));
      if (Array.isArray(item.sources)) {
        const cited = [...new Set(item.sources.filter((s): s is string => typeof s === "string"))];
        const known = new Set((await service.getRepository().findByIds(cited)).map((m) => m.id));
        const unknown = cited.filter((id) => !known.has(id));
        if (unknown.length > 0) notes.push(`Ignored unknown source ids: ${unknown.join(", ")}.`);
        if (known.size > 0) metadata = { ...metadata, sources: cited.filter((id) => known.has(id)) };
      }

      const outcome = await service.storeUnlessDuplicate(
        item.content,
        metadata,
        item.embedding_text,
        project,
        attributes,
        { checkDuplicates: !allowDuplicates }
      );
      if (outcome.status === "duplicate") {
        notes.push(duplicateNote(outcome.existing.id, outcome.existing.content));
        continue;
      }
      ids.push(outcome.memory.id);
      if (outcome.possibleDuplicateOf.length > 0) {
        notes.push(
          `Stored ${outcome.memory.id}, but it closely matches ${outcome.possibleDuplicateOf.join(", ")}; ` +
            "review with find_duplicates."
        );
      }
      if (outcome.superseded.length > 0) {
        notes.push(
          `Stored ${outcome.memory.id} as the current "${outcome.memory.metadata.key}", replacing ` +
            `${outcome.superseded.join(", ")} (kept as history; search with include_superseded to see it).`
        );
      }
    }
  } catch (e) {
    return errorResult(errorText(e));
  }

  const stored =
    ids.length === 0
      ? []
      : [
          ids.length === 1
            ? `Memory stored with ID: ${ids[0]}`
            : `Stored ${ids.length} memories:\n${ids.map((id) => `- ${id}`).join("\n")}`,
        ];

  return {
    content: [{ type: "text", text: [...stored, ...notes].join("\n\n") }],
  };
}

/**
 * Fold the store/update `key` and `status` fields into metadata, where the
 * lifecycle reads them; explicit fields win over metadata's own.
 */
function lifecycleMetadata(
  metadata: Record<string, unknown>,
  key: unknown,
  status: string | undefined
): Record<string, unknown> {
  const next = { ...metadata };
  if (typeof key === "string") next.key = key;
  if (status !== undefined) next.status = status;
  return next;
}

/** The store_memories line for a write skipped as a duplicate. */
function duplicateNote(existingId: string, existingContent: string): string {
  const preview =
    existingContent.length > 200 ? `${existingContent.slice(0, 200)}…` : existingContent;
  return (
    `Not stored: duplicate of existing memory ${existingId}:\n  "${preview}"\n` +
    "To change that memory use update_memories; to store a separate copy anyway, " +
    "call store_memories again with allow_duplicates: true."
  );
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
    key?: unknown;
    status?: unknown;
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
      // A new key needs the existing metadata to land in, so fetch it first.
      let metadata = update.metadata;
      if (typeof update.key === "string") {
        const base = metadata ?? (await service.getRepository().findById(update.id))?.metadata ?? {};
        metadata = lifecycleMetadata(base, update.key, undefined);
      }
      memory = await service.update(update.id, {
        content: update.content,
        embeddingText: update.embedding_text,
        metadata,
        attributes: parseAttributes(update as Record<string, unknown>),
        status: coerceStatus(update.status),
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

  let status: MemoryStatus | undefined;
  try {
    status = coerceStatus(args?.status);
  } catch (e) {
    return errorResult(errorText(e));
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
    includeSuperseded: asBool(args?.include_superseded, false),
    includeResolved: asBool(args?.include_resolved, false),
    rerank: asBool(args?.rerank, true),
    ...(status ? { status } : {}),
    ...(typeof args?.during === "string" && args.during.trim() ? { during: args.during } : {}),
    useGraph: asBool(args?.include_graph, false),
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

  const formatted = results.map((r) => formatSearchResult(r));
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

  let result = `ID: ${memory.id}`;
  if (memory.context) result += `\nContext: ${memory.context}`;
  result += `\nContent: ${memory.content}`;
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

function formatSearchResult(r: SearchResult): string {
  let result = `[${r.source}] ID: ${r.id}\nConfidence: ${r.confidence.toFixed(2)}`;
  if (r.pinned) result += ` | 📌 pinned`;
  if (r.importance && r.importance !== "normal") result += ` | importance: ${r.importance}`;
  if (r.graphDistance != null) {
    result += ` | via graph (${r.graphDistance} ${r.graphDistance === 1 ? "link" : "links"})`;
  }
  if (r.project) {
    result += `\nProject: ${r.project}`;
  }
  if (r.context) {
    result += `\nContext: ${r.context}`;
  }
  if (r.occurredAt) {
    result += `\nOccurred: ${r.occurredAt.toISOString().slice(0, 10)}`;
  }
  result += `\nContent: ${r.content}`;
  if (r.sources) {
    result += `\nSources: ${r.sources.ids.join(", ")}`;
    if (r.sources.outdated > 0) result += ` (${r.sources.outdated} since replaced or deleted — the synthesis may be out of date)`;
  }
  if (r.history?.length) {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    result += `\nPreviously (newest first):`;
    for (const h of r.history) {
      const text = h.content.length > 200 ? `${h.content.slice(0, 200)}…` : h.content;
      result += `\n- ${text} (${day(h.createdAt)} – ${day(h.replacedAt)})`;
    }
  }
  if (r.metadata && Object.keys(r.metadata).length > 0) {
    result += `\nMetadata: ${JSON.stringify(r.metadata)}`;
  }
  if (r.source === "memory" && r.supersededBy) {
    result += r.supersededBy === DELETED_TOMBSTONE ? `\n[DELETED]` : `\n[SUPERSEDED by ${r.supersededBy}]`;
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

// ── Quality scoring (Feature 15) ──────────────────────────────────────

export async function handleScoreMemories(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const r = await service.scoreMemories();
  return textResult(
    `Rescored ${r.scored} memories. Average quality: ${r.averageScore.toFixed(3)}.`,
  );
}

// ── Episodic chains (Feature 23) ──────────────────────────────────────

export async function handleGetEpisode(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const episodeId = requireString(args, "episode_id");
  const memories = service.getEpisode(episodeId);
  if (memories.length === 0) {
    return textResult(`No memories in episode "${episodeId}".`);
  }
  const blocks = memories.map(
    (m, i) => `${i + 1}. [${m.id}] ${m.content}`,
  );
  return textResult(`Episode "${episodeId}" (${memories.length}):\n${blocks.join("\n")}`);
}

export async function handleListEpisodes(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const limit = asInt(args?.limit, 20, 1, 1000);
  const offset = asInt(args?.offset, 0, 0, 10000);
  const episodes = service.listEpisodes(limit, offset);
  if (episodes.length === 0) return textResult("No episodes recorded.");
  const lines = episodes.map(
    (e) => `- ${e.episodeId} — ${e.count} memories, last ${e.lastCreatedAt.toISOString()}`,
  );
  return textResult(`Episodes:\n${lines.join("\n")}`);
}

// ── Proactive context (Feature 24) ────────────────────────────────────

export async function handleProactiveContext(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const context = requireString(args, "context");
  const maxResults = asInt(args?.max_results, 5, 1, 50);
  const threshold =
    typeof args?.threshold === "number"
      ? Math.max(0, Math.min(1, args.threshold))
      : PROACTIVE_CONFIDENCE_THRESHOLD;
  const autoIngest = asBool(args?.auto_ingest, false);

  const results = await service.proactiveContext(context, maxResults, threshold, autoIngest);
  if (results.length === 0) {
    return textResult("No sufficiently relevant memories for the current context.");
  }
  const blocks = results.map(
    (r) => `[${r.confidence.toFixed(2)}] ${r.id}: ${r.content}`,
  );
  return textResult(`Relevant memories:\n${blocks.join("\n")}`);
}

// ── Tag management (Feature 16) ───────────────────────────────────────

export async function handleListTags(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const sortBy = args?.sort_by === "name" ? "name" : "count";
  const limit = asInt(args?.limit, 100, 1, 10000);
  const offset = asInt(args?.offset, 0, 0, 10000);
  const tags = service.listTags(sortBy, limit, offset);
  if (tags.length === 0) return textResult("No tags found.");
  return textResult(tags.map((t) => `${t.tag} (${t.count})`).join("\n"));
}

export async function handleRenameTag(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const oldTag = requireString(args, "old");
  const newTag = requireString(args, "new");
  const changed = await service.renameTag(oldTag, newTag);
  return textResult(`Renamed tag "${oldTag}" → "${newTag}" across ${changed} memories.`);
}

export async function handleMergeTags(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let sources: string[];
  try {
    sources = asArray(args?.sources, "sources");
  } catch (e) {
    return errorResult(errorText(e));
  }
  const target = requireString(args, "target");
  const changed = await service.mergeTags(sources, target);
  return textResult(`Merged tags [${sources.join(", ")}] → "${target}" across ${changed} memories.`);
}

export async function handleDeleteTag(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const tag = requireString(args, "tag");
  const changed = await service.deleteTag(tag);
  return textResult(`Removed tag "${tag}" from ${changed} memories.`);
}

// ── Duplicate detection & merge (Feature 14) ──────────────────────────

export async function handleFindDuplicates(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const threshold =
    typeof args?.similarity_threshold === "number"
      ? Math.max(0.5, Math.min(1, args.similarity_threshold))
      : 0.92;
  const clusters = service.findDuplicates(threshold);
  if (clusters.length === 0) {
    return textResult(`No duplicate clusters found at threshold ${threshold}.`);
  }
  const blocks = clusters.map(
    (c, i) =>
      `Cluster ${i + 1}: keep ${c.keepId}, duplicates: ${c.duplicateIds.join(", ")}`,
  );
  return textResult(`${clusters.length} duplicate clusters (threshold ${threshold}):\n${blocks.join("\n")}`);
}

export async function handleMergeDuplicates(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const keepId = requireString(args, "keep_id");
  let mergeIds: string[];
  try {
    mergeIds = asArray(args?.merge_ids, "merge_ids");
  } catch (e) {
    return errorResult(errorText(e));
  }
  const strategy =
    args?.merge_strategy === "keep_content" || args?.merge_strategy === "combine_content"
      ? args.merge_strategy
      : "keep_newest";
  const merged = await service.mergeDuplicates(keepId, mergeIds, strategy);
  if (!merged) return errorResult(`Memory ${keepId} not found`);
  return textResult(
    `Merged ${mergeIds.length} duplicates into ${keepId} (strategy: ${strategy}).`,
  );
}

export async function handleCleanupDuplicates(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const threshold =
    typeof args?.similarity_threshold === "number"
      ? Math.max(0.5, Math.min(1, args.similarity_threshold))
      : WRITE_DUPLICATE_SIMILARITY;
  const dryRun = args?.dry_run === true;
  const r = await service.cleanupDuplicates(threshold, dryRun);

  const lines = [
    dryRun
      ? `Would merge ${r.deleted} duplicate memories in ${r.clusters} clusters (dry run, threshold ${threshold}).`
      : `Cleaned up ${r.clusters} clusters: merged ${r.deleted} duplicate memories into their survivors (kept as history; search with include_superseded to see them).`,
  ];
  if (dryRun) {
    for (const p of r.plans.filter((p) => p.mergeIds.length > 0)) {
      lines.push(`- keep ${p.keepId}, merge: ${p.mergeIds.join(", ")}`);
    }
  }
  if (r.review > 0) {
    lines.push(
      "",
      `${r.review} near-duplicates left for review (merge them with merge_duplicates if they really are the same):`,
    );
    for (const p of r.plans) {
      for (const item of p.review) lines.push(`- ${item.id} vs ${p.keepId}: ${item.reason}`);
    }
  }
  return textResult(lines.join("\n"));
}

// ── Memory consolidation (Feature 18) ─────────────────────────────────

export async function handleConsolidateMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const action =
    args?.action === "run" || args?.action === "status" ? args.action : "recommend";
  const timeHorizon =
    args?.time_horizon === "daily" || args?.time_horizon === "monthly"
      ? args.time_horizon
      : "weekly";
  const r = await service.consolidateMemories(action, timeHorizon);
  const lines = [
    `Consolidation (${r.action}, ${r.timeHorizon}):`,
    `- Live memories: ${r.total} | Avg quality: ${r.averageQuality.toFixed(3)}`,
    `- Duplicate clusters: ${r.duplicateClusters} | Forget candidates: ${r.forgetCandidates}`,
  ];
  if (r.duplicatesForReview > 0) {
    lines.push(
      `- Near-duplicates left for review (not merged automatically): ${r.duplicatesForReview} — see cleanup_duplicates with dry_run: true`,
    );
  }
  if (r.action === "run") {
    lines.push(
      `- Rescored: ${r.rescored} | Compressed (merged): ${r.compressed} | Forgotten (archived): ${r.forgotten}`,
    );
  }
  return textResult(lines.join("\n"));
}

// ── Session handoff (Feature 20) ──────────────────────────────────────

function handoffFor(service: MemoryService): HandoffService {
  return new HandoffService(dbPathFor(service));
}

export async function handlePrepareHandoff(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let summary: string;
  try {
    summary = requireString(args, "summary");
  } catch (e) {
    return errorResult(errorText(e));
  }
  const arr = (key: string): string[] | undefined =>
    args?.[key] !== undefined ? asArray<string>(args[key], key) : undefined;

  let handoff;
  try {
    handoff = handoffFor(service).prepare({
      summary,
      completed: arr("completed"),
      inProgress: arr("in_progress"),
      keyDecisions: arr("key_decisions"),
      nextSteps: arr("next_steps"),
      memoryIds: arr("memory_ids"),
      branch: asOptionalString(args?.branch),
      project: asOptionalString(args?.project) ?? service.getProject(),
    });
  } catch (e) {
    return errorResult(errorText(e));
  }
  return textResult(`Handoff saved with id: ${handoff.id}`);
}

export async function handleResumeFromHandoff(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const id = asOptionalString(args?.handoff_id);
  const project = asOptionalString(args?.project) ?? service.getProject();
  const handoff = handoffFor(service).resume(id, project);
  if (!handoff) return textResult("No handoff found to resume.");
  return textResult(HandoffService.render(handoff));
}

export async function handleListHandoffs(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const limit = asInt(args?.limit, 20, 1, 1000);
  const project = asOptionalString(args?.project) ?? service.getProject();
  const handoffs = handoffFor(service).list(limit, project);
  if (handoffs.length === 0) return textResult("No handoffs recorded.");
  const lines = handoffs.map(
    (h) =>
      `- ${h.id} | ${h.createdAt}${h.resumedAt ? " (resumed)" : ""} — ${h.summary.slice(0, 80)}`,
  );
  return textResult(`Handoffs:\n${lines.join("\n")}`);
}

export async function handleGetStartupContext(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const query = asOptionalString(args?.query);
  const project = service.getProject();
  const latest = handoffFor(service).latest(project);

  const parts: string[] = [];
  if (latest) parts.push(HandoffService.render(latest));

  if (query) {
    const results = await service.search(query, "continuity", {
      limit: asInt(args?.max_memories, 5, 1, 50),
      includeHistory: false,
    });
    if (results.length > 0) {
      parts.push(
        `\n# Relevant Memories\n${results.map((r) => `- [${r.id}] ${r.content}`).join("\n")}`,
      );
    }
  }

  if (parts.length === 0) {
    return textResult("No handoff or matching memories for startup context.");
  }
  return textResult(parts.join("\n"));
}

// ── Backup & restore (Feature 26) ─────────────────────────────────────

function backupFor(service: MemoryService): BackupService {
  return new BackupService(dbPathFor(service));
}

export async function handleBackupCreate(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const info = backupFor(service).create(asOptionalString(args?.description));
  return textResult(
    `Backup created: ${info.id}\n- Path: ${info.path}\n- Size: ${formatBytes(info.sizeBytes)}\n- SHA-256: ${info.sha256}`,
  );
}

export async function handleBackupList(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const backups = backupFor(service).list();
  if (backups.length === 0) return textResult("No backups found.");
  const lines = backups.map(
    (b) => `- ${b.id} | ${formatBytes(b.sizeBytes)} | ${b.createdAt}${b.description ? ` | ${b.description}` : ""}`,
  );
  return textResult(`Backups (newest first):\n${lines.join("\n")}`);
}

export async function handleBackupVerify(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const id = requireString(args, "backup_id");
  const r = backupFor(service).verify(id);
  if (!r.exists) return textResult(`Backup ${id} not found.`);
  return textResult(
    r.valid
      ? `Backup ${id} is valid (SHA-256 matches).`
      : `Backup ${id} is CORRUPT: expected ${r.expectedSha256}, got ${r.actualSha256}.`,
  );
}

export async function handleBackupRestore(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const id = requireString(args, "backup_id");
  const confirm = asBool(args?.confirm, false);
  const r = backupFor(service).restore(id, confirm);
  if (!r.restored) {
    return textResult(
      r.reason === "confirmation required"
        ? "Restore requires confirm: true. A safety backup of the current database is taken automatically before restoring. NOTE: restart the server after restoring."
        : `Restore failed: ${r.reason}`,
    );
  }
  return textResult(
    `Restored from backup ${id}. Safety backup of the previous database: ${r.safetyBackupId}. Restart the server to use the restored database.`,
  );
}

export async function handleBackupPurge(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const keepLastN = asInt(args?.keep_last_n, 5, 0, 10000);
  const r = backupFor(service).purge(keepLastN);
  return textResult(`Purged ${r.deleted.length} old backups, kept the newest ${keepLastN}.`);
}

// ── Document ingestion (Feature 17) ───────────────────────────────────

export async function handleIngestDocument(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const filePath = asOptionalString(args?.file_path);
  const directoryPath = asOptionalString(args?.directory_path);
  if (!filePath && !directoryPath) {
    return errorResult("Provide either file_path or directory_path.");
  }
  let tags: string[] | undefined;
  if (args?.tags !== undefined) {
    try {
      tags = asArray(args.tags, "tags");
    } catch (e) {
      return errorResult(errorText(e));
    }
  }

  const ingestion = new DocumentIngestionService(service);
  let result;
  try {
    result = await ingestion.ingest({
      filePath,
      directoryPath,
      tags,
      chunkSize: typeof args?.chunk_size === "number" ? args.chunk_size : undefined,
      chunkOverlap: typeof args?.chunk_overlap === "number" ? args.chunk_overlap : undefined,
      extensions: args?.extensions !== undefined ? asArray<string>(args.extensions, "extensions") : undefined,
      maxFiles: typeof args?.max_files === "number" ? args.max_files : undefined,
      project: asOptionalString(args?.project),
    });
  } catch (e) {
    return errorResult(errorText(e));
  }

  const lines = [
    `Ingested ${result.filesProcessed} file(s) into ${result.chunks} memory chunks.`,
  ];
  if (result.errors.length > 0) {
    lines.push(`Errors (${result.errors.length}):`, ...result.errors.map((e) => `- ${e}`));
  }
  return textResult(lines.join("\n"));
}

// ── Knowledge graph (Feature 19) ──────────────────────────────────────

function graphFor(service: MemoryService): GraphService {
  const repo = new GraphRepository(service.getRepository().getDb());
  return new GraphService(repo, service.getEmbeddings());
}

function formatEntity(e: Entity): string {
  const props = Object.keys(e.properties).length > 0 ? ` ${JSON.stringify(e.properties)}` : "";
  return `[${e.type}] ${e.name} (${e.id})${props}`;
}

function formatEdge(e: GraphEdge): string {
  return `${e.sourceId} —${e.edgeType}→ ${e.targetId}${e.context ? ` (${e.context})` : ""} [${e.category}/${e.provenance}]`;
}

export async function handleGraphTool(
  name: string,
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const graph = graphFor(service);
  try {
    switch (name) {
      case "create_entity_type": {
        const t = graph.registerEntityType({
          name: requireString(args, "name"),
          description: requireString(args, "description"),
          defaultProperties: asObject(args?.default_properties),
          importanceBonus:
            typeof args?.importance_bonus === "number" ? args.importance_bonus : 0,
        });
        return textResult(`Entity type "${t.name}" registered.`);
      }
      case "update_entity_type": {
        const t = graph.updateEntityType(requireString(args, "name"), {
          description: asOptionalString(args?.description),
          defaultProperties: args?.default_properties !== undefined ? asObject(args.default_properties) : undefined,
          importanceBonus: typeof args?.importance_bonus === "number" ? args.importance_bonus : undefined,
        });
        return textResult(t ? `Entity type "${t.name}" updated.` : "Entity type not found.");
      }
      case "delete_entity_type":
        graph.deleteEntityType(requireString(args, "name"), asBool(args?.force, false));
        return textResult(`Entity type "${requireString(args, "name")}" deleted.`);
      case "list_entity_types": {
        const types = graph.listEntityTypes();
        if (types.length === 0) return textResult("No entity types registered.");
        return textResult(
          types
            .map((t) => `- ${t.name}${t.system ? " (system)" : ""}: ${t.description} — ${t.entityCount} entities`)
            .join("\n"),
        );
      }
      case "create_edge_type": {
        const t = graph.registerEdgeType({
          name: requireString(args, "name"),
          description: requireString(args, "description"),
          category: requireString(args, "category"),
          validSourceTypes: args?.valid_source_types !== undefined ? asArray<string>(args.valid_source_types, "valid_source_types") : null,
          validTargetTypes: args?.valid_target_types !== undefined ? asArray<string>(args.valid_target_types, "valid_target_types") : null,
        });
        return textResult(`Edge type "${t.name}" registered in category "${t.category}".`);
      }
      case "update_edge_type": {
        const t = graph.updateEdgeType(requireString(args, "name"), {
          description: asOptionalString(args?.description),
          validSourceTypes: args?.valid_source_types !== undefined ? asArray<string>(args.valid_source_types, "valid_source_types") : undefined,
          validTargetTypes: args?.valid_target_types !== undefined ? asArray<string>(args.valid_target_types, "valid_target_types") : undefined,
        });
        return textResult(t ? `Edge type "${t.name}" updated.` : "Edge type not found.");
      }
      case "delete_edge_type":
        graph.deleteEdgeType(requireString(args, "name"), asBool(args?.force, false));
        return textResult(`Edge type "${requireString(args, "name")}" deleted.`);
      case "list_edge_types": {
        const types = graph.listEdgeTypes(asOptionalString(args?.category));
        if (types.length === 0) return textResult("No edge types registered.");
        return textResult(
          types
            .map((t) => `- ${t.name} [${t.category}]${t.system ? " (system)" : ""}: ${t.description} — ${t.edgeCount} edges`)
            .join("\n"),
        );
      }
      case "store_entity": {
        const e = await graph.storeEntity(
          requireString(args, "type"),
          requireString(args, "name"),
          asObject(args?.properties),
        );
        return textResult(`Entity stored: ${formatEntity(e)}`);
      }
      case "get_entity": {
        const e = graph.getEntity(requireString(args, "id"), asOptionalString(args?.type));
        return textResult(e ? formatEntity(e) : "Entity not found.");
      }
      case "update_entity": {
        const e = await graph.updateEntity(requireString(args, "id"), asObject(args?.properties));
        return textResult(e ? `Entity updated: ${formatEntity(e)}` : "Entity not found.");
      }
      case "delete_entity":
        graph.deleteEntity(requireString(args, "id"));
        return textResult("Entity and its edges deleted.");
      case "list_entities": {
        const entities = graph.listEntities(
          asOptionalString(args?.type),
          asInt(args?.limit, 50, 1, 1000),
          asInt(args?.offset, 0, 0, 100000),
        );
        if (entities.length === 0) return textResult("No entities found.");
        return textResult(entities.map(formatEntity).join("\n"));
      }
      case "search_entities": {
        const entities = await graph.searchEntities(
          requireString(args, "query"),
          asOptionalString(args?.type),
          asInt(args?.limit, 10, 1, 100),
        );
        if (entities.length === 0) return textResult("No matching entities.");
        return textResult(
          entities.map((e) => `${formatEntity(e)} (sim ${e.similarity.toFixed(3)})`).join("\n"),
        );
      }
      case "link_entities": {
        const edge = await graph.linkEntities(
          requireString(args, "source_id"),
          requireString(args, "target_id"),
          requireString(args, "type"),
          asOptionalString(args?.context),
        );
        return textResult(`Linked: ${formatEdge(edge)}`);
      }
      case "unlink_entities":
        graph.unlinkEntities(requireString(args, "edge_id"));
        return textResult("Edge removed.");
      case "entity_graph": {
        const g = graph.entityGraph(
          requireString(args, "entity_id"),
          asInt(args?.depth, 1, 1, 5),
          asOptionalString(args?.type_filter),
        );
        return textResult(
          `Neighborhood (${g.nodes.length} nodes, ${g.edges.length} edges):\n` +
            `Nodes:\n${g.nodes.map(formatEntity).join("\n")}\n` +
            `Edges:\n${g.edges.map(formatEdge).join("\n")}`,
        );
      }
      case "search_entity_edges": {
        const edges = await graph.searchEntityEdges(
          requireString(args, "query"),
          asOptionalString(args?.type),
        );
        if (edges.length === 0) return textResult("No matching edges.");
        return textResult(edges.map(formatEdge).join("\n"));
      }
      case "lineage_link": {
        const edge = await graph.lineageLink(
          requireString(args, "from_id"),
          requireString(args, "to_id"),
          requireString(args, "type"),
          asOptionalString(args?.context),
        );
        return textResult(`Lineage edge created: ${formatEdge(edge)}`);
      }
      case "lineage_trace": {
        const direction =
          args?.direction === "forward" || args?.direction === "backward"
            ? args.direction
            : "both";
        const trace = graph.lineageTrace(
          requireString(args, "memory_id"),
          direction,
          asInt(args?.depth, 3, 1, 10),
        );
        if (trace.edges.length === 0) return textResult("No lineage edges found.");
        return textResult(`Lineage (${direction}):\n${trace.edges.map(formatEdge).join("\n")}`);
      }
      case "lineage_confirm":
        graph.lineageConfirm(requireString(args, "edge_id"));
        return textResult("Lineage edge confirmed.");
      case "lineage_reject":
        graph.lineageReject(requireString(args, "edge_id"));
        return textResult("Lineage edge rejected (deleted).");
      case "lineage_stats": {
        const s = graph.lineageStats();
        return textResult(
          `Lineage: ${s.total} edges\nBy type: ${JSON.stringify(s.byType)}\nBy provenance: ${JSON.stringify(s.byProvenance)}`,
        );
      }
      case "link_memory_to_entity": {
        const edge = await graph.linkMemoryToEntity(
          requireString(args, "memory_id"),
          requireString(args, "entity_id"),
          asStringLevel(args?.ref_type, REFERENCE_EDGE_TYPES),
        );
        return textResult(`Memory linked to entity: ${formatEdge(edge)}`);
      }
      case "get_entity_memories": {
        const ids = graph.getEntityMemories(requireString(args, "entity_id"));
        if (ids.length === 0) return textResult("No memories reference this entity.");
        return textResult(`Memories referencing this entity:\n${ids.map((id) => `- ${id}`).join("\n")}`);
      }
      default:
        return errorResult(`Unknown graph tool: ${name}`);
    }
  } catch (e) {
    return errorResult(errorText(e));
  }
}

const GRAPH_TOOL_NAMES = new Set([
  "create_entity_type", "update_entity_type", "delete_entity_type", "list_entity_types",
  "create_edge_type", "update_edge_type", "delete_edge_type", "list_edge_types",
  "store_entity", "get_entity", "update_entity", "delete_entity", "list_entities", "search_entities",
  "link_entities", "unlink_entities", "entity_graph", "search_entity_edges",
  "lineage_link", "lineage_trace", "lineage_confirm", "lineage_reject", "lineage_stats",
  "link_memory_to_entity", "get_entity_memories",
]);

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  if (GRAPH_TOOL_NAMES.has(name)) return handleGraphTool(name, args, service);
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
    case "score_memories":
      return handleScoreMemories(args, service);
    case "get_episode":
      return handleGetEpisode(args, service);
    case "list_episodes":
      return handleListEpisodes(args, service);
    case "proactive_context":
      return handleProactiveContext(args, service);
    case "list_tags":
      return handleListTags(args, service);
    case "rename_tag":
      return handleRenameTag(args, service);
    case "merge_tags":
      return handleMergeTags(args, service);
    case "delete_tag":
      return handleDeleteTag(args, service);
    case "find_duplicates":
      return handleFindDuplicates(args, service);
    case "merge_duplicates":
      return handleMergeDuplicates(args, service);
    case "cleanup_duplicates":
      return handleCleanupDuplicates(args, service);
    case "consolidate_memories":
      return handleConsolidateMemories(args, service);
    case "prepare_handoff":
      return handlePrepareHandoff(args, service);
    case "resume_from_handoff":
      return handleResumeFromHandoff(args, service);
    case "list_handoffs":
      return handleListHandoffs(args, service);
    case "get_startup_context":
      return handleGetStartupContext(args, service);
    case "backup_create":
      return handleBackupCreate(args, service);
    case "backup_list":
      return handleBackupList(args, service);
    case "backup_verify":
      return handleBackupVerify(args, service);
    case "backup_restore":
      return handleBackupRestore(args, service);
    case "backup_purge":
      return handleBackupPurge(args, service);
    case "ingest_document":
      return handleIngestDocument(args, service);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
