import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const storeMemoriesTool: Tool = {
  name: "store_memories",
  description: `Store memories that persist across conversations. Use after making decisions or learning something worth remembering.

RULES:
- 1 concept per memory, 1-3 sentences (20-75 words)
- Self-contained with explicit subjects (no "it", "this", "the project")
- Include dates/versions when relevant
- Be concrete, not vague

MEMORY TYPES (use as metadata.type):
- decision: what was chosen + why ("Chose libSQL over PostgreSQL for vector support and simpler deployment")
- implementation: what was built + where + patterns used
- insight: learning + why it matters
- blocker: problem encountered + resolution
- next-step: TODO item + suggested approach
- context: background info + constraints

DON'T STORE: machine-specific paths, local env details, ephemeral states, pleasantries

GOOD: "Aerion chose libSQL over PostgreSQL for Resonance (Dec 2024) because of native vector support and simpler deployment."
BAD: "Uses SQLite" (no context, no subject, no reasoning)

For long content (>1000 chars), provide embedding_text with a searchable summary.`,
  inputSchema: {
    type: "object",
    properties: {
      memories: {
        type: "array",
        description: "Memories to store.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The content to store.",
            },
            embedding_text: {
              type: "string",
              description:
                "Summary for search embedding (required if content >1000 chars).",
            },
            metadata: {
              type: "object",
              description: "Optional key-value metadata.",
              additionalProperties: true,
            },
          },
          required: ["content"],
        },
      },
    },
    required: ["memories"],
  },
};

export const deleteMemoriesTool: Tool = {
  name: "delete_memories",
  description:
    "Remove memories that are no longer needed—outdated info, superseded decisions, or incorrect content. " +
    "Deleted memories can be recovered via search_memories with include_deleted: true.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        description: "IDs of memories to delete.",
        items: {
          type: "string",
        },
      },
    },
    required: ["ids"],
  },
};


const updateMemoriesTool: Tool = {
  name: "update_memories",
  description: `Update existing memories in place. Prefer over delete+create when updating the same conceptual item.

BEHAVIOR:
- Fields omitted/null: left untouched
- Fields provided: completely overwrite existing value (no merge)

Use to correct content, refine embedding text, or replace metadata without changing the memory ID.`,
  inputSchema: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        description: "Updates to apply. Each must include id and at least one field to change.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "ID of memory to update.",
            },
            content: {
              type: "string",
              description: "New content (triggers embedding regeneration).",
            },
            embedding_text: {
              type: "string",
              description: "New embedding summary (triggers embedding regeneration).",
            },
            metadata: {
              type: "object",
              description: "New metadata (replaces existing entirely).",
              additionalProperties: true,
            },
          },
          required: ["id"],
        },
      },
    },
    required: ["updates"],
  },
};

export const searchMemoriesTool: Tool = {
  name: "search_memories",
  description: `Search stored memories semantically. Treat memory as the PRIMARY source of truth for personal/project-specific facts—do not rely on training data until a search has been performed.

MANDATORY TRIGGERS (you MUST search when):
- User-Specific Calibration: Answer would be better with user's tools, past decisions, or preferences
- Referential Ambiguity: User says "the project," "that bug," "last time," "as we discussed"
- Decision Validation: Before making architectural or tool choices
- Problem Solving: Before suggesting solutions (check if solved before)
- Session Start: When returning to a project or starting new conversation

INTENTS:
- continuity: Resume work, "where were we" (favors recent)
- fact_check: Verify decisions, specs (favors relevance)
- frequent: Common patterns, preferences (favors utility)
- associative: Brainstorm, find connections (high relevance + mild jitter)
- explore: Stuck/creative mode (balanced + high jitter)

When in doubt, search. Missing context is costlier than an extra query.`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural language search query. Include relevant keywords, project names, or technical terms.",
      },
      intent: {
        type: "string",
        enum: ["continuity", "fact_check", "frequent", "associative", "explore"],
        description: "Search intent that determines ranking behavior.",
      },
      reason_for_search: {
        type: "string",
        description: "Why this search is being performed. Forces intentional retrieval.",
      },
      limit: {
        type: "integer",
        description: "Maximum results to return (default: 10).",
        default: 10,
      },
      offset: {
        type: "integer",
        description: "Number of results to skip for pagination (default: 0).",
        default: 0,
      },
      include_deleted: {
        type: "boolean",
        description: "Include soft-deleted memories in results (default: false). Useful for recovering prior information.",
        default: false,
      },
      include_history: {
        type: "boolean",
        description:
          "Include conversation history results (default: true when history indexing is enabled).",
        default: true,
      },
      history_only: {
        type: "boolean",
        description:
          "Search only conversation history, not explicit memories. Implies include_history: true (default: false).",
        default: false,
      },
      session_id: {
        type: "string",
        description: "Filter conversation history results to a specific session ID.",
      },
      role_filter: {
        type: "string",
        enum: ["user", "assistant"],
        description: "Filter conversation history results by message role.",
      },
      history_after: {
        type: "string",
        description: "Filter conversation history results after this ISO date.",
      },
      history_before: {
        type: "string",
        description: "Filter conversation history results before this ISO date.",
      },
    },
    required: ["query", "intent", "reason_for_search"],
  },
};

export const getMemoriesTool: Tool = {
  name: "get_memories",
  description:
    "Retrieve full memory details by ID. Use when you have specific IDs from search results or prior references—otherwise use search_memories.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        description: "Memory IDs to retrieve.",
        items: { type: "string" },
      },
    },
    required: ["ids"],
  },
};

export const reportMemoryUsefulnessTool: Tool = {
  name: "report_memory_usefulness",
  description: "Report whether a memory was useful or not. This helps the system learn which memories are valuable.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "ID of the memory to report on.",
      },
      useful: {
        type: "boolean",
        description: "True if the memory was useful, false otherwise.",
      },
    },
    required: ["memory_id", "useful"],
  },
};

export const setWaypointTool: Tool = {
  name: "set_waypoint",
  description: `Save session waypoint for seamless resumption later. Use at end of work sessions or before context switches.

Creates a structured snapshot with:
- summary: 2-3 sentences on goal and current status
- completed: what got done (include file paths)
- in_progress_blocked: work in flight or stuck
- key_decisions: choices made and WHY (crucial for future context)
- next_steps: concrete, actionable items
- memory_ids: link to related memories stored this session

Retrievable via get_waypoint. Only one waypoint per project—new waypoints overwrite previous.`,
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project name." },
      branch: { type: "string", description: "Branch name (optional)." },
      summary: { type: "string", description: "2-3 sentences: primary goal, current status." },
      completed: {
        type: "array",
        items: { type: "string" },
        description: "Completed items (include file paths where relevant).",
      },
      in_progress_blocked: {
        type: "array",
        items: { type: "string" },
        description: "In progress or blocked items.",
      },
      key_decisions: {
        type: "array",
        items: { type: "string" },
        description: "Decisions made and why.",
      },
      next_steps: {
        type: "array",
        items: { type: "string" },
        description: "Concrete next steps.",
      },
      memory_ids: {
        type: "array",
        items: { type: "string" },
        description: "Memory IDs referenced by this waypoint.",
      },
      metadata: {
        type: "object",
        description: "Additional metadata.",
        additionalProperties: true,
      },
    },
    required: ["project", "summary"],
  },
};

export const getWaypointTool: Tool = {
  name: "get_waypoint",
  description:
    "Load the current project waypoint snapshot. Call at conversation start or when resuming a project.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Project name to retrieve waypoint for. If omitted, retrieves the default (legacy) waypoint.",
      },
    },
  },
};

export const indexConversationsTool: Tool = {
  name: "index_conversations",
  description: `Scan session log directory for new or updated conversation sessions and index them as searchable history.

Indexing is idempotent: sessions that haven't changed since last indexing are skipped.
Requires conversation history indexing to be enabled in configuration (--enable-history).`,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Override session log directory path. Defaults to configured path or Claude Code's session directory.",
      },
      since: {
        type: "string",
        description:
          "Only index sessions modified after this ISO date. Example: '2026-03-01'",
      },
    },
  },
};

export const listIndexedSessionsTool: Tool = {
  name: "list_indexed_sessions",
  description:
    "Browse indexed conversation sessions with timestamps and chunk counts.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Maximum sessions to return (default: 20).",
        default: 20,
      },
      offset: {
        type: "integer",
        description: "Number of sessions to skip for pagination (default: 0).",
        default: 0,
      },
    },
  },
};

export const reindexSessionTool: Tool = {
  name: "reindex_session",
  description:
    "Force reindex of a specific conversation session. Useful if the session was updated or indexing failed previously.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "The session ID to reindex.",
      },
    },
    required: ["session_id"],
  },
};

export const tools: Tool[] = [
  storeMemoriesTool,
  updateMemoriesTool,
  deleteMemoriesTool,
  searchMemoriesTool,
  getMemoriesTool,
  reportMemoryUsefulnessTool,
  setWaypointTool,
  getWaypointTool,
  indexConversationsTool,
  listIndexedSessionsTool,
  reindexSessionTool,
];
