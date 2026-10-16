/**
 * Run with: claude plugin test plugin
 */

import { describe, expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";
import {
  changedMemoryFiles,
  fileMemoryArgs,
  isStoredReply,
  memoryDirFromPrompt,
  memoryFileName,
  memoryListing,
  parseFileMemory,
  syncedToast,
} from "./file-memory.ts";

const SERVER = "plugin:vector-memory:vector-memory";

const MEMORY_DIR = "/Users/me/.claude/projects/-Users-me-repo/memory";
const MEMORY_PATH = `${MEMORY_DIR}/prefers-bun.md`;

const MEMORY_FILE = `---
name: prefers-bun
description: The user prefers Bun over Node for scripts
metadata:
  type: feedback
---

Use Bun, not Node, for new scripts.
**Why:** faster startup.
`;

describe("memoryFileName", () => {
  test("names a file directly in the memory folder", async () => {
    expect(memoryFileName(MEMORY_PATH, MEMORY_DIR)).toBe("prefers-bun.md");
    expect(memoryFileName(MEMORY_PATH, `${MEMORY_DIR}/`)).toBe("prefers-bun.md");
    expect(memoryFileName("C:\\Users\\me\\.claude\\projects\\x\\memory\\a.md", "C:\\Users\\me\\.claude\\projects\\x\\memory")).toBe(
      "a.md"
    );
  });

  test("refuses the MEMORY.md index, other files, subfolders and look-alike folders", async () => {
    expect(memoryFileName(`${MEMORY_DIR}/MEMORY.md`, MEMORY_DIR)).toBe(null);
    expect(memoryFileName(`${MEMORY_DIR}/notes.txt`, MEMORY_DIR)).toBe(null);
    expect(memoryFileName(`${MEMORY_DIR}/sub/a.md`, MEMORY_DIR)).toBe(null);
    expect(memoryFileName(`${MEMORY_DIR}-old/a.md`, MEMORY_DIR)).toBe(null);
    // A repo's own folder of the same shape is not the memory folder.
    expect(memoryFileName("/home/me/projects/app/memory/notes.md", MEMORY_DIR)).toBe(null);
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

  test("reads folded and literal block values", async () => {
    const folded = "---\nname: a\ndescription: >\n  first line\n  second line\ntype: user\n---\nbody";
    expect(parseFileMemory(folded)?.description).toBe("first line second line");
    expect(parseFileMemory(folded)?.type).toBe("user");
    const literal = "---\nname: a\ndescription: |-\n  one\n  two\n---\nbody";
    expect(parseFileMemory(literal)?.description).toBe("one\ntwo");
  });

  test("tolerates a byte-order mark, CRLF lines and trailing comments", async () => {
    const text = "\uFEFF---\r\nname: a\r\nmetadata:\r\n  type: user # who they are\r\n---\r\nbody\r\n";
    expect(parseFileMemory(text)).toEqual({ name: "a", type: "user", body: "body" });
  });

  test("reads only one level of nesting", async () => {
    const text = "---\nname: a\nmetadata:\n  type: feedback\n  extra:\n    type: deep\n---\nbody";
    expect(parseFileMemory(text)?.type).toBe("feedback");
  });

  test("refuses a file without frontmatter, a name or a body", async () => {
    expect(parseFileMemory("just text")).toBe(null);
    expect(parseFileMemory("---\ndescription: d\n---\nbody")).toBe(null);
    expect(parseFileMemory("---\nname: a\n---\n\n")).toBe(null);
  });
});

describe("fileMemoryArgs", () => {
  test("keys the memory by path, allows near-duplicates and heads it with the description", async () => {
    const memory = parseFileMemory(MEMORY_FILE);
    expect(memory).not.toBe(null);
    expect(fileMemoryArgs(memory!, MEMORY_PATH)).toEqual({
      allow_duplicates: true,
      memories: [
        {
          content:
            "The user prefers Bun over Node for scripts\n\nUse Bun, not Node, for new scripts.\n**Why:** faster startup.",
          key: `file-memory:${MEMORY_PATH}`,
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

  test("past 1000 characters: name, description, then as much of the body as fits", async () => {
    const body = "x".repeat(1000);
    const text = first(fileMemoryArgs({ name: "a", description: "d", body }, MEMORY_PATH))?.embedding_text as string;
    expect(text.startsWith("a: d\n\nxxx")).toBe(true);
    expect(text.length).toBe(1000);
  });

  test("the first 1000 characters past 1000 without a description", async () => {
    const body = "y".repeat(1500);
    expect(first(fileMemoryArgs({ name: "a", body }, MEMORY_PATH))?.embedding_text).toBe("y".repeat(1000));
  });
});

describe("memory folder helpers", () => {
  test("reads the memory folder from the system prompt's memory section only", async () => {
    const text = `You have a persistent file-based memory at \`${MEMORY_DIR}/\`. Write…`;
    expect(memoryDirFromPrompt([{ id: "intro", text: "hi" }, { id: "memory", text }])).toBe(MEMORY_DIR);
    expect(memoryDirFromPrompt([{ id: "memory", text: "no path here" }])).toBe(null);
    expect(memoryDirFromPrompt([])).toBe(null);
    // A path in another section (CLAUDE.md, a skill) is never taken for it.
    const claudeMd = { id: "claude_md", text: "see `/Users/x/projects/foo/memory` in your repo" };
    expect(memoryDirFromPrompt([claudeMd, { id: "memory", text: "nothing" }])).toBe(null);
  });

  test("takes the first folder a memory section names (the private one, ahead of a team folder)", async () => {
    const team = "/Users/me/.claude/projects/-Users-me-repo/team/memory";
    const text = `You have a persistent file-based memory at \`${MEMORY_DIR}/\`. Team memories live at \`${team}/\`.`;
    expect(memoryDirFromPrompt([{ id: "memory", text }])).toBe(MEMORY_DIR);
  });

  test("knows a stored reply from a skipped duplicate", async () => {
    expect(isStoredReply("Memory stored with ID: 123")).toBe(true);
    expect(isStoredReply('Not stored: duplicate of existing memory 123:\n  "x"')).toBe(false);
    expect(isStoredReply("")).toBe(false);
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
    /** What `store_memories` answers. */
    reply = "Memory stored with ID: 00000000-0000-0000-0000-000000000001",
    isConnected = true,
    /** How many `prompt.compose` calls fail before one succeeds. */
    composeFailures = 0,
    /** How many `fs.read` calls fail before one succeeds. */
    readFailures = 0,
  } = {}
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const reads: string[] = [];
  const lists: string[] = [];
  const clock = mock.clock(on);
  let activity = 0;

  /**
   * Let the background syncs run: the timer fires on the first settle, but
   * the job's `$` calls cross to the plugin's worker and back, so one settle
   * is not always enough. With `until`, settle until it holds; without,
   * until nothing reaches these hooks for several rounds.
   */
  async function settle(until?: () => boolean): Promise<void> {
    for (let rounds = 0, quiet = 0; rounds < 500; rounds++) {
      if (until?.()) return;
      if (!until && quiet >= 10) return;
      const seen = activity;
      await clock.settle();
      quiet = activity === seen ? quiet + 1 : 0;
    }
    throw new Error("the background sync never finished");
  }

  const ran = () =>
    (isError ? { result: "failed", isError: true } : { result: { type: "update", filePath: MEMORY_PATH } }) as never;
  on("tool.call", { tool: "Write" }, ran);
  on("tool.call", { tool: "Edit" }, ran);
  on("tool.call", { tool: "Bash" }, ran);
  on("prompt.compose", () => {
    activity++;
    if (composeFailures-- > 0) throw new Error("compose failed");
    return { sections: [{ id: "memory", text: section, scope: "session" as const }] };
  });
  on("fs.list", (_$, e) => {
    activity++;
    lists.push(e.path);
    return { value: listings.shift() ?? [] };
  });
  on("fs.read", (_$, e) => {
    activity++;
    reads.push(e.path);
    if (readFailures-- > 0) return { deny: "read failed" };
    return { value: (files.length > 1 ? files.shift() : files[0]) ?? "" };
  });
  on("mcp.connect", () => {
    activity++;
    return {
      value: isConnected
        ? { isConnected: true as const, server: SERVER }
        : { isConnected: false as const, reason: "disabled" as const, message: "off" },
    };
  });
  on("mcp.call", (_$, e) => {
    activity++;
    calls.push({ tool: e.tool, args: e.args });
    return { value: { content: [{ type: "text", text: reply }], isError: false } };
  });
  on("ui.toast", (_$, e) => {
    activity++;
    toasts.push(e.text);
    return { value: undefined };
  });
  return { calls, toasts, reads, lists, settle };
}

describe("tool.call: Write and Edit", () => {
  test("a Write of a file memory stores it in the background, then toasts", async ($, on) => {
    const h = harness(on);
    const done = await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });

    expect(done.deny).toBe(undefined);
    expect(h.calls).toEqual([]); // the result came back before the sync ran

    await h.settle(() => h.toasts.length > 0);
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect(h.calls[0]?.args).toEqual(fileMemoryArgs(parseFileMemory(MEMORY_FILE)!, MEMORY_PATH));
    expect(h.toasts).toEqual(['Vector Memory: synced file memory "prefers-bun"']);
  });

  // The harness answers no `session.repo`: were the plugin to ask the engine
  // for the repository again, the sync would fail and so would this test.
  test("leaves the project to the server, which resolves a worktree to its main repository", async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.settle(() => h.toasts.length > 0);
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect((h.calls[0]?.args.memories as Array<Record<string, unknown>>)[0]).not.toHaveProperty("project");
  });

  test("an Edit of a file memory stores the whole file", async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Edit", file_path: MEMORY_PATH, old_string: "a", new_string: "b" });
    await h.settle(() => h.toasts.length > 0);

    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
  });

  test("a file unchanged since its last sync is not stored again", async ($, on) => {
    const h = harness(on, { files: [MEMORY_FILE.replace("faster", "quicker")] });
    for (let i = 0; i < 2; i++) {
      await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: "x" });
      await h.settle(() => h.reads.length > i);
    }
    await h.settle();
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect(h.toasts.length).toBe(1);
  });

  test("other files, the MEMORY.md index and failed writes are not synced", async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Write", file_path: "/repo/src/a.ts", content: "x" });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH.replace("prefers-bun", "MEMORY"), content: "x" });
    await h.settle();
    expect(h.calls).toEqual([]);
  });

  test("a failed write is not synced", async ($, on) => {
    const h = harness(on, { isError: true });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.settle();
    expect(h.calls).toEqual([]);
  });

  test("a file without frontmatter is not synced", async ($, on) => {
    const h = harness(on, { files: ["no frontmatter"] });
    const done = await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: "no frontmatter" });
    await h.settle();
    expect(done.deny).toBe(undefined);
    expect(h.calls).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test("a reply that stored nothing is not counted: no toast, and the next save tries again", async ($, on) => {
    const h = harness(on, { reply: 'Not stored: duplicate of existing memory 123:\n  "x"' });
    for (let i = 1; i <= 2; i++) {
      await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
      await h.settle(() => h.calls.length >= i);
    }
    await h.settle();
    expect(h.calls.length).toBe(2);
    expect(h.toasts).toEqual([]);
  });

  test("with the server not connected, nothing is stored and nothing is toasted", async ($, on) => {
    const h = harness(on, { isConnected: false });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.settle();
    expect(h.calls).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test("a repo's own projects/x/memory folder is not the memory folder", async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Write", file_path: "/home/me/projects/app/memory/notes.md", content: MEMORY_FILE });
    await h.settle();
    expect(h.reads).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("without a memory folder in the system prompt, a Write is not synced", async ($, on) => {
    const h = harness(on, { section: "No file-based memory here." });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.settle();
    expect(h.calls).toEqual([]);
  });

  test("a failed memory folder lookup is tried again on the next call", async ($, on) => {
    const h = harness(on, { composeFailures: 1 });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.settle();
    expect(h.calls).toEqual([]);

    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.settle(() => h.toasts.length > 0);
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
  });

  test("a sync that fails does not hold up the next one", async ($, on) => {
    const h = harness(on, { readFailures: 1 });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await $.tool.call({ tool: "Edit", file_path: MEMORY_PATH, old_string: "a", new_string: "b" });
    await h.settle(() => h.toasts.length > 0);
    expect(h.reads.length).toBe(2);
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
  });

  test("off: nothing is synced", { options: { fileMemorySync: "off" } }, async ($, on) => {
    const h = harness(on);
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    await h.settle();
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
    await h.settle(() => h.toasts.length > 0);

    expect(h.lists).toEqual([MEMORY_DIR, MEMORY_DIR]);
    expect(h.reads).toEqual([`${MEMORY_DIR}/a.md`, `${MEMORY_DIR}/new.md`]);
    expect(h.calls.map((c) => (c.args.memories as Array<{ key: string }>)[0]?.key)).toEqual([
      `file-memory:${MEMORY_DIR}/a.md`,
      `file-memory:${MEMORY_DIR}/new.md`,
    ]);
    expect(h.toasts).toEqual(["Vector Memory: synced 2 file memories"]);
  });

  test("still syncs when the command failed after writing", async ($, on) => {
    const h = harness(on, { isError: true, listings: [[], [entry("prefers-bun.md", 1)]] });
    await $.tool.call({ tool: "Bash", command: "write-then-fail" });
    await h.settle(() => h.toasts.length > 0);
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
  });

  test("without a memory folder in the system prompt, Bash is left alone", async ($, on) => {
    const h = harness(on, { section: "No file-based memory here.", listings: [[], [entry("a.md", 1)]] });
    const done = await $.tool.call({ tool: "Bash", command: "ls" });
    await h.settle();
    expect(done.deny).toBe(undefined);
    expect(h.lists).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("two Bash calls running together that both see a file change store it once", async ($, on) => {
    const h = harness(on, { listings: [[], [], [entry("prefers-bun.md", 1)], [entry("prefers-bun.md", 1)]] });
    await Promise.all([
      $.tool.call({ tool: "Bash", command: "first" }),
      $.tool.call({ tool: "Bash", command: "second" }),
    ]);
    await h.settle(() => h.lists.length === 4);
    await h.settle();
    expect(h.calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect(h.toasts.length).toBe(1);
  });

  test("a command that touched no memory file syncs nothing", async ($, on) => {
    const same = [entry("a.md", 1)];
    const h = harness(on, { listings: [same, same] });
    await $.tool.call({ tool: "Bash", command: "ls" });
    await h.settle();
    expect(h.reads).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});
