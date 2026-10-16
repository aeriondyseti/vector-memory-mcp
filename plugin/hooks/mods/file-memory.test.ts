/**
 * Run with: claude plugin test plugin
 */

import { describe, expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";
import {
  changedMemoryFiles,
  fileMemoryArgs,
  isFileMemoryPath,
  memoryDirFromPrompt,
  memoryListing,
  parseFileMemory,
  syncedToast,
} from "./file-memory.ts";

const SERVER = "plugin:vector-memory:vector-memory";

const MEMORY_PATH = "/Users/me/.claude/projects/-Users-me-repo/memory/prefers-bun.md";

const MEMORY_FILE = `---
name: prefers-bun
description: The user prefers Bun over Node for scripts
metadata:
  type: feedback
---

Use Bun, not Node, for new scripts.
**Why:** faster startup.
`;

describe("isFileMemoryPath", () => {
  test("matches a memory file in any config dir", async () => {
    expect(isFileMemoryPath(MEMORY_PATH)).toBe(true);
    expect(isFileMemoryPath("/Users/me/.claude-work/projects/x/memory/a.md")).toBe(true);
  });

  test("skips the MEMORY.md index and other files", async () => {
    expect(isFileMemoryPath("/Users/me/.claude/projects/x/memory/MEMORY.md")).toBe(false);
    expect(isFileMemoryPath("/Users/me/.claude/projects/x/memory/notes.txt")).toBe(false);
    expect(isFileMemoryPath("/Users/me/.claude/projects/x/memory/sub/a.md")).toBe(false);
    expect(isFileMemoryPath("/repo/docs/memory.md")).toBe(false);
  });
});

describe("parseFileMemory", () => {
  test("reads name, description, metadata.type and body", async () => {
    expect(parseFileMemory(MEMORY_FILE)).toEqual({
      name: "prefers-bun",
      description: "The user prefers Bun over Node for scripts",
      type: "feedback",
      body: "Use Bun, not Node, for new scripts.\n**Why:** faster startup.",
    });
  });

  test("reads a top-level type and quoted values", async () => {
    const text = '---\nname: "a"\ndescription: \'d: e\'\ntype: user\n---\nbody';
    expect(parseFileMemory(text)).toEqual({ name: "a", description: "d: e", type: "user", body: "body" });
  });

  test("refuses a file without frontmatter, a name or a body", async () => {
    expect(parseFileMemory("just text")).toBe(null);
    expect(parseFileMemory("---\ndescription: d\n---\nbody")).toBe(null);
    expect(parseFileMemory("---\nname: a\n---\n\n")).toBe(null);
  });
});

describe("fileMemoryArgs", () => {
  test("keys the memory by name and heads it with the description", async () => {
    const memory = parseFileMemory(MEMORY_FILE);
    expect(memory).not.toBe(null);
    expect(fileMemoryArgs(memory!, MEMORY_PATH)).toEqual({
      memories: [
        {
          content:
            "The user prefers Bun over Node for scripts\n\nUse Bun, not Node, for new scripts.\n**Why:** faster startup.",
          key: "file-memory:prefers-bun",
          context: "File memory > prefers-bun",
          metadata: {
            type: "context",
            source: "file-memory",
            file_memory_type: "feedback",
            file_path: MEMORY_PATH,
            tags: ["file-memory", "feedback"],
          },
        },
      ],
    });
  });
});

describe("fileMemoryArgs embedding_text", () => {
  const first = (args: Record<string, unknown>) => (args.memories as Array<Record<string, unknown>>)[0];

  test("none up to 1000 characters of description and body", async () => {
    const body = "x".repeat(1000 - "d\n\n".length);
    expect(first(fileMemoryArgs({ name: "a", description: "d", body }, MEMORY_PATH))?.embedding_text).toBe(undefined);
  });

  test("name and description past 1000 characters", async () => {
    const body = "x".repeat(1000);
    expect(first(fileMemoryArgs({ name: "a", description: "d", body }, MEMORY_PATH))?.embedding_text).toBe("a: d");
  });

  test("the first 1000 characters past 1000 without a description", async () => {
    const body = "y".repeat(1500);
    expect(first(fileMemoryArgs({ name: "a", body }, MEMORY_PATH))?.embedding_text).toBe("y".repeat(1000));
  });
});

describe("memory folder helpers", () => {
  test("reads the memory folder from the system prompt's memory section", async () => {
    const text = "You have a persistent file-based memory at `/Users/me/.claude/projects/-Users-me-repo/memory/`. Write…";
    expect(memoryDirFromPrompt([{ id: "intro", text: "hi" }, { id: "memory", text }])).toBe(
      "/Users/me/.claude/projects/-Users-me-repo/memory"
    );
    expect(memoryDirFromPrompt([{ id: "memory", text: "no path here" }])).toBe(null);
    expect(memoryDirFromPrompt([])).toBe(null);
  });

  test("lists memory files and finds the added and changed ones", async () => {
    const before = memoryListing([
      { name: "a.md", kind: "file", size: 1, mtimeMs: 1 },
      { name: "b.md", kind: "file", size: 1, mtimeMs: 1 },
      { name: "gone.md", kind: "file", size: 1, mtimeMs: 1 },
    ]);
    const after = memoryListing([
      { name: "a.md", kind: "file", size: 1, mtimeMs: 1 },
      { name: "b.md", kind: "file", size: 2, mtimeMs: 2 },
      { name: "new.md", kind: "file", size: 1, mtimeMs: 3 },
      { name: "MEMORY.md", kind: "file", size: 1, mtimeMs: 3 },
      { name: "notes.txt", kind: "file", size: 1, mtimeMs: 3 },
      { name: "sub.md", kind: "dir", size: 0, mtimeMs: 3 },
    ]);
    expect(changedMemoryFiles(before, after)).toEqual(["b.md", "new.md"]);
  });

  test("names one synced memory, counts several, and says nothing for none", async () => {
    expect(syncedToast(["a"])).toBe('Vector Memory: synced file memory "a"');
    expect(syncedToast(["a", "b"])).toBe("Vector Memory: synced 2 file memories");
    expect(syncedToast([])).toBe(null);
  });
});

const MEMORY_DIR = "/Users/me/.claude/projects/-Users-me-repo/memory";
/** The main working tree's root, as `$.session.repo()` answers it from a worktree too. */
const REPO_ROOT = "/Users/me/repo";
const MEMORY_SECTION = `# Memory\n\nYou have a persistent file-based memory at \`${MEMORY_DIR}/\`. Write to it directly.`;

const entry = (name: string, mtimeMs: number) => ({ name, kind: "file" as const, size: 10, mtimeMs, isLink: false });

/**
 * Stand in for the engine: Write/Edit/Bash calls that succeed (or error), a
 * system prompt naming the memory folder, its listings in turn, a file on
 * disk (each read the next of `files`), the MCP server, and a mocked clock
 * the background syncs wait on.
 */
function harness(
  on: On,
  {
    files = [MEMORY_FILE],
    isError = false,
    section = MEMORY_SECTION,
    listings = [] as ReturnType<typeof entry>[][],
    repoRoot = REPO_ROOT as string | null,
    isServerStuck = false,
  } = {}
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const reads: string[] = [];
  const lists: string[] = [];
  const clock = mock.clock(on);

  const ran = () =>
    (isError ? { result: "failed", isError: true } : { result: { type: "update", filePath: MEMORY_PATH } }) as never;
  on("tool.call", { tool: "Write" }, ran);
  on("tool.call", { tool: "Edit" }, ran);
  on("tool.call", { tool: "Bash" }, ran);
  on("prompt.compose", () => ({ sections: [{ id: "memory", text: section, scope: "session" as const }] }));
  on("fs.list", (_$, e) => {
    lists.push(e.path);
    return { value: listings.shift() ?? [] };
  });
  on("fs.read", (_$, e) => {
    reads.push(e.path);
    return { value: (files.length > 1 ? files.shift() : files[0]) ?? "" };
  });
  on("session.repo", () => ({
    value: repoRoot === null ? null : { root: repoRoot, remote: null, internal: false, name: null },
  }));
  on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
  on("mcp.call", (_$, e) => {
    if (isServerStuck) return new Promise<never>(() => {}); // never answers
    calls.push({ tool: e.tool, args: e.args });
    return { value: { content: [{ type: "text", text: "Memory stored" }], isError: false } };
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  return { calls, toasts, reads, lists, clock };
}

describe("tool.call: Write and Edit", () => {
  test("a Write of a file memory stores it in the background, then toasts", async ($, on) => {
    const h = harness(on);
    const done = await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });

    expect(done.deny).toBe(undefined);
    expect(h.calls).toEqual([]); // the result came back before the sync ran

    await h.clock.settle();
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect(h.calls[0]?.args).toEqual(fileMemoryArgs(parseFileMemory(MEMORY_FILE)!, MEMORY_PATH, REPO_ROOT));
    expect(h.toasts).toEqual(['Vector Memory: synced file memory "prefers-bun"']);
  });

  test("files the memory under the main repository's root, shared by its worktrees", async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.clock.settle();
    expect((h.calls[0]?.args.memories as Array<{ project?: string }>)[0]?.project).toBe(REPO_ROOT);
  });

  test("outside a repository the server's own project is used", async ($, on) => {
    const h = harness(on, { repoRoot: null });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.clock.settle();
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect((h.calls[0]?.args.memories as Array<Record<string, unknown>>)[0]).not.toHaveProperty("project");
  });

  test("an Edit of a file memory stores the whole file", async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Edit", file_path: MEMORY_PATH, old_string: "a", new_string: "b" });
    await h.clock.settle();

    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
  });

  test("a file unchanged since its last sync is not stored again", async ($, on) => {
    const h = harness(on, { files: [MEMORY_FILE.replace("faster", "quicker")] });
    for (let i = 0; i < 2; i++) {
      await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: "x" });
      await h.clock.settle();
    }
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect(h.toasts.length).toBe(1);
  });

  test("other files, the MEMORY.md index and failed writes are not synced", async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Write", file_path: "/repo/src/a.ts", content: "x" });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH.replace("prefers-bun", "MEMORY"), content: "x" });
    await h.clock.settle();
    expect(h.calls).toEqual([]);
  });

  test("a failed write is not synced", async ($, on) => {
    const h = harness(on, { isError: true });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.clock.settle();
    expect(h.calls).toEqual([]);
  });

  test("a file without frontmatter is not synced", async ($, on) => {
    const h = harness(on, { files: ["no frontmatter"] });
    const done = await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: "no frontmatter" });
    await h.clock.settle();
    expect(done.deny).toBe(undefined);
    expect(h.calls).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test("off: nothing is synced", { options: { fileMemorySync: "off" } }, async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.clock.settle();
    expect(h.calls).toEqual([]);
  });
});

describe("session.end", () => {
  test("finishes queued syncs before the session ends", async ($, on) => {
    const h = harness(on);
    let endedAfterSync = false;
    on("session.end", () => {
      endedAfterSync = h.calls.length === 1;
      return { sessionId: "s" };
    });

    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    expect(h.calls).toEqual([]); // its timer has not fired: the clock never moved

    await $.session.end({ reason: "other", sessionId: "s", resume: { id: "s" } });
    expect(endedAfterSync).toBe(true);
    expect(h.toasts).toEqual(['Vector Memory: synced file memory "prefers-bun"']);
  });

  test("a sync that never finishes does not hold the session past its budget", async ($, on) => {
    const h = harness(on, { isServerStuck: true });
    let ended = false;
    on("session.end", () => {
      ended = true;
      return { sessionId: "s" };
    });

    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    const ending = $.session.end({ reason: "other", sessionId: "s", resume: { id: "s" } });
    await h.clock.advance(10_000);
    await ending;
    expect(ended).toBe(true);
    expect(h.toasts).toEqual([]);
  });

  test("ends at once when nothing is queued", async ($, on) => {
    const h = harness(on);
    let ended = false;
    on("session.end", () => {
      ended = true;
      return { sessionId: "s" };
    });
    await $.session.end({ reason: "prompt_input_exit", sessionId: "s", resume: { id: "s" } });
    expect(ended).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

describe("tool.call: Bash", () => {
  const other = (name: string) => MEMORY_FILE.replace("name: prefers-bun", `name: ${name}`);

  test("syncs the memory files a command added or changed, with one toast", async ($, on) => {
    const h = harness(on, {
      files: [other("a"), other("new")],
      listings: [
        [entry("a.md", 1), entry("b.md", 1)],
        [entry("a.md", 2), entry("b.md", 1), entry("new.md", 2), entry("MEMORY.md", 2)],
      ],
    });
    await $.tool.call({ tool: "Bash", command: 'cat > "$DIR/a.md" <<EOF ... EOF' });
    await h.clock.settle();

    expect(h.lists).toEqual([MEMORY_DIR, MEMORY_DIR]);
    expect(h.reads).toEqual([`${MEMORY_DIR}/a.md`, `${MEMORY_DIR}/new.md`]);
    expect(h.calls.map((c) => (c.args.memories as Array<{ key: string }>)[0]?.key)).toEqual([
      "file-memory:a",
      "file-memory:new",
    ]);
    expect(h.toasts).toEqual(["Vector Memory: synced 2 file memories"]);
  });

  test("still syncs when the command failed after writing", async ($, on) => {
    const h = harness(on, { isError: true, listings: [[], [entry("prefers-bun.md", 1)]] });
    await $.tool.call({ tool: "Bash", command: "write-then-fail" });
    await h.clock.settle();
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
  });

  test("without a memory folder in the system prompt, Bash is left alone", async ($, on) => {
    const h = harness(on, { section: "No file-based memory here.", listings: [[], [entry("a.md", 1)]] });
    const done = await $.tool.call({ tool: "Bash", command: "ls" });
    await h.clock.settle();
    expect(done.deny).toBe(undefined);
    expect(h.lists).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("a command that touched no memory file syncs nothing", async ($, on) => {
    const same = [entry("a.md", 1)];
    const h = harness(on, { listings: [same, same] });
    await $.tool.call({ tool: "Bash", command: "ls" });
    await h.clock.settle();
    expect(h.reads).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});
