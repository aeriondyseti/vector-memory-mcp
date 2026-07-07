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
            project: {
              type: "string",
              description:
                "Project to tag this memory with (canonical absolute path). " +
                "Defaults to the current project — only pass this to file a memory under a different project.",
            },
            pinned: {
              type: "boolean",
              description:
                "Pin this memory: protected from deletion/cleanup unless force is used, and surfaced in get_session_context.",
            },
            archived: {
              type: "boolean",
              description: "Archive this memory: excluded from search unless include_archived is set.",
            },
            confidence: {
              type: "string",
              enum: ["uncertain", "likely", "confirmed", "verified"],
              description: "Confidence level in this memory's accuracy.",
            },
            importance: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
              description:
                "Importance level. 'critical' implies pin-protection against deletion.",
            },
            expires_at: {
              type: "string",
              description:
                "ISO date after which this memory auto-expires (excluded from search). Omit for no expiry.",
            },
            ttl_seconds: {
              type: "integer",
              description:
                "Convenience alternative to expires_at: seconds from now until expiry.",
            },
            episode_id: {
              type: "string",
              description: "Group this memory into a named episode (episodic chains).",
            },
            sequence_number: {
              type: "integer",
              description: "Ordering position within the episode.",
            },
            preceding_memory_id: {
              type: "string",
              description: "ID of the memory that temporally precedes this one in the episode.",
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
    "Remove memories by ID, tag, and/or creation-date range. Deleted memories can be recovered via " +
    "search_memories with include_deleted: true.\n\n" +
    "Provide at least one selector (ids, tags, after/before/time_expr). Pinned and 'critical'-importance " +
    "memories are protected unless force: true. Use dry_run: true to preview what would be deleted.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        description: "IDs of memories to delete.",
        items: { type: "string" },
      },
      tags: {
        type: "array",
        description: "Delete memories carrying these tags (metadata.tags).",
        items: { type: "string" },
      },
      tag_match: {
        type: "string",
        enum: ["any", "all"],
        description: "Whether a memory must match any (default) or all of the given tags.",
      },
      after: { type: "string", description: "Delete memories created after this ISO date." },
      before: { type: "string", description: "Delete memories created before this ISO date." },
      time_expr: {
        type: "string",
        description: "Relative time filter (e.g. 'past 30 days'), resolved to 'after'.",
      },
      dry_run: {
        type: "boolean",
        description: "Preview matches without deleting (returns count + IDs). Default false.",
      },
      force: {
        type: "boolean",
        description: "Include pinned/critical memories in the deletion. Default false.",
      },
    },
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
            pinned: { type: "boolean", description: "Pin/unpin this memory." },
            archived: { type: "boolean", description: "Archive/unarchive this memory." },
            confidence: {
              type: "string",
              enum: ["uncertain", "likely", "confirmed", "verified"],
              description: "Set the confidence level.",
            },
            importance: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
              description: "Set the importance level.",
            },
            expires_at: {
              type: "string",
              description: "Set an ISO expiry date, or null to clear it.",
            },
            ttl_seconds: {
              type: "integer",
              description: "Set expiry to this many seconds from now.",
            },
            episode_id: { type: "string", description: "Set/clear the episode grouping." },
            sequence_number: { type: "integer", description: "Set the episode sequence position." },
            preceding_memory_id: {
              type: "string",
              description: "Set/clear the temporal predecessor.",
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

When in doubt, search. Missing context is costlier than an extra query.

SCOPE: Memories are stored globally across all projects. By default, search covers every project (results from the current project rank slightly higher and each result carries its project path). Pass scope: "project" when the query is clearly specific to the current repo — it cuts cross-project noise and scan cost.`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural language search query. Include relevant keywords, project names, or technical terms.",
      },
      scope: {
        type: "string",
        description:
          'Project scope: "all" (default) searches every project with a ranking boost for the current one; ' +
          '"project" restricts to the current project; or pass an explicit canonical project path ' +
          '(e.g. "/home/user/Development/other-repo") to search that project only.',
        default: "all",
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
      after: {
        type: "string",
        description:
          "Filter memories created after this ISO date (e.g. '2025-06-01'). Applies to both memories and conversation history.",
      },
      before: {
        type: "string",
        description:
          "Filter memories created before this ISO date (e.g. '2026-01-01'). Applies to both memories and conversation history.",
      },
      time_expr: {
        type: "string",
        description:
          "Natural relative time filter, resolved to 'after' date. Examples: 'past 7 days', 'last 2 weeks', 'past 3 hours'. Ignored if explicit 'after' is provided.",
      },
      include_archived: {
        type: "boolean",
        description: "Include archived memories in results (default: false).",
      },
      include_expired: {
        type: "boolean",
        description: "Include expired (TTL-passed) memories in results (default: false).",
      },
      min_confidence: {
        type: "string",
        enum: ["uncertain", "likely", "confirmed", "verified"],
        description: "Only return memories at or above this confidence level.",
      },
      min_importance: {
        type: "string",
        enum: ["low", "normal", "high", "critical"],
        description: "Only return memories at or above this importance level.",
      },
      type: {
        type: "string",
        description: "Only return memories whose metadata.type equals this value.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Only return memories carrying these tags (metadata.tags).",
      },
      tag_match: {
        type: "string",
        enum: ["any", "all"],
        description: "Whether results must match any (default) or all of the given tags.",
      },
      max_response_chars: {
        type: "integer",
        description:
          "Cap the response size, truncating at whole-memory boundaries with an omitted-count notice. 0 = unlimited (default).",
      },
      mode: {
        type: "string",
        enum: ["semantic", "exact", "hybrid"],
        description:
          "Ranking mode: 'semantic' (default, vector + keyword), 'exact' (keyword/FTS only), or 'hybrid' (semantic blended with proven usefulness).",
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
      project: {
        type: "string",
        description:
          "Project to save the waypoint under. Defaults to the current project (detected from cwd) — usually omit this.",
      },
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
    required: ["summary"],
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
          "Project to retrieve the waypoint for (canonical absolute path). " +
          "Defaults to the current project — only pass this to read another project's waypoint.",
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

export const memoryHealthTool: Tool = {
  name: "memory_health",
  description:
    "Report memory store health: total/live/deleted counts, archived/pinned/expired counts, average usefulness, conversation chunks, schema version, and database path.",
  inputSchema: { type: "object", properties: {} },
};

export const getStorageStatsTool: Tool = {
  name: "get_storage_stats",
  description:
    "Report on-disk storage: database and WAL file sizes, page count/size, freelist (fragmentation estimate), and per-table row counts.",
  inputSchema: { type: "object", properties: {} },
};

export const optimizeDatabaseTool: Tool = {
  name: "optimize_database",
  description:
    "Reclaim space and refresh query-planner stats by running SQLite VACUUM + ANALYZE. Recommended after large bulk deletes. Records to the maintenance history.",
  inputSchema: { type: "object", properties: {} },
};

export const cleanupOrphansTool: Tool = {
  name: "cleanup_orphans",
  description:
    "Detect inconsistencies between the memories table and its vector/FTS sidecars. Report-only by default; pass repair: true to remove dangling sidecar entries (never deletes memories).",
  inputSchema: {
    type: "object",
    properties: {
      repair: {
        type: "boolean",
        description: "Remove dangling vector/FTS entries that have no matching memory. Default false.",
      },
    },
  },
};

export const getMaintenanceHistoryTool: Tool = {
  name: "get_maintenance_history",
  description: "List recorded maintenance actions (optimize/cleanup) with timestamps and details, most recent first.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Maximum entries to return (default: 50)." },
    },
  },
};

export const findStaleMemoriesTool: Tool = {
  name: "find_stale_memories",
  description:
    "Find memories not accessed within a threshold, to review for archiving or deletion. Excludes pinned memories by default.",
  inputSchema: {
    type: "object",
    properties: {
      stale_days: { type: "integer", description: "Days since last access to consider stale (default: 90)." },
      exclude_pinned: { type: "boolean", description: "Exclude pinned memories (default: true)." },
      exclude_importance: {
        type: "array",
        items: { type: "string", enum: ["low", "normal", "high", "critical"] },
        description: "Importance levels to exclude from results (e.g. ['high','critical']).",
      },
      limit: { type: "integer", description: "Maximum results (default: 100)." },
    },
  },
};

export const searchByTagsTool: Tool = {
  name: "search_by_tags",
  description:
    "Retrieve memories by tag without a semantic query, ordered by recency. Use search_memories for relevance-ranked retrieval.",
  inputSchema: {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags to match against metadata.tags.",
      },
      tag_match: {
        type: "string",
        enum: ["any", "all"],
        description: "Match any (default) or all of the given tags.",
      },
      limit: { type: "integer", description: "Maximum results (default: 20)." },
      offset: { type: "integer", description: "Results to skip for pagination (default: 0)." },
    },
    required: ["tags"],
  },
};

export const getSessionContextTool: Tool = {
  name: "get_session_context",
  description:
    "Return the always-relevant memories (pinned, or importance 'critical') for the current project as a compact, character-budgeted summary suitable for injecting at session start. Complements query-time search: important context loads without an explicit query.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project to build context for (canonical path). Defaults to the current project.",
      },
      scope: {
        type: "string",
        enum: ["project", "all"],
        description: "'project' (default) for the current/given project only, or 'all' across projects.",
      },
      max_chars: {
        type: "integer",
        description: "Character budget for the summary (default: 4000). Truncates at whole-memory boundaries.",
      },
    },
  },
};

export const archiveMemoryTool: Tool = {
  name: "archive_memory",
  description:
    "Archive memories: excluded from search by default (unlike deletion, archived memories remain first-class and are restored with unarchive_memory). Use for memories that are no longer active but worth keeping.",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, description: "Memory IDs to archive." },
    },
    required: ["ids"],
  },
};

export const unarchiveMemoryTool: Tool = {
  name: "unarchive_memory",
  description: "Restore archived memories so they appear in search again.",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, description: "Memory IDs to unarchive." },
    },
    required: ["ids"],
  },
};

export const expireMemoriesTool: Tool = {
  name: "expire_memories",
  description:
    "Tombstone (soft-delete) every memory whose TTL (expires_at) has passed. Expired memories are already hidden from search; this reclaims them on demand.",
  inputSchema: { type: "object", properties: {} },
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
  memoryHealthTool,
  getStorageStatsTool,
  optimizeDatabaseTool,
  cleanupOrphansTool,
  getMaintenanceHistoryTool,
  findStaleMemoriesTool,
  searchByTagsTool,
  getSessionContextTool,
  archiveMemoryTool,
  unarchiveMemoryTool,
  expireMemoriesTool,
];
