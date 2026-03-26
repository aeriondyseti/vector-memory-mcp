/**
 * Shared text formatting utilities.
 *
 * Provides ANSI styling, Nerd Font icons, horizontal rules, structured
 * message builders, debug logging, and time formatting. Used by both the
 * MCP server and the Claude Code plugin hooks.
 */

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

// ── Diagnostic logging ──────────────────────────────────────────────

/**
 * Log a diagnostic message to stderr (visible in verbose/debug mode).
 */
export function debug(label: string, message: string): void {
  console.error(
    `${ansi.gray}[${label}]${ansi.reset} ${ansi.dim}${message}${ansi.reset}`
  );
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
