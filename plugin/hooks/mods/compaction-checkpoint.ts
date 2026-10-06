/**
 * Compaction checkpoint mod (Claude Code function hooks).
 *
 * Wraps every compaction of the main conversation:
 *   1. before — forks the session (prompt-cached) to draft a waypoint and
 *      saves it through the plugin's MCP server (`set_waypoint`)
 *   2. compacts — `next(e)` runs the engine's own compaction
 *   3. after — reads the waypoint back (`get_waypoint`) and appends it to the
 *      compacted conversation, so the model resumes with it in context
 *
 * Every step degrades to a plain compaction: a failed fork, an unreachable
 * server or a vetoed compaction never blocks or alters `/compact`.
 *
 * Loaded by Claude Code builds with the mod system (via `modules` in
 * hooks.json); older builds ignore it and keep the classic command hooks.
 */

import type { EngineInterface, Register, SessionMessage } from "claude-code";

/** The server's key in plugin/.mcp.json. */
const MCP_SERVER_KEY = "vector-memory";

const LABEL = "vector-memory";

export const CHECKPOINT_PROMPT = `The conversation is about to be compacted. Write a checkpoint of this session so work can resume seamlessly afterwards.

Reply with ONLY a JSON object (no prose, no code fence) of this shape:
{
  "branch": "current git branch, or omit if unknown",
  "summary": "2-3 sentences: the primary goal and the current status",
  "completed": ["specific completed items, with file paths where relevant"],
  "in_progress_blocked": ["work in flight with its current state, or blockers and what they need"],
  "key_decisions": ["decisions made and WHY"],
  "next_steps": ["concrete, actionable next steps, in priority order"]
}

Be thorough but concise: capture what would take time to reconstruct, skip what is obvious from the code.`;

export interface WaypointDraft {
  branch?: string;
  summary: string;
  completed: string[];
  in_progress_blocked: string[];
  key_decisions: string[];
  next_steps: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

/** Parse the fork's reply into `set_waypoint` arguments; null when unusable. */
export function parseWaypointDraft(text: string): WaypointDraft | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") return null;

  return {
    ...(typeof obj.branch === "string" && obj.branch.trim() !== ""
      ? { branch: obj.branch.trim() }
      : {}),
    summary: obj.summary.trim(),
    completed: stringList(obj.completed),
    in_progress_blocked: stringList(obj.in_progress_blocked),
    key_decisions: stringList(obj.key_decisions),
    next_steps: stringList(obj.next_steps),
  };
}

function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Draft and store a waypoint; resolves true once the server stored it. */
async function saveCheckpoint($: EngineInterface, server: string): Promise<boolean> {
  const reply = await $.model.fork({ prompt: CHECKPOINT_PROMPT });
  if (!reply.isAnswered) {
    $.ui.log(`${LABEL}: checkpoint not drafted (${reply.reason})`);
    return false;
  }

  const draft = parseWaypointDraft(reply.text);
  if (!draft) {
    $.ui.log(`${LABEL}: checkpoint draft was not valid JSON`);
    return false;
  }

  const stored = await $.mcp.call(server, "set_waypoint", {
    ...draft,
    metadata: { source: "auto-compaction" },
  });
  if (stored.isError) {
    $.ui.log(`${LABEL}: set_waypoint failed: ${resultText(stored).slice(0, 200)}`);
    return false;
  }
  return true;
}

/** The waypoint as a message for the compacted conversation; null when none. */
async function loadCheckpoint(
  $: EngineInterface,
  server: string
): Promise<SessionMessage | null> {
  const loaded = await $.mcp.call(server, "get_waypoint", {});
  const text = resultText(loaded);
  if (loaded.isError || text === "" || text.startsWith("No stored waypoint")) return null;

  return {
    role: "user",
    text:
      "## Session Waypoint (checkpoint saved automatically before compaction)\n\n" +
      text,
    toolUses: [],
  };
}

export const register: Register = (on) => {
  on("session.compact", async ($, e, next) => {
    // Main conversation only; precompute installs nothing, so the real
    // compaction that follows it is the one to checkpoint.
    if (e.agentId !== undefined || e.trigger === "precompute") return next(e);

    let server: string | null = null;
    let saved = false;
    try {
      const connected = await $.mcp.connect(MCP_SERVER_KEY);
      if (connected.isConnected) {
        server = connected.server;
        $.ui.status("Saving waypoint before compaction…");
        saved = await saveCheckpoint($, server);
      } else {
        $.ui.log(`${LABEL}: server not connected (${connected.message})`);
      }
    } catch (err) {
      $.ui.log(`${LABEL}: checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      $.ui.status(undefined);
    }

    const compacted = await next(e);
    if (compacted.skip !== undefined || server === null || !saved) {
      if (server !== null && !saved) $.ui.toast("Vector Memory: waypoint not saved before compaction");
      return compacted;
    }

    try {
      const waypoint = await loadCheckpoint($, server);
      if (waypoint) {
        $.ui.toast("Vector Memory: waypoint saved and reloaded across compaction");
        return { ...compacted, messages: [...compacted.messages, waypoint] };
      }
    } catch (err) {
      $.ui.log(`${LABEL}: waypoint reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return compacted;
  }).catch(($, e, next) => next(e)); // replay-safe: never compacts twice
};
