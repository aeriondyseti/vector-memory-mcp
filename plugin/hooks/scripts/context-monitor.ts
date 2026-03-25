#!/usr/bin/env bun
/**
 * Stop hook for vector-memory plugin.
 *
 * Monitors session health via resource pressure signals from the transcript:
 *   1. Turn count (main chain only, excludes subagent/sidechain entries)
 *   2. Context length (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)
 *   3. Compression count (tracked by PreCompact hook in session-compact.ts)
 * Always approves — uses systemMessage for waypoint recommendations.
 *
 * NOTE: Never use "block" in a Stop hook for monitoring purposes. It creates
 * an infinite loop: block → Claude responds → Stop fires again → block → ...
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

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  reason: string;
}

// ── Configuration (matching session-monitor.py) ─────────────────────

const TURN_WARN = 120;
const TURN_STRONG = 180;
const TURN_CRITICAL = 250;

const CONTEXT_WARN = 120_000; // tokens
const CONTEXT_STRONG = 150_000;
const CONTEXT_CRITICAL = 175_000;

const COMPRESS_WARN = 2;
const COMPRESS_STRONG = 4;
const COMPRESS_CRITICAL = 6;

// ── State ───────────────────────────────────────────────────────────

interface MonitorState {
  last_offset: number;
  turn_count: number;
  compressions: number;
  context_length: number;
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
    turn_count: 0,
    compressions: 0,
    context_length: 0,
  };
}

function saveState(sessionId: string, state: MonitorState): void {
  try {
    const path = getStatePath(sessionId);
    writeFileSync(path, JSON.stringify(state));
  } catch {}
}

// ── Transcript analysis ─────────────────────────────────────────────

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
    let mostRecentMainChainUsage: any = null;
    let mostRecentTimestamp: Date | null = null;

    for (const line of newContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let data: any;
      try {
        data = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const usage = data.message?.usage;
      if (!usage) continue;

      // Skip sidechain (subagent) entries and API errors
      if (data.isSidechain === true || data.isApiErrorMessage) continue;

      state.turn_count += 1;

      // Track most recent main-chain entry by timestamp
      if (data.timestamp) {
        const entryTime = new Date(data.timestamp);
        if (!mostRecentTimestamp || entryTime > mostRecentTimestamp) {
          mostRecentTimestamp = entryTime;
          mostRecentMainChainUsage = usage;
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

function evaluate(state: MonitorState): string | null {
  const { turn_count: turns, context_length: ctx, compressions } = state;

  const issues: string[] = [];
  let severity: Severity = "info";

  // Turn count
  if (turns >= TURN_CRITICAL) {
    issues.push(`Session is at ${turns} turns (critical)`);
    severity = "critical";
  } else if (turns >= TURN_STRONG) {
    issues.push(`Session is at ${turns} turns (high)`);
    severity = "strong";
  } else if (turns >= TURN_WARN) {
    issues.push(`Session is at ${turns} turns`);
    severity = "warn";
  }

  // Context size (tokens)
  if (ctx >= CONTEXT_CRITICAL) {
    issues.push(
      `Context size is ${ctx.toLocaleString()} tokens (near compression limit)`
    );
    severity = maxSeverity(severity, "critical");
  } else if (ctx >= CONTEXT_STRONG) {
    issues.push(
      `Context size is ${ctx.toLocaleString()} tokens (compression approaching)`
    );
    severity = maxSeverity(severity, "strong");
  } else if (ctx >= CONTEXT_WARN) {
    issues.push(`Context size is ${ctx.toLocaleString()} tokens`);
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

  if (issues.length === 0) return null;

  const label: Record<string, string> = {
    warn: "SESSION HEALTH NOTE",
    strong: "SESSION HEALTH WARNING",
    critical: "SESSION HEALTH — ACTION RECOMMENDED",
  };

  const header = label[severity] || "SESSION HEALTH NOTE";
  const parts = [`${header}: ${issues.join("; ")}.`];

  if (severity === "critical") {
    parts.push(
      "Recommend: run /waypoint:set, commit any pending work, and start a fresh session. " +
        "Context quality degrades with each compression cycle."
    );
  } else if (severity === "strong") {
    parts.push(
      "Consider: finish current task, commit, and start a new session with /waypoint:get " +
        "to preserve quality."
    );
  } else {
    parts.push(
      "FYI: Context is growing. Consider breaking at the next natural boundary " +
        "(after current task or commit)."
    );
  }

  return parts.join(" ");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const input: HookInput = await Bun.stdin.json();

  if (!input.transcript_path || !input.session_id) {
    console.log(JSON.stringify({ decision: "approve" }));
    return;
  }

  let state = loadState(input.session_id);
  state = analyzeTranscript(input.transcript_path, state);
  const message = evaluate(state);
  saveState(input.session_id, state);

  if (message) {
    console.log(
      JSON.stringify({
        decision: "approve",
        systemMessage: message,
      })
    );
  } else {
    console.log(JSON.stringify({ decision: "approve" }));
  }
}

main().catch(() => {
  // On error, approve silently to avoid blocking the session
  console.log(JSON.stringify({ decision: "approve" }));
  process.exit(0);
});
