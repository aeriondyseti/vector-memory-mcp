/**
 * Run with: claude plugin test plugin
 */

import { describe, expect, test } from "claude-code/testing";
import type { On } from "claude-code";
import { fileMemoryArgs, isFileMemoryPath, parseFileMemory } from "./file-memory.ts";

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

/** Stand in for the engine: a Write/Edit that succeeds (or errors), a file on disk, the MCP server. */
function harness(on: On, { file = MEMORY_FILE, isError = false } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const wrote = () =>
    (isError ? { result: "failed", isError: true } : { result: { type: "update", filePath: MEMORY_PATH } }) as never;
  on("tool.call", { tool: "Write" }, wrote);
  on("tool.call", { tool: "Edit" }, wrote);
  on("fs.read", () => ({ value: file }));
  on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
  on("mcp.call", (_$, e) => {
    calls.push({ tool: e.tool, args: e.args });
    return { value: { content: [{ type: "text", text: "Memory stored" }], isError: false } };
  });
  return calls;
}

describe("tool.call", () => {
  test("a Write of a file memory stores it", async ($, on) => {
    const calls = harness(on);
    const done = await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });

    expect(done.deny).toBe(undefined);
    expect(calls.map((c) => c.tool)).toEqual(["store_memories"]);
    expect(calls[0]?.args).toEqual(fileMemoryArgs(parseFileMemory(MEMORY_FILE)!, MEMORY_PATH));
  });

  test("an Edit of a file memory stores the whole file", async ($, on) => {
    const calls = harness(on);
    await $.tool.call({ tool: "Edit", file_path: MEMORY_PATH, old_string: "a", new_string: "b" });

    expect(calls.map((c) => c.tool)).toEqual(["store_memories"]);
  });

  test("other files, the MEMORY.md index and failed writes are not synced", async ($, on) => {
    const calls = harness(on);
    await $.tool.call({ tool: "Write", file_path: "/repo/src/a.ts", content: "x" });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH.replace("prefers-bun", "MEMORY"), content: "x" });
    expect(calls).toEqual([]);
  });

  test("a failed write is not synced", async ($, on) => {
    const calls = harness(on, { isError: true });
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    expect(calls).toEqual([]);
  });

  test("a file without frontmatter is not synced", async ($, on) => {
    const calls = harness(on, { file: "no frontmatter" });
    const done = await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: "no frontmatter" });
    expect(done.deny).toBe(undefined);
    expect(calls).toEqual([]);
  });

  test("off: nothing is synced", { options: { fileMemorySync: "off" } }, async ($, on) => {
    const calls = harness(on);
    await $.tool.call({ tool: "Write", file_path: MEMORY_PATH, content: MEMORY_FILE });
    expect(calls).toEqual([]);
  });
});
