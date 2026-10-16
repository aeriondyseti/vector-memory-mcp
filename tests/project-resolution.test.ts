import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveProject } from "../server/core/project";

// Expectations mirror what Claude Code's `$.session.repo().root` answered from
// each of these folders (probed on Claude Code 2.1.301, 2026-10-16): the main
// working tree's root as a real path, from the checkout, any subdirectory, any
// linked worktree (under .claude/worktrees or elsewhere) and through symlinks;
// null outside a repository, where the server keeps the folder itself.

let base: string;
let real: string;

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

beforeAll(() => {
  // tmpdir() is a symlink on macOS (/var -> /private/var), so `base` reaches
  // the fixture through one; `real` is the path the engine answers with.
  base = mkdtempSync(join(tmpdir(), "vm-project-"));
  real = realpathSync(base);
  const main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(main, "sub"));
  git(main, "worktree", "add", "-q", join(main, ".claude", "worktrees", "wt"), "-b", "wt");
  mkdirSync(join(main, ".claude", "worktrees", "wt", "sub"));
  git(main, "worktree", "add", "-q", join(base, "elsewhere-wt"), "-b", "elsewhere");
  symlinkSync(main, join(base, "link"));
  mkdirSync(join(base, "plain"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveProject", () => {
  const cases: Array<[string, string]> = [
    ["the main checkout", "main"],
    ["a subdirectory of the main checkout", "main/sub"],
    ["a Claude Code worktree", "main/.claude/worktrees/wt"],
    ["a subdirectory of a worktree", "main/.claude/worktrees/wt/sub"],
    ["a worktree outside the repository", "elsewhere-wt"],
    ["a symlink to the checkout", "link"],
    ["a subdirectory through a symlink", "link/sub"],
  ];

  for (const [name, path] of cases) {
    test(`answers the main working tree's real root from ${name}`, () => {
      expect(resolveProject(join(base, path))).toBe(join(real, "main"));
    });
  }

  test("keeps a folder outside any repository as itself", () => {
    expect(resolveProject(join(real, "plain"))).toBe(join(real, "plain"));
  });

  test("folds a deleted Claude Code worktree into its repository by path", () => {
    expect(resolveProject("/gone/repo/.claude/worktrees/old/src")).toBe("/gone/repo");
  });

  test("keeps any other deleted folder as itself", () => {
    expect(resolveProject("/gone/elsewhere-wt/")).toBe("/gone/elsewhere-wt");
  });
});
