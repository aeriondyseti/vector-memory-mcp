import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryService } from "../services/memory.service.js";
import type { ConversationHistoryService } from "../services/conversation.service.js";
import type { SearchIntent } from "../types/memory.js";
import type { HistoryFilters, SearchResult } from "../types/conversation.js";

export async function handleStoreMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const memories = args?.memories as Array<{
    content: string;
    embedding_text?: string;
    metadata?: Record<string, unknown>;
  }>;

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
  const ids = args?.ids as string[];
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
  const updates = args?.updates as Array<{
    id: string;
    content?: string;
    embedding_text?: string;
    metadata?: Record<string, unknown>;
  }>;

  const results: string[] = [];

  for (const update of updates) {
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
  const query = args?.query as string;
  const intent = (args?.intent as SearchIntent) ?? "fact_check";
  const limit = (args?.limit as number) ?? 10;
  const includeDeleted = (args?.include_deleted as boolean) ?? false;
  const historyOnly = (args?.history_only as boolean) ?? false;
  // history_only implies include_history
  const includeHistory = historyOnly ? true : (args?.include_history as boolean | undefined);

  const results = await service.search(query, intent, limit, includeDeleted, {
    includeHistory,
    historyOnly,
    historyFilters: parseHistoryFilters(args),
  });

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "No results found matching your query." }],
    };
  }

  const formatted = results.map((r: SearchResult) => {
    let result = `[${r.source}] ID: ${r.id}\nContent: ${r.content}`;
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
  });

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

export async function handleGetMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const ids = args?.ids as string[];

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
  const memoryId = args?.memory_id as string;
  const useful = args?.useful as boolean;

  const memory = await service.vote(memoryId, useful ? 1 : -1);

  if (!memory) {
    return {
      content: [{ type: "text", text: `Memory ${memoryId} not found` }],
      isError: true,
    };
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
  const memory = await service.setWaypoint({
    project: args?.project as string,
    branch: args?.branch as string | undefined,
    summary: args?.summary as string,
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
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const waypoint = await service.getLatestWaypoint();

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
    after: args?.history_after
      ? new Date(args.history_after as string)
      : undefined,
    before: args?.history_before
      ? new Date(args.history_before as string)
      : undefined,
  };
}

function requireConversationService(
  service: MemoryService
): { service: ConversationHistoryService } | { error: CallToolResult } {
  const conversationService = service.getConversationService();
  if (!conversationService) {
    return {
      error: {
        content: [
          {
            type: "text",
            text: "Conversation history indexing is not enabled. Enable it with --enable-history.",
          },
        ],
        isError: true,
      },
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
    return {
      content: [{ type: "text", text: "session_id is required" }],
      isError: true,
    };
  }
  const result = await conversationService.reindexSession(sessionId);

  if (!result.success) {
    return {
      content: [{ type: "text", text: `Reindex failed: ${result.error}` }],
      isError: true,
    };
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
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
