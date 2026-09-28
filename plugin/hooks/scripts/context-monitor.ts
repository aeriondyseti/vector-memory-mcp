#!/usr/bin/env bun
/**
 * Context health monitor for vector-memory plugin.
 *
 * Runs on both Stop and PostToolUse events to provide timely feedback:
 *   - Stop: fires at end of each turn (always evaluates)
 *   - PostToolUse: fires after each tool call during autonomous runs (throttled to every 30s)
 *
 * Monitors session health via resource pressure signals from the transcript:
 *   1. Context length (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)
 *   2. Compression count (tracked by PreCompact hook in session-compact.ts)
 * Never blocks — surfaces waypoint recommendations via `toUser` (systemMessage),
 * which the user sees in the Claude Code UI without injecting into model context.
 *
 * NOTE: Never use "block"/`deny` in a Stop hook for monitoring purposes. It
 * creates an infinite loop: block → Claude responds → Stop fires again → ...
 * This is also why we do NOT wrap the body in hook-kit's `runHook`: it maps a
 * parse failure to exit code 2, which a Stop hook interprets as block. We swallow
 * every error and emit a clean pass instead.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "fs";
import { getStatePath } from "./hooks-lib";
import { Stop, PostToolUse, OutputBuilder, ICONS } from "@aeriondyseti/hook-kit";

// When invoked from PostToolUse, throttle to avoid running after every tool call.
// Stop hooks always evaluate (definitive end-of-turn feedback).
const IS_THROTTLED = process.argv.includes("--throttled");
const THROTTLE_SECONDS = 30;

// One event class drives both parse() and emitOutput() for this invocation.
// Both share the CommonHookInput fields we read and the `toUser` emit option.
const EVENT = IS_THROTTLED ? PostToolUse : Stop;

/** Emit a clean pass-through (no decision, no message) and exit 0. */
function pass(): never {
  return EVENT.emitOutput({});
}

// ── Configuration (matching session-monitor.py) ─────────────────────

// Context thresholds are fractions of the model's window, not absolute
// tokens — what matters is how full the window is (autocompact pressure),
// which varies by model. See MODEL_CONTEXT_WINDOWS below.
const WARN_FRAC = 0.5;
const STRONG_FRAC = 0.75;
const CRITICAL_FRAC = 0.9;

// Model → context window (tokens). Prefix-matched so dated IDs
// (e.g. claude-haiku-4-5-20251001) still resolve. Unknown models fall
// back to DEFAULT_WINDOW, reproducing the conservative pre-model-aware
// behavior rather than guessing high and under-warning.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-5": 200_000,
  "claude-haiku-4-5": 200_000,
};
const DEFAULT_WINDOW = 200_000;

function windowFor(model?: string): number {
  if (!model) return DEFAULT_WINDOW;
  const hit = Object.keys(MODEL_CONTEXT_WINDOWS).find((k) =>
    model.startsWith(k)
  );
  return hit ? MODEL_CONTEXT_WINDOWS[hit] : DEFAULT_WINDOW;
}

// Compressions are a quality signal, not a capacity one — they don't
// scale with the window, so these stay absolute.
const COMPRESS_WARN = 2;
const COMPRESS_STRONG = 4;
const COMPRESS_CRITICAL = 6;

// ── State ───────────────────────────────────────────────────────────

interface MonitorState {
  last_offset: number;
  compressions: number;
  context_length: number;
  last_checked_at: number;
  model?: string;
}

function loadState(sessionId: string): MonitorState {
  const path = getStatePath(sessionId);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {}
  return {
    last_offset: 0,
    compressions: 0,
    context_length: 0,
    last_checked_at: 0,
  };
}

function saveState(sessionId: string, state: MonitorState): void {
  try {
    const path = getStatePath(sessionId);
    writeFileSync(path, JSON.stringify(state));
  } catch {}
}

// ── Transcript analysis ─────────────────────────────────────────────

interface TranscriptEntry {
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
}

type TranscriptUsage = NonNullable<NonNullable<TranscriptEntry["message"]>["usage"]>;

function analyzeTranscript(
  transcriptPath: string,
  state: MonitorState
): MonitorState {
  if (!existsSync(transcriptPath)) return state;

  const fileSize = statSync(transcriptPath).size;
  if (fileSize <= state.last_offset) return state;

  try {
    const fd = openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(fileSize - state.last_offset);
    readSync(fd, buffer, 0, buffer.length, state.last_offset);
    closeSync(fd);

    const newContent = buffer.toString("utf-8");

    // Track the most recent main-chain entry for context length
    // (matching ccstatusline's approach)
    let mostRecentMainChainUsage: TranscriptUsage | null = null;
    let mostRecentModel: string | undefined;
    let mostRecentTimestamp: Date | null = null;

    for (const line of newContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let data: TranscriptEntry;
      try {
        data = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const usage = data.message?.usage;
      if (!usage) continue;

      // Skip sidechain (subagent) entries and API errors
      if (data.isSidechain === true || data.isApiErrorMessage) continue;

      // Track most recent main-chain entry by timestamp
      if (data.timestamp) {
        const entryTime = new Date(data.timestamp);
        if (!mostRecentTimestamp || entryTime > mostRecentTimestamp) {
          mostRecentTimestamp = entryTime;
          mostRecentMainChainUsage = usage;
          mostRecentModel = data.message?.model;
        }
      }
    }

    // Context length = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
    // from the most recent main-chain entry
    if (mostRecentMainChainUsage) {
      state.context_length =
        (mostRecentMainChainUsage.input_tokens || 0) +
        (mostRecentMainChainUsage.cache_read_input_tokens ?? 0) +
        (mostRecentMainChainUsage.cache_creation_input_tokens ?? 0);
    }
    if (mostRecentModel) state.model = mostRecentModel;

    state.last_offset = fileSize;
  } catch {}

  return state;
}

// ── Evaluation ──────────────────────────────────────────────────────

type Severity = "info" | "warn" | "strong" | "critical";

const SEVERITY_ORDER: Severity[] = ["info", "warn", "strong", "critical"];

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

interface HealthReport {
  severity: Exclude<Severity, "info">;
  issues: string[];
}

function evaluate(state: MonitorState): HealthReport | null {
  const { context_length: ctx, compressions } = state;

  const issues: string[] = [];
  let severity: Severity = "info";

  // Context size — evaluated as a fraction of the model's window.
  const window = windowFor(state.model);
  const pct = Math.round((ctx / window) * 100);
  const of = `${ctx.toLocaleString()} tokens (${pct}% of window)`;
  if (ctx >= window * CRITICAL_FRAC) {
    issues.push(`Context size is ${of} — near compression limit`);
    severity = maxSeverity(severity, "critical");
  } else if (ctx >= window * STRONG_FRAC) {
    issues.push(`Context size is ${of} — compression approaching`);
    severity = maxSeverity(severity, "strong");
  } else if (ctx >= window * WARN_FRAC) {
    issues.push(`Context size is ${of}`);
    severity = maxSeverity(severity, "warn");
  }

  // Compressions
  const compressWord = compressions === 1 ? "compression" : "compressions";
  if (compressions >= COMPRESS_CRITICAL) {
    issues.push(
      `${compressions} context ${compressWord} detected (significant quality loss likely)`
    );
    severity = maxSeverity(severity, "critical");
  } else if (compressions >= COMPRESS_STRONG) {
    issues.push(
      `${compressions} context ${compressWord} detected (quality degrading)`
    );
    severity = maxSeverity(severity, "strong");
  } else if (compressions >= COMPRESS_WARN) {
    issues.push(`${compressions} context ${compressWord} detected`);
    severity = maxSeverity(severity, "warn");
  }

  if (issues.length === 0 || severity === "info") return null;
  return { severity, issues };
}

// ── Rendering ───────────────────────────────────────────────────────

// Per-severity presentation: box title, border color, and closing advice.
const PRESENTATION: Record<
  HealthReport["severity"],
  { title: string; color: "yellow" | "red"; advice: string }
> = {
  warn: {
    title: "SESSION HEALTH NOTE",
    color: "yellow",
    advice:
      "FYI: Context is growing. Consider breaking at the next natural boundary (after current task or commit).",
  },
  strong: {
    title: "SESSION HEALTH WARNING",
    color: "yellow",
    advice:
      "Consider: finish current task, commit, and start a new session with /waypoint:get to preserve quality.",
  },
  critical: {
    title: "SESSION HEALTH — ACTION RECOMMENDED",
    color: "red",
    advice:
      "Recommend: run /waypoint:set, commit any pending work, and start a fresh session. Context quality degrades with each compression cycle.",
  },
};

/** Build the user-facing alert as an ANSI box via hook-kit's OutputBuilder. */
function renderAlert(report: HealthReport): OutputBuilder {
  const { title, color, advice } = PRESENTATION[report.severity];
  const body = new OutputBuilder();
  body.appendList(report.issues, { bullet: ICONS.warn });
  body.appendLine();
  body.appendLine(advice);
  // No leading newline needed: hook-kit's `toUser` prepends one so the box's
  // top border starts on its own row.
  return new OutputBuilder().appendBox(body.render(), { title, color });
}

// ── Main ────────────────────────────────────────────────────────────

function main(): never {
  // parse() reads stdin and validates the event name; a bad payload throws
  // HookParseError, which the top-level catch turns into a clean pass().
  const input = EVENT.parse();

  if (!input.transcript_path || !input.session_id) return pass();

  let state = loadState(input.session_id);

  // PostToolUse hooks are throttled to avoid running after every tool call.
  // Stop hooks always evaluate (definitive end-of-turn feedback).
  if (IS_THROTTLED) {
    const elapsed = (Date.now() - state.last_checked_at) / 1000;
    if (elapsed < THROTTLE_SECONDS) return pass();
  }

  const prevOffset = state.last_offset;
  state = analyzeTranscript(input.transcript_path, state);
  const report = evaluate(state);
  state.last_checked_at = Date.now();

  // Only write state if transcript advanced or throttle timer needs updating
  if (state.last_offset !== prevOffset || IS_THROTTLED) {
    saveState(input.session_id, state);
  }

  // `toUser` maps to systemMessage: shown to the user, not injected into
  // model context. No decision → the turn is never blocked.
  return EVENT.emitOutput(report ? { toUser: renderAlert(report) } : {});
}

try {
  main();
} catch {
  // On any error, pass silently so the session is never blocked.
  pass();
}
