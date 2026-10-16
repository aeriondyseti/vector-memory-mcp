import { existsSync } from "fs";
import { basename, dirname } from "path";

/**
 * Canonical project identifier: the normalized absolute path of the project
 * root (e.g. `/home/user/Development/my-repo`).
 *
 * This exact function must be used everywhere a project value is produced or
 * compared — memory stamping, waypoint ID hashing, search filters, the
 * consolidation re-key, and the hooks' `?project=` param — so values join
 * byte-for-byte across subsystems.
 */
export function normalizeProject(value: string): string {
  let p = value.trim();
  if (p.length === 0) return "";
  // Collapse trailing slashes (but keep bare root "/")
  p = p.replace(/\/+$/, "");
  if (p.length === 0) return "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

// A Claude Code worktree path, kept usable after the folder is deleted.
const CLAUDE_WORKTREE = /^(.*)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/;

const resolved = new Map<string, string>();

function git(cwd: string, ...args: string[]): string | null {
  try {
    const run = Bun.spawnSync(["git", "-C", cwd, "rev-parse", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    const out = run.stdout.toString().trim();
    return run.exitCode === 0 && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * The project a folder belongs to: its git repository's root, the main
 * working tree's for a linked worktree, as a real path. This is what Claude
 * Code's `$.session.repo().root` answers, so rows the plugin files under the
 * repo root join the server's own. Outside a repository, the folder itself.
 */
export function resolveProject(cwd: string): string {
  const cached = resolved.get(cwd);
  if (cached !== undefined) return cached;

  let project: string;
  const commonDir = git(cwd, "--path-format=absolute", "--git-common-dir");
  if (commonDir !== null && basename(commonDir) === ".git") {
    project = normalizeProject(dirname(commonDir));
  } else if (commonDir !== null) {
    // A bare repository's worktree or a submodule: no main checkout to fold into.
    project = normalizeProject(git(cwd, "--show-toplevel") ?? cwd);
  } else {
    const match = existsSync(cwd) ? null : CLAUDE_WORKTREE.exec(cwd);
    project = normalizeProject(match ? match[1]! : cwd);
  }

  resolved.set(cwd, project);
  return project;
}

/** Short human-readable name for a project path. */
export function projectDisplayName(project: string): string {
  return basename(project) || project;
}
