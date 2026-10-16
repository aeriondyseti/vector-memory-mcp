/**
 * vector-memory mods (Claude Code function hooks): waypoint checkpoints.
 *
 * A checkpoint is what `/waypoint:set` does: the model reviews the session
 * (a fork of the conversation), its memories are stored (`store_memories`),
 * then the waypoint, linking them (`set_waypoint` with `memory_ids`).
 * "Memories only" stores the memories without a waypoint.
 *
 * Compaction — wraps every compaction of the main conversation, per the
 * `compactCheckpoint` option: `ask` puts the choice to the person (a
 * waypoint instead — saved, then the conversation cleared down to it in
 * place of compacting — memories only, just compact, cancel a `/compact`, or
 * type notes under "Other" that steer that waypoint), `always` saves a
 * waypoint, compacts and appends it, `never` does nothing. Nobody to ask
 * (-p, SDK) or a plugin's compaction: as `always`. `/compact <text>` steers
 * the draft too.
 *
 * /clear and /exit (and aliases: /new, /reset, /quit) — before the command
 * runs (`session.end` is too short-lived to draft one), the same choice per
 * the `exitCheckpoint` option; under `ask`, a command from the SDK, the
 * bridge or a plugin goes ahead without a checkpoint.
 *
 * Session start and after /clear — the classic SessionStart hooks load the
 * latest waypoint as context; this wraps them, per the `loadCheckpoint`
 * option: `ask` puts loading it to the person (and drops it on "Start
 * fresh"), `always` keeps it, `never` drops it. A waypoint the person chose
 * to save at the /clear just run is loaded without asking again.
 *
 * File memories — after a Write or Edit of a Claude Code file-based memory
 * (`…/projects/<slug>/memory/<name>.md`, not the `MEMORY.md` index), the
 * file is stored as a vector memory keyed `file-memory:<name>`, so a later
 * edit replaces it (kept as history). Bash calls are caught by listing the
 * memory folder (named in the system prompt's `memory` section) before and
 * after. Syncs run in the background, skip a file whose text is unchanged
 * since its last sync, and never touch the tool's result. Per the
 * `fileMemorySync` option.
 *
 * Every failure degrades to the command, compaction or start running as usual.
 * Loaded by Claude Code builds with the mod system (via `modules` in
 * hooks.json); older builds ignore it and keep the classic command hooks.
 */

import type { EngineInterface, Hook, Register, SessionMessage, ToolCallResult } from "claude-code";
import {
  ANSWER,
  type CheckpointDecision,
  type CheckpointMode,
  type CheckpointSource,
  checkpointDecision,
  checkpointMode,
  checkpointPrompt,
  type CompactionDecision,
  compactionDecision,
  errorMessage,
  findWaypointContext,
  loadQuestion,
  type MemoryDraft,
  memoriesArgs,
  memoriesPrompt,
  parseMemoriesDraft,
  parseWaypointDraft,
  RECALLED_CONTEXT_NOTE,
  resultText,
  savedToast,
  storedMemoryIds,
  waypointArgs,
} from "./checkpoint.ts";
import {
  changedMemoryFiles,
  fileMemoryArgs,
  fileMemorySyncMode,
  isFileMemoryPath,
  type MemoryListing,
  memoryDirFromPrompt,
  memoryListing,
  parseFileMemory,
  sha256,
  syncedToast,
} from "./file-memory.ts";

/** The server's key in plugin/.mcp.json. */
const MCP_SERVER_KEY = "vector-memory";

const LABEL = "vector-memory";

const SAVE: CheckpointDecision = { kind: "save" };

/** The plugin's MCP server name for `$.mcp.call`; null (logged) when unavailable. */
async function connectServer($: EngineInterface): Promise<string | null> {
  const connected = await $.mcp.connect(MCP_SERVER_KEY);
  if (connected.isConnected) return connected.server;
  $.ui.log(`${LABEL}: server not connected (${connected.message})`);
  return null;
}

/** Store drafted memories; resolves the ids to link, or null (logged) on failure. */
async function storeMemories(
  $: EngineInterface,
  server: string,
  memories: MemoryDraft[],
  source: CheckpointSource
): Promise<string[] | null> {
  if (memories.length === 0) return [];
  const stored = await $.mcp.call(server, "store_memories", memoriesArgs(memories, source));
  if (stored.isError) {
    $.ui.log(`${LABEL}: store_memories failed: ${resultText(stored).slice(0, 200)}`);
    return null;
  }
  return storedMemoryIds(resultText(stored));
}

interface Saved {
  server: string | null;
  /** The waypoint (or, for memories only, the memories) was stored. */
  saved: boolean;
  /** Memories stored with it. */
  memoryCount: number;
}

/**
 * Draft and store a checkpoint: memories, then (unless `memoriesOnly`) the
 * waypoint linking them. A waypoint whose memories failed to store is still
 * saved, without links.
 */
async function saveCheckpoint(
  $: EngineInterface,
  source: CheckpointSource,
  { memoriesOnly = false, notes }: { memoriesOnly?: boolean; notes?: string } = {}
): Promise<Saved> {
  let server: string | null = null;
  const failed = () => ({ server, saved: false, memoryCount: 0 });
  $.ui.status(memoriesOnly ? "Saving memories…" : "Saving waypoint…");
  try {
    server = await connectServer($);
    if (server === null) return failed();

    const prompt = memoriesOnly ? memoriesPrompt(source, notes) : checkpointPrompt(source, notes);
    const reply = await $.model.fork({ prompt });
    if (!reply.isAnswered) {
      $.ui.log(`${LABEL}: checkpoint not drafted (${reply.reason})`);
      return failed();
    }

    const memories = parseMemoriesDraft(reply.text);
    const draft = memoriesOnly ? null : parseWaypointDraft(reply.text);
    if (memoriesOnly ? memories === null : draft === null) {
      $.ui.log(`${LABEL}: checkpoint draft was not valid JSON`);
      return failed();
    }

    const ids = await storeMemories($, server, memories ?? [], source);
    const memoryCount = ids === null ? 0 : (memories ?? []).length;
    if (draft === null) return { server, saved: ids !== null, memoryCount };

    const stored = await $.mcp.call(server, "set_waypoint", waypointArgs(draft, source, notes, ids ?? []));
    if (stored.isError) {
      $.ui.log(`${LABEL}: set_waypoint failed: ${resultText(stored).slice(0, 200)}`);
      return { ...failed(), memoryCount };
    }
    return { server, saved: true, memoryCount };
  } catch (err) {
    $.ui.log(`${LABEL}: checkpoint failed: ${errorMessage(err)}`);
    return failed();
  } finally {
    $.ui.status(undefined);
  }
}

/** The waypoint as a message for the conversation, headed by `how` it got there; null when none. */
async function loadCheckpoint($: EngineInterface, server: string, how: string): Promise<SessionMessage | null> {
  const loaded = await $.mcp.call(server, "get_waypoint", {});
  const text = resultText(loaded);
  if (loaded.isError || text === "" || text.startsWith("No stored waypoint")) return null;

  return {
    role: "user",
    text: `## Session Waypoint (${how})\n\n${RECALLED_CONTEXT_NOTE}\n\n${text}`,
    toolUses: [],
  };
}

async function askBeforeExit($: EngineInterface, command: string): Promise<CheckpointDecision> {
  try {
    const answer = await $.ui.ask(
      `Save a waypoint before /${command}? Type under "Other" to say what it should focus on.`,
      { header: "Waypoint", options: [ANSWER.save, ANSWER.memories, ANSWER.skip, ANSWER.cancel] }
    );
    return checkpointDecision(answer);
  } catch {
    return { kind: "cancel" }; // dismissed (Esc)
  }
}

/**
 * Asks whether to clear the conversation down to a waypoint instead of
 * compacting it. Without `canCancel` (an auto-compaction must go ahead),
 * there is no Cancel and dismissing saves the waypoint and compacts, as
 * before this asked; with it, dismissing cancels.
 */
async function askBeforeCompaction($: EngineInterface, canCancel: boolean): Promise<CompactionDecision> {
  const options = [ANSWER.instead, ANSWER.memories, ANSWER.compact, ...(canCancel ? [ANSWER.cancel] : [])];
  try {
    const answer = await $.ui.ask(
      "Save a waypoint and memories and clear the conversation instead of compacting it? " +
        'Type under "Other" to say what the waypoint should focus on.',
      { header: "Compaction", options }
    );
    return compactionDecision(answer);
  } catch {
    return canCancel ? { kind: "cancel" } : SAVE; // dismissed (Esc)
  }
}

/** After a failed save: go ahead with `action` ("Run /clear", "Compact") anyway? */
async function proceedWithoutSaving(
  $: EngineInterface,
  decision: CompactionDecision,
  action: string
): Promise<boolean> {
  const what = decision.kind === "memories" ? "The memories" : "The waypoint";
  try {
    const answer = await $.ui.ask(`${what} could not be saved. ${action} anyway?`, {
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

/** Notes for the draft: `/compact <text>` and what the person typed under "Other". */
function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const given = notes.map((n) => n?.trim()).filter((n): n is string => !!n);
  return given.length > 0 ? given.join("\n\n") : undefined;
}

/** The options, set by `register` (each reload runs it again). */
let compactCheckpointMode: CheckpointMode = "ask";
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

/** Around every main-conversation compaction: checkpoint per `compactCheckpointMode`. */
const checkpointBeforeCompaction: Hook<"session.compact"> = async ($, e, next) => {
  // Main conversation only; precompute installs nothing, so the real
  // compaction that follows it is the one to checkpoint.
  if (e.agentId !== undefined || e.trigger === "precompute") return next(e);

  // The person is asked about their /compact and an auto-compaction while
  // someone is there; a plugin's compaction, or one with nobody to ask,
  // saves the waypoint and compacts. Only a /compact can be cancelled: an
  // auto-compaction runs when the conversation no longer fits.
  const isInteractive =
    compactCheckpointMode === "ask" &&
    e.trigger !== "plugin" &&
    (await $.session.surfaces()).length > 0;
  const canCancel = e.trigger === "manual";

  const decision: CompactionDecision = isInteractive ? await askBeforeCompaction($, canCancel) : SAVE;
  if (decision.kind === "cancel") return { skip: "/compact cancelled." };
  if (decision.kind === "skip") return next(e);

  const memoriesOnly = decision.kind === "memories";
  const notes = joinNotes(e.instructions, "notes" in decision ? decision.notes : undefined);
  const { server, saved, memoryCount } = await saveCheckpoint($, "auto-compaction", { memoriesOnly, notes });

  if (!saved && isInteractive && canCancel && !(await proceedWithoutSaving($, decision, "Compact"))) {
    return { skip: "/compact cancelled." };
  }

  // Instead of compacting: the conversation becomes the waypoint alone, as
  // after /clear (the engine's summarizer never runs). Should the waypoint
  // not load back, it compacts after all.
  if (decision.kind === "instead" && saved && server !== null) {
    try {
      const waypoint = await loadCheckpoint($, server, "saved in place of compaction; the conversation before it was cleared");
      if (waypoint) {
        $.ui.toast(`${savedToast(true, memoryCount)}; conversation cleared to the waypoint`);
        return { messages: [waypoint] };
      }
    } catch (err) {
      $.ui.log(`${LABEL}: waypoint reload failed: ${errorMessage(err)}`);
    }
  }

  const compacted = await next(e);
  if (compacted.skip !== undefined) return compacted;
  if (!saved) {
    if (server !== null && !(isInteractive && canCancel)) {
      $.ui.toast(`Vector Memory: ${memoriesOnly ? "memories" : "waypoint"} not saved before compaction`);
    }
    return compacted;
  }
  if (memoriesOnly || server === null) {
    $.ui.toast(savedToast(!memoriesOnly, memoryCount));
    return compacted;
  }

  try {
    const waypoint = await loadCheckpoint($, server, "checkpoint saved automatically before compaction");
    if (waypoint) {
      $.ui.toast(`${savedToast(true, memoryCount)} and reloaded across compaction`);
      return { ...compacted, messages: [...compacted.messages, waypoint] };
    }
  } catch (err) {
    $.ui.log(`${LABEL}: waypoint reload failed: ${errorMessage(err)}`);
  }
  return compacted;
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

  const decision = isInteractive ? await askBeforeExit($, command) : SAVE;
  if (decision.kind === "cancel") return { text: `/${command} cancelled.` };
  if (decision.kind === "skip") return next(e);

  const memoriesOnly = decision.kind === "memories";
  const { saved, memoryCount } = await saveCheckpoint($, command === "clear" ? "clear" : "exit", {
    memoriesOnly,
    notes: "notes" in decision ? decision.notes : undefined,
  });

  if (saved) {
    isSavedAtClear = !memoriesOnly && command === "clear";
    $.ui.toast(savedToast(!memoriesOnly, memoryCount));
  } else if (isInteractive) {
    if (!(await proceedWithoutSaving($, decision, `Run /${command}`))) return { text: `/${command} cancelled.` };
  } else {
    $.ui.toast(`Vector Memory: waypoint not saved before /${command}`);
  }
  return next(e);
};

/** SHA-256 of each file memory's text as last synced, by path: an unchanged file is not stored again. */
const syncedHashes = new Map<string, string>();

/**
 * Store the file memory at `path` as a vector memory, unless unchanged since
 * its last sync; resolves its name when stored. Failures are logged, never raised.
 */
async function syncFileMemory($: EngineInterface, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path);
    const hash = await sha256(text);
    if (syncedHashes.get(path) === hash) return null;

    const memory = parseFileMemory(text);
    if (memory === null) {
      $.ui.log(`${LABEL}: ${path} has no frontmatter name or body; not synced`);
      return null;
    }
    const server = await connectServer($);
    if (server === null) return null;

    const project = (await $.session.repo())?.root;
    const stored = await $.mcp.call(server, "store_memories", fileMemoryArgs(memory, path, project));
    if (stored.isError) {
      $.ui.log(`${LABEL}: file memory sync failed: ${resultText(stored).slice(0, 200)}`);
      return null;
    }
    syncedHashes.set(path, hash);
    return memory.name;
  } catch (err) {
    $.ui.log(`${LABEL}: file memory sync failed: ${errorMessage(err)}`);
    return null;
  }
}

/** Sync each of `paths`, then one toast for what was stored. */
async function syncFileMemories($: EngineInterface, paths: readonly string[]): Promise<void> {
  const names: string[] = [];
  for (const path of paths) {
    const name = await syncFileMemory($, path);
    if (name !== null) names.push(name);
  }
  const toast = syncedToast(names);
  if (toast !== null) $.ui.toast(toast);
}

/** Background syncs, one at a time, so two never store the same file at once. */
let syncQueue: Promise<void> = Promise.resolve();

/** Run `job` after the tool call has answered, off its dispatch, so the turn never waits on a sync. */
function syncInBackground($: EngineInterface, job: () => Promise<void>): void {
  $.clock.after(0, () => {
    syncQueue = syncQueue.then(job).catch((err: unknown) => {
      $.ui.log(`${LABEL}: file memory sync failed: ${errorMessage(err)}`);
    });
  });
}

/** After a Write or Edit to `path` ended as `done`: mirror a file memory into vector memory. */
function syncAfterWrite<T extends ToolCallResult>($: EngineInterface, path: string, done: T): T {
  if (done.deny === undefined && !done.isError && isFileMemoryPath(path)) {
    syncInBackground($, () => syncFileMemories($, [path]));
  }
  return done;
}

/** The memory folder the system prompt names, looked up once per load; null when it names none. */
let memoryDirLookup: Promise<string | null> | null = null;

function memoryDir($: EngineInterface): Promise<string | null> {
  memoryDirLookup ??= $.prompt
    .compose()
    .then(({ sections }) => memoryDirFromPrompt(sections))
    .catch((err: unknown) => {
      $.ui.log(`${LABEL}: memory folder lookup failed: ${errorMessage(err)}`);
      return null;
    });
  return memoryDirLookup;
}

/** The memory folder's files; empty when it cannot be listed (not created yet). */
async function listMemoryDir($: EngineInterface, dir: string): Promise<MemoryListing> {
  try {
    return memoryListing(await $.fs.list(dir));
  } catch {
    return new Map();
  }
}

/**
 * Around a Bash call: list the memory folder before it, then in the
 * background list it again and sync each file memory added or changed
 * (`cat >`, `sed -i`, a script, ...). Runs even when the command failed, as
 * it may have written first.
 */
async function syncAroundBash<T extends ToolCallResult>($: EngineInterface, run: () => Promise<T>): Promise<T> {
  const dir = await memoryDir($);
  if (dir === null) return run();

  const before = await listMemoryDir($, dir);
  const done = await run();
  if (done.deny !== undefined) return done;

  syncInBackground($, async () => {
    const changed = changedMemoryFiles(before, await listMemoryDir($, dir));
    await syncFileMemories($, changed.map((name) => `${dir}/${name}`));
  });
  return done;
}

export const register: Register = (on, options) => {
  // ── Compaction ────────────────────────────────────────────────────
  compactCheckpointMode = checkpointMode(options.compactCheckpoint);
  if (compactCheckpointMode !== "never") {
    // replay-safe: never compacts twice
    on("session.compact", checkpointBeforeCompaction).catch(($, e, next) => next(e));
  }

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

  // ── File memories ─────────────────────────────────────────────────
  if (fileMemorySyncMode(options.fileMemorySync) === "on") {
    // The write already happened: a failed sync never touches its result.
    // Syncs run in the background; the tool's result goes back unchanged at once.
    on("tool.call", { tool: "Write" }, async ($, e, next) => syncAfterWrite($, e.file_path, await next(e))).catch(
      ($, e, next) => next(e)
    );
    on("tool.call", { tool: "Edit" }, async ($, e, next) => syncAfterWrite($, e.file_path, await next(e))).catch(
      ($, e, next) => next(e)
    );
    on("tool.call", { tool: "Bash" }, ($, e, next) => syncAroundBash($, () => next(e))).catch(($, e, next) => next(e));
  }
};
