import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryService } from "../../core/memory.service";
import type { ConversationHistoryService } from "../../core/conversation.service";
import type { SearchIntent } from "../../core/memory";
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

export async function handleStoreMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  let memories: Array<{
    content: string;
    embedding_text?: string;
    metadata?: Record<string, unknown>;
  }>;
  try {
    memories = asArray(args?.memories, "memories");
  } catch (e) {
    return errorResult(errorText(e));
  }

  const ids: string[] = [];
  for (const item of memories) {
    const memory = await service.store(
      item.content,
      item.metadata ?? {},
      item.embedding_text
    );
    ids.push(memory.id);
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
  let ids: string[];
  try {
    ids = asArray(args?.ids, "ids");
  } catch (e) {
    return errorResult(errorText(e));
  }
  const results: string[] = [];

  for (const id of ids) {
    const success = await service.delete(id);
    results.push(
      success ? `Memory ${id} deleted successfully` : `Memory ${id} not found`
    );
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

    const memory = await service.update(update.id, {
      content: update.content,
      embeddingText: update.embedding_text,
      metadata: update.metadata,
    });

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
  const intent = (args?.intent as SearchIntent) ?? "fact_check";
  const limit = (args?.limit as number) ?? 10;
  const offset = (args?.offset as number) ?? 0;
  const includeDeleted = (args?.include_deleted as boolean) ?? false;
  const historyOnly = (args?.history_only as boolean) ?? false;
  // history_only implies include_history
  const includeHistory = historyOnly ? true : (args?.include_history as boolean | undefined);

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

  const results = await service.search(query, intent, {
    limit,
    includeDeleted,
    includeHistory,
    historyOnly,
    historyFilters,
    offset,
    after: dateFilters.after,
    before: dateFilters.before,
  });

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "No results found matching your query." }],
    };
  }

  const formatted = results.map((r) => formatSearchResult(r, includeDeleted));

  return {
    content: [{ type: "text", text: formatted.join("\n\n---\n\n") }],
  };
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
  result += `\nCreated: ${memory.createdAt.toISOString()}`;
  result += `\nUpdated: ${memory.updatedAt.toISOString()}`;
  if (memory.supersededBy) {
    result += `\nSuperseded by: ${memory.supersededBy}`;
  }
  return result;
}

function formatSearchResult(r: SearchResult, includeDeleted: boolean): string {
  let result = `[${r.source}] ID: ${r.id}\nConfidence: ${r.confidence.toFixed(2)}\nContent: ${r.content}`;
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
  let project: string;
  let summary: string;
  try {
    project = requireString(args, "project");
    summary = requireString(args, "summary");
  } catch (e) {
    return errorResult(errorText(e));
  }

  const memory = await service.setWaypoint({
    project,
    branch: args?.branch as string | undefined,
    summary,
    completed: (args?.completed as string[] | undefined) ?? [],
    in_progress_blocked: (args?.in_progress_blocked as string[] | undefined) ?? [],
    key_decisions: (args?.key_decisions as string[] | undefined) ?? [],
    next_steps: (args?.next_steps as string[] | undefined) ?? [],
    memory_ids: (args?.memory_ids as string[] | undefined) ?? [],
    metadata: (args?.metadata as Record<string, unknown>) ?? {},
  });

  return {
    content: [{ type: "text", text: `Waypoint stored with memory ID: ${memory.id}` }],
  };
}

export async function handleGetWaypoint(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const project = args?.project as string | undefined;
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
    sessionId: args?.session_id as string | undefined,
    role: args?.role_filter as string | undefined,
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

  const path = args?.path as string | undefined;
  const sinceStr = args?.since as string | undefined;
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

  const limit = (args?.limit as number) ?? 20;
  const offset = (args?.offset as number) ?? 0;
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

  const sessionId = args?.session_id as string | undefined;
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
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
