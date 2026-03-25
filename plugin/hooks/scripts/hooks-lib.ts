/**
 * Shared utilities for vector-memory hook scripts.
 *
 * Provides:
 *   - ANSI color/style constants
 *   - Nerd Font icon constants (single-width glyphs)
 *   - Formatted systemMessage builder (user-facing)
 *   - Structured hook output builder (JSON protocol)
 *   - Monitor state management
 *   - Server discovery and interaction
 */

import { readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── ANSI escape codes ───────────────────────────────────────────────

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Foreground colors
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

// ── Nerd Font glyphs (single-width) ────────────────────────────────

export const icon = {
  check: "\uf00c", // nf-fa-check
  cross: "\uf00d", // nf-fa-close
  book: "\uf02d", // nf-fa-book
  branch: "\ue0a0", // Powerline branch
  clock: "\uf017", // nf-fa-clock_o
  warning: "\uf071", // nf-fa-warning
  bolt: "\uf0e7", // nf-fa-bolt
  brain: "\uf5dc", // nf-mdi-brain
  search: "\uf002", // nf-fa-search
  gear: "\uf013", // nf-fa-gear
  database: "\uf1c0", // nf-fa-database
  arrow: "\uf061", // nf-fa-arrow_right
  dot: "\u00b7", // middle dot (standard unicode)
} as const;

// ── Rule line ───────────────────────────────────────────────────────

const RULE_WIDTH = 42;

/**
 * Create a horizontal rule with an optional inline title.
 * e.g. "── Vector Memory ──────────────────────"
 */
export function rule(title?: string): string {
  if (!title) {
    return `${ansi.cyan}${"─".repeat(RULE_WIDTH)}${ansi.reset}`;
  }
  const label = ` ${ansi.bold}${title}${ansi.reset} `;
  // "── " prefix = 3 visual chars
  const prefix = `${ansi.cyan}── ${ansi.reset}`;
  // Calculate remaining dashes (account for title visual length)
  const remaining = RULE_WIDTH - 3 - title.length - 2; // 2 for spaces around title
  const suffix = `${ansi.cyan}${"─".repeat(Math.max(1, remaining))}${ansi.reset}`;
  return `${prefix}${label}${suffix}`;
}

// ── System message builder ──────────────────────────────────────────

export interface MessageLine {
  icon?: string;
  iconColor?: string;
  text: string;
}

/**
 * Build a user-facing systemMessage with horizontal rules and content lines.
 *
 * Output format:
 *   ── Title ──────────────────────────────
 *     icon text
 *     icon text
 *   ──────────────────────────────────────
 *
 * Prepends an empty line so the content starts below the hook label prefix.
 */
export function buildSystemMessage(
  title: string,
  lines: MessageLine[]
): string {
  const parts = [
    "", // push below "HookName says:" prefix
    rule(title),
  ];

  for (const line of lines) {
    if (line.icon) {
      const color = line.iconColor ?? "";
      const reset = line.iconColor ? ansi.reset : "";
      parts.push(`  ${color}${line.icon}${reset} ${line.text}`);
    } else {
      parts.push(`  ${line.text}`);
    }
  }

  parts.push(rule());
  return parts.join("\n");
}

// ── Hook event names ────────────────────────────────────────────────

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "Notification"
  | "SubagentStop";

// ── Hook output builder ─────────────────────────────────────────────

export interface HookOutput {
  /** User-facing message (supports ANSI colors) */
  systemMessage?: string;
  /** Decision for decision-capable hooks (Stop, PreToolUse, etc.) */
  decision?: "approve" | "block";
  /** Reason for blocking */
  reason?: string;
  /** Hook-specific output */
  hookSpecificOutput?: {
    hookEventName: HookEventName;
    additionalContext?: string;
  };
  /** Suppress stdout from being added to context */
  suppressOutput?: boolean;
}

/**
 * Emit structured JSON hook output to stdout.
 * This is the final call in a hook — prints the JSON and nothing else.
 */
export function emitHookOutput(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

// ── Diagnostic logging ──────────────────────────────────────────────

/**
 * Log a diagnostic message to stderr (visible in verbose/debug mode).
 */
export function debug(label: string, message: string): void {
  console.error(
    `${ansi.gray}[${label}]${ansi.reset} ${ansi.dim}${message}${ansi.reset}`
  );
}

// ── Monitor state ───────────────────────────────────────────────────

export const STATE_DIR = join(tmpdir(), "claude-context-monitor");

export function getStatePath(sessionId: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return join(STATE_DIR, `${sessionId}.json`);
}

// ── Server discovery ────────────────────────────────────────────────

/**
 * Retry schedule for server discovery (ms).
 * Total worst-case wait: 500 + 1000 + 2000 + 3000 = 6.5s, well within the 15s hook timeout.
 */
const RETRY_DELAYS = [500, 1000, 2000, 3000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to read the lockfile and verify the PID is alive.
 * Returns the server URL or null if the lockfile is missing/stale.
 */
function tryReadLockfile(): string | null {
  try {
    const lockPath = join(process.cwd(), ".vector-memory", "server.lock");
    const { port, pid } = JSON.parse(readFileSync(lockPath, "utf8"));

    // Stale check: signal 0 throws ESRCH if the process is gone
    process.kill(pid, 0);
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

/**
 * Discover the server URL by reading the per-repo lockfile.
 * Priority: env var > lockfile (with PID liveness check).
 *
 * Never falls back to a default port — that risks connecting to a
 * different project's server. If the lockfile isn't available after
 * retries (server still booting), returns null.
 */
export async function resolveServerUrl(): Promise<string | null> {
  if (process.env.VECTOR_MEMORY_URL) return process.env.VECTOR_MEMORY_URL;

  // First attempt (no delay)
  const immediate = tryReadLockfile();
  if (immediate) return immediate;

  // Progressive retries — the MCP server may still be booting
  for (const delay of RETRY_DELAYS) {
    debug("server-discovery", `Lockfile not found, retrying in ${delay}ms...`);
    await sleep(delay);
    const url = tryReadLockfile();
    if (url) return url;
  }

  debug("server-discovery", "Server lockfile not found after retries — skipping");
  return null;
}

// ── HTTP helpers ────────────────────────────────────────────────────

export type FetchResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; error: string };

export async function fetchJson<T>(
  baseUrl: string,
  path: string,
  options?: RequestInit & { timeout?: number }
): Promise<FetchResult<T>> {
  const { timeout = 5000, ...init } = options ?? {};
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: true, data: (await response.json()) as T, status: response.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ── Time formatting ─────────────────────────────────────────────────

export function timeAgo(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    debug("timeAgo", `invalid ISO string: ${iso}`);
    return "unknown";
  }
  const seconds = Math.floor((now - then) / 1000);
  debug("timeAgo", `iso=${iso}, now=${now}, then=${then}, delta=${seconds}s`);
  if (seconds < 0) {
    debug("timeAgo", `negative delta (${seconds}s) — clock skew or future timestamp`);
    return "just now";
  }
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Server interaction (index + waypoint) ───────────────────────────

interface HealthResponse {
  status: string;
  config: {
    dbPath: string;
    embeddingModel: string;
    embeddingDimension: number;
    historyEnabled: boolean;
  };
}

interface IndexResponse {
  indexed: number;
  skipped: number;
  errors?: string[];
}

interface WaypointResponse {
  content: string;
  metadata: Record<string, unknown>;
  referencedMemories: Array<{ id: string; content: string }>;
  updatedAt: string;
}

function warningLines(warnings: string[]): MessageLine[] {
  return warnings.map((w) => ({
    icon: icon.warning,
    iconColor: ansi.yellow,
    text: w,
  }));
}

/**
 * Discover the server, run a health check, index conversations, and load
 * the latest waypoint. Emits hook output directly.
 *
 * Used by session-start and session-clear hooks.
 */
export async function indexAndLoadWaypoint(label: string): Promise<void> {
  const userLines: MessageLine[] = [];
  const warnings: string[] = [];

  // Step 0: Discover server URL (with retries for slow boot)
  const serverUrl = await resolveServerUrl();
  if (!serverUrl) {
    debug(label, "No server discovered — prompting manual waypoint load");
    emitHookOutput({
      systemMessage: buildSystemMessage("Vector Memory", [
        {
          icon: icon.warning,
          iconColor: ansi.yellow,
          text: `Server not ready — run ${ansi.bold}/vector-memory:waypoint-get${ansi.reset} to load your waypoint manually`,
        },
      ]),
    });
    return;
  }

  // Step 1: Health check (must complete before parallel work)
  const health = await fetchJson<HealthResponse>(serverUrl, "/health");
  if (!health.ok) {
    debug(label, `Server unreachable: ${health.error}`);
    return;
  }

  debug(label, "Server healthy");

  // Steps 2 & 3: Index conversations + load waypoint in parallel
  const indexPromise = health.data.config.historyEnabled
    ? fetchJson<IndexResponse>(serverUrl, "/index-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeout: 10000,
      })
    : null;

  const waypointPromise = fetchJson<WaypointResponse>(serverUrl, "/waypoint");

  const [indexResult, waypoint] = await Promise.all([
    indexPromise,
    waypointPromise,
  ]);

  // Process indexing result
  if (indexResult) {
    if (!indexResult.ok) {
      warnings.push("Conversation indexing failed");
      debug(label, `Indexing failed: ${indexResult.error}`);
    } else if (indexResult.data.indexed > 0 || (indexResult.data.errors?.length ?? 0) > 0) {
      const d = indexResult.data;
      const errorSuffix = d.errors?.length ? `, ${d.errors.length} errors` : "";
      userLines.push({
        icon: icon.database,
        iconColor: ansi.cyan,
        text: `Indexed ${d.indexed} sessions, skipped ${d.skipped}${errorSuffix}`,
      });
      debug(label, `Indexed ${d.indexed}, skipped ${d.skipped}${errorSuffix}`);
    }
  }

  // Process waypoint result
  if (!waypoint.ok) {
    if (waypoint.status === 404) {
      userLines.push({
        icon: icon.dot,
        text: `${ansi.dim}No waypoint found — fresh session${ansi.reset}`,
      });
    } else {
      warnings.push(`Waypoint load failed: ${waypoint.error}`);
      debug(label, `Waypoint error: ${waypoint.error}`);
    }
    emit(userLines, warnings);
    return;
  }

  // Step 4: Format output
  const cp = waypoint.data;
  const age = timeAgo(cp.updatedAt);
  const branch = cp.metadata.branch as string | undefined;
  const memoryCount = cp.referencedMemories.length;

  // User-facing summary
  userLines.push({
    icon: icon.check,
    iconColor: ansi.green,
    text: `Waypoint loaded ${ansi.dim}(${age})${ansi.reset}`,
  });

  const detailParts: string[] = [];
  if (memoryCount > 0) {
    detailParts.push(`${memoryCount} ${memoryCount === 1 ? "memory" : "memories"}`);
  }
  if (branch) {
    detailParts.push(`${ansi.blue}${icon.branch} ${branch}${ansi.reset}`);
  }
  if (detailParts.length > 0) {
    userLines.push({
      icon: icon.book,
      iconColor: ansi.magenta,
      text: detailParts.join(` ${ansi.dim}${icon.dot}${ansi.reset} `),
    });
  }

  // Claude-facing context
  const contextParts: string[] = [];

  const metaParts = [`Updated: ${cp.updatedAt}`];
  if (branch) metaParts.push(`Branch: ${branch}`);
  if (cp.metadata.project) metaParts.push(`Project: ${cp.metadata.project}`);

  contextParts.push(`## Session Waypoint (${metaParts.join(" | ")})\n\n${cp.content}`);

  if (memoryCount > 0) {
    const memories = cp.referencedMemories
      .map((m) => `### Memory: ${m.id}\n${m.content}`)
      .join("\n\n");
    contextParts.push(`## Referenced Memories (${memoryCount})\n\n${memories}`);
  }

  emit(userLines, warnings, contextParts.join("\n\n"));
}

/** Emit user-facing message + optional Claude context. */
function emit(
  userLines: MessageLine[],
  warnings: string[],
  additionalContext?: string
): void {
  const allLines = [...userLines, ...warningLines(warnings)];
  if (allLines.length === 0) return;

  emitHookOutput({
    systemMessage: buildSystemMessage("Vector Memory", allLines),
    ...(additionalContext && {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  });
}
