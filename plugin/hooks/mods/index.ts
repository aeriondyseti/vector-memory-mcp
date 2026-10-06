/**
 * vector-memory mods (Claude Code function hooks): waypoint checkpoints.
 *
 * Compaction — wraps every compaction of the main conversation: drafts and
 * saves a waypoint first (`/compact <text>` steers it), runs the engine's
 * compaction, then appends the waypoint to the compacted conversation.
 *
 * /clear and /exit (and aliases: /new, /reset, /quit) — before the command
 * runs (`session.end` is too short-lived to draft one), per the
 * `exitCheckpoint` option: `ask` puts the choice to the person (save, skip,
 * cancel the command, or type notes under "Other" that steer the waypoint),
 * `always` saves without asking, `never` does nothing.
 *
 * Session start and after /clear — the classic SessionStart hooks load the
 * latest waypoint as context; this wraps them, per the `loadCheckpoint`
 * option: `ask` puts loading it to the person (and drops it on "Start
 * fresh"), `always` keeps it, `never` drops it. A waypoint the person chose
 * to save at the /clear just run is loaded without asking again.
 *
 * Every failure degrades to the command, compaction or start running as usual.
 * Loaded by Claude Code builds with the mod system (via `modules` in
 * hooks.json); older builds ignore it and keep the classic command hooks.
 */

import type { EngineInterface, Hook, Register, SessionMessage } from "claude-code";
import {
  ANSWER,
  type CheckpointMode,
  type CheckpointSource,
  checkpointMode,
  checkpointPrompt,
  errorMessage,
  type ExitDecision,
  exitDecision,
  findWaypointContext,
  loadQuestion,
  parseWaypointDraft,
  RECALLED_CONTEXT_NOTE,
  resultText,
  waypointArgs,
} from "./checkpoint.ts";

/** The server's key in plugin/.mcp.json. */
const MCP_SERVER_KEY = "vector-memory";

const LABEL = "vector-memory";

/** The plugin's MCP server name for `$.mcp.call`; null (logged) when unavailable. */
async function connectServer($: EngineInterface): Promise<string | null> {
  const connected = await $.mcp.connect(MCP_SERVER_KEY);
  if (connected.isConnected) return connected.server;
  $.ui.log(`${LABEL}: server not connected (${connected.message})`);
  return null;
}

/** Draft and store a waypoint; resolves true once the server stored it. */
async function saveCheckpoint(
  $: EngineInterface,
  source: CheckpointSource,
  notes?: string
): Promise<{ server: string | null; saved: boolean }> {
  let server: string | null = null;
  $.ui.status("Saving waypoint…");
  try {
    server = await connectServer($);
    if (server === null) return { server, saved: false };

    const reply = await $.model.fork({ prompt: checkpointPrompt(source, notes) });
    if (!reply.isAnswered) {
      $.ui.log(`${LABEL}: checkpoint not drafted (${reply.reason})`);
      return { server, saved: false };
    }

    const draft = parseWaypointDraft(reply.text);
    if (!draft) {
      $.ui.log(`${LABEL}: checkpoint draft was not valid JSON`);
      return { server, saved: false };
    }

    const stored = await $.mcp.call(server, "set_waypoint", waypointArgs(draft, source, notes));
    if (stored.isError) {
      $.ui.log(`${LABEL}: set_waypoint failed: ${resultText(stored).slice(0, 200)}`);
      return { server, saved: false };
    }
    return { server, saved: true };
  } catch (err) {
    $.ui.log(`${LABEL}: checkpoint failed: ${errorMessage(err)}`);
    return { server, saved: false };
  } finally {
    $.ui.status(undefined);
  }
}

/** The waypoint as a message for the compacted conversation; null when none. */
async function loadCheckpoint($: EngineInterface, server: string): Promise<SessionMessage | null> {
  const loaded = await $.mcp.call(server, "get_waypoint", {});
  const text = resultText(loaded);
  if (loaded.isError || text === "" || text.startsWith("No stored waypoint")) return null;

  return {
    role: "user",
    text: `## Session Waypoint (checkpoint saved automatically before compaction)\n\n${RECALLED_CONTEXT_NOTE}\n\n${text}`,
    toolUses: [],
  };
}

async function askBeforeExit($: EngineInterface, command: string): Promise<ExitDecision> {
  try {
    const answer = await $.ui.ask(
      `Save a waypoint before /${command}? Type under "Other" to say what it should focus on.`,
      { header: "Waypoint", options: [ANSWER.save, ANSWER.skip, ANSWER.cancel] }
    );
    return exitDecision(answer);
  } catch {
    return { kind: "cancel" }; // dismissed (Esc)
  }
}

async function proceedWithoutWaypoint($: EngineInterface, command: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(`The waypoint could not be saved. Run /${command} anyway?`, {
      header: "Waypoint",
      options: [ANSWER.proceed, ANSWER.cancel],
    });
    return answer === ANSWER.proceed;
  } catch {
    return false;
  }
}

/** Asks whether to load the waypoint; keeps it when dismissed, as before this asked. */
async function askToLoad($: EngineInterface, waypointContext: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(loadQuestion(waypointContext, Date.now()), {
      header: "Waypoint",
      options: [ANSWER.load, ANSWER.fresh],
    });
    return answer !== ANSWER.fresh;
  } catch {
    return true;
  }
}

/** The `exitCheckpoint` and `loadCheckpoint` options, set by `register` (each reload runs it again). */
let exitCheckpointMode: CheckpointMode = "ask";
let loadCheckpointMode: CheckpointMode = "ask";

/** A waypoint was saved at the /clear now running: the session it starts loads it unasked. */
let isSavedAtClear = false;

/** After the classic SessionStart hooks: keep or drop the waypoint they loaded. */
const askBeforeLoad: Hook<"classic.SessionStart"> = async ($, e, next) => {
  const started = await next(e);
  const wasSavedAtClear = isSavedAtClear;
  isSavedAtClear = false;

  if (e.source !== "startup" && e.source !== "clear") return started;
  const context = started.additionalContext ?? [];
  const at = findWaypointContext(context);
  if (at < 0 || loadCheckpointMode === "always" || wasSavedAtClear) return started;

  // Nobody to ask (-p, SDK): load it, as before this asked.
  if (loadCheckpointMode === "ask") {
    const hasPerson = (await $.session.surfaces()).length > 0;
    if (!hasPerson || (await askToLoad($, context[at] ?? ""))) return started;
  }

  $.ui.toast("Vector Memory: waypoint not loaded — starting fresh");
  return { ...started, additionalContext: context.filter((_, i) => i !== at) };
};

/** Before /clear or /exit runs: checkpoint per `exitCheckpointMode`. */
const checkpointBeforeExit: Hook<"command.run"> = async ($, e, next) => {
  const command = e.command;
  const mode = exitCheckpointMode;

  // Nothing worth a checkpoint before the first exchange.
  if ((await $.session.turns()) === 0) return next(e);

  // Only the person at the prompt is asked; under `ask`, a /clear from the
  // SDK, the bridge or a plugin goes ahead without a checkpoint.
  const isInteractive = mode === "ask" && e.origin.kind === "composer";
  if (mode === "ask" && !isInteractive) return next(e);

  const decision = isInteractive ? await askBeforeExit($, command) : { kind: "save" as const };
  if (decision.kind === "cancel") return { text: `/${command} cancelled.` };
  if (decision.kind === "skip") return next(e);

  const { saved } = await saveCheckpoint(
    $,
    command === "clear" ? "clear" : "exit",
    "notes" in decision ? decision.notes : undefined
  );

  if (saved) {
    isSavedAtClear = command === "clear";
    $.ui.toast("Vector Memory: waypoint saved");
  } else if (isInteractive) {
    if (!(await proceedWithoutWaypoint($, command))) return { text: `/${command} cancelled.` };
  } else {
    $.ui.toast(`Vector Memory: waypoint not saved before /${command}`);
  }
  return next(e);
};

export const register: Register = (on, options) => {
  // ── Compaction ────────────────────────────────────────────────────
  on("session.compact", async ($, e, next) => {
    // Main conversation only; precompute installs nothing, so the real
    // compaction that follows it is the one to checkpoint.
    if (e.agentId !== undefined || e.trigger === "precompute") return next(e);

    const { server, saved } = await saveCheckpoint($, "auto-compaction", e.instructions);

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
      $.ui.log(`${LABEL}: waypoint reload failed: ${errorMessage(err)}`);
    }
    return compacted;
  }).catch(($, e, next) => next(e)); // replay-safe: never compacts twice

  // ── Session start and after /clear ────────────────────────────────
  loadCheckpointMode = checkpointMode(options.loadCheckpoint);
  if (loadCheckpointMode !== "always") {
    // On failure, the start goes on as the classic hooks left it.
    on("classic.SessionStart", askBeforeLoad).catch(($, e, next) => next(e));
  }

  // ── /clear and /exit ──────────────────────────────────────────────
  exitCheckpointMode = checkpointMode(options.exitCheckpoint);
  if (exitCheckpointMode !== "never") {
    // Never strand the person in a session they asked to leave.
    on("command.run", { command: "clear" }, checkpointBeforeExit).catch(($, e, next) => next(e));
    on("command.run", { command: "exit" }, checkpointBeforeExit).catch(($, e, next) => next(e));
  }
};
