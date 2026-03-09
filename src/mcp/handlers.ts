import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryService } from "../services/memory.service.js";
import type { ConversationHistoryService } from "../services/conversation-history.service.js";
import type { SearchIntent } from "../types/memory.js";
import type { SearchResult } from "../types/conversation-history.js";

/**
 * Guard: returns the ConversationHistoryService or an error CallToolResult.
 */
function requireHistoryService(
  service: MemoryService,
): ConversationHistoryService | CallToolResult {
  const historyService = service.getConversationHistory();
  if (!historyService) {
    return {
      content: [{
        type: "text",
        text: "Conversation history indexing is not enabled. Set conversationHistory.enabled = true in config.",
      }],
      isError: true,
    };
  }
  return historyService;
}

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
  const includeHistory = (args?.include_history as boolean) ?? false;
  const historyOnly = (args?.history_only as boolean) ?? false;

  if (includeHistory && historyOnly) {
    return {
      content: [{
        type: "text",
        text: "Cannot set both include_history and history_only to true. Use history_only for conversation history only, or include_history to merge with memories.",
      }],
      isError: true,
    };
  }

  // History-only: search only conversation history via the history service
  if (historyOnly) {
    const result = requireHistoryService(service);
    if ("content" in result) return result;
    const historyResults = await result.search(query, limit);
    if (historyResults.length === 0) {
      return {
        content: [{ type: "text", text: "No conversation history found matching your query." }],
      };
    }
    return {
      content: [{ type: "text", text: historyResults.map((r) => formatSearchResult(r)).join("\n\n---\n\n") }],
    };
  }

  // Unified search: merge memories + history
  if (includeHistory) {
    const results = await service.searchUnified(query, intent, limit, includeDeleted);
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No results found matching your query." }],
      };
    }
    return {
      content: [{ type: "text", text: results.map((r) => formatSearchResult(r, includeDeleted)).join("\n\n---\n\n") }],
    };
  }

  // Default: memory-only search (original behavior)
  const memories = await service.search(query, intent, limit, includeDeleted);

  if (memories.length === 0) {
    return {
      content: [{ type: "text", text: "No memories found matching your query." }],
    };
  }

  const results = memories.map((mem) => {
    let result = `ID: ${mem.id}\nContent: ${mem.content}`;
    if (Object.keys(mem.metadata).length > 0) {
      result += `\nMetadata: ${JSON.stringify(mem.metadata)}`;
    }
    if (includeDeleted && mem.supersededBy) {
      result += `\n[DELETED]`;
    }
    return result;
  });

  return {
    content: [{ type: "text", text: results.join("\n\n---\n\n") }],
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
  if (Object.keys(memory.metadata).length > 0) {
    result += `\nMetadata: ${JSON.stringify(memory.metadata)}`;
  }
  result += `\nCreated: ${memory.createdAt.toISOString()}`;
  result += `\nUpdated: ${memory.updatedAt.toISOString()}`;
  if (memory.supersededBy) {
    result += `\nSuperseded by: ${memory.supersededBy}`;
  }
  return result;
}

/**
 * Format a unified SearchResult (memory or history) for display.
 * TODO: The default memory-only search path in handleSearchMemories formats results inline
 * with similar logic but without the "Source:" label. Consolidating would add "Source: memory"
 * to existing output, which may break consumers that parse it. (#5)
 */
function formatSearchResult(result: SearchResult, includeDeleted: boolean = false): string {
  if (result.source === "memory") {
    let text = `ID: ${result.id}\nSource: memory\nContent: ${result.content}`;
    if (Object.keys(result.metadata).length > 0) {
      text += `\nMetadata: ${JSON.stringify(result.metadata)}`;
    }
    if (includeDeleted && result.supersededBy) {
      text += `\n[DELETED]`;
    }
    return text;
  }
  // conversation_history
  let text = `ID: ${result.id}\nSource: conversation_history\nSession: ${result.sessionId}\nRole: ${result.role}\nTimestamp: ${result.timestamp.toISOString()}\nContent: ${result.content}`;
  if (Object.keys(result.metadata).length > 0) {
    text += `\nMetadata: ${JSON.stringify(result.metadata)}`;
  }
  return text;
}

export async function handleGetMemories(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const ids = args?.ids as string[];

  const blocks: string[] = [];
  for (const id of ids) {
    const memory = await service.get(id);
    blocks.push(formatMemoryDetail(id, memory));
  }

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

export async function handleStoreCheckpoint(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const memory = await service.storeCheckpoint({
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
    content: [{ type: "text", text: `Checkpoint stored with memory ID: ${memory.id}` }],
  };
}

export async function handleGetCheckpoint(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const checkpoint = await service.getLatestCheckpoint();

  if (!checkpoint) {
    return {
      content: [{ type: "text", text: "No stored checkpoint found." }],
    };
  }

  // Fetch referenced memories if any
  const memoryIds = (checkpoint.metadata.memory_ids as string[] | undefined) ?? [];
  let memoriesSection = "";

  if (memoryIds.length > 0) {
    const memories: string[] = [];
    for (const id of memoryIds) {
      const memory = await service.get(id);
      if (memory) {
        memories.push(`### Memory: ${id}\n${memory.content}`);
      }
    }
    if (memories.length > 0) {
      memoriesSection = `\n\n## Referenced Memories\n\n${memories.join("\n\n")}`;
    }
  }

  return {
    content: [{ type: "text", text: checkpoint.content + memoriesSection }],
  };
}

export async function handleIndexConversations(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const result = requireHistoryService(service);
  if ("content" in result) return result;

  const path = args?.path as string | undefined;
  const summary = await result.indexConversations(path);

  return {
    content: [{
      type: "text",
      text: `Indexing complete.\n- Sessions discovered: ${summary.sessionsDiscovered}\n- Sessions indexed: ${summary.sessionsIndexed}\n- Sessions skipped (unchanged): ${summary.sessionsSkipped}\n- Messages indexed: ${summary.messagesIndexed}`,
    }],
  };
}

export async function handleListIndexedSessions(
  _args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const result = requireHistoryService(service);
  if ("content" in result) return result;

  const sessions = await result.listIndexedSessions();

  if (sessions.length === 0) {
    return {
      content: [{ type: "text", text: "No indexed sessions found. Run index_conversations first." }],
    };
  }

  const lines = sessions.map((s) => {
    let line = `Session: ${s.sessionId}\n  Messages: ${s.messageCount}\n  First: ${s.firstMessageAt.toISOString()}\n  Last: ${s.lastMessageAt.toISOString()}\n  Indexed: ${s.indexedAt.toISOString()}`;
    if (s.project) line += `\n  Project: ${s.project}`;
    if (s.gitBranch) line += `\n  Branch: ${s.gitBranch}`;
    return line;
  });

  return {
    content: [{ type: "text", text: `${sessions.length} indexed session(s):\n\n${lines.join("\n\n")}` }],
  };
}

export async function handleReindexSession(
  args: Record<string, unknown> | undefined,
  service: MemoryService
): Promise<CallToolResult> {
  const result = requireHistoryService(service);
  if ("content" in result) return result;

  const sessionId = args?.session_id as string;
  const summary = await result.reindexSession(sessionId);

  return {
    content: [{
      type: "text",
      text: `Reindex complete for session ${sessionId}.\n- Messages indexed: ${summary.messagesIndexed}`,
    }],
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
    case "store_checkpoint":
      return handleStoreCheckpoint(args, service);
    case "get_checkpoint":
      return handleGetCheckpoint(args, service);
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
