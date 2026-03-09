import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSessionFile,
  discoverSessionFiles,
  detectSessionPath,
  type ParsedMessage,
} from "../src/services/session-parser.js";
import { userLine, assistantLine } from "./utils/test-helpers.js";

function progressLine(): string {
  return JSON.stringify({
    type: "progress",
    data: { tool: "bash", content: "running..." },
    timestamp: "2026-03-09T10:00:30Z",
  });
}

function systemLine(): string {
  return JSON.stringify({
    type: "system",
    message: { role: "system", content: "System prompt" },
    timestamp: "2026-03-09T09:59:00Z",
  });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "session-parser-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("parseSessionFile", () => {
  it("extracts user string messages and assistant text blocks", async () => {
    const filePath = join(tmpDir, "sess-1.jsonl");
    const lines = [
      userLine("Hello, how are you?"),
      assistantLine([{ type: "text", text: "I'm doing well!" }]),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);

    expect(result.sessionId).toBe("sess-1");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: "Hello, how are you?",
      messageIndex: 0,
    });
    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      content: "I'm doing well!",
      messageIndex: 1,
    });
  });

  it("skips non-user/assistant lines (progress, system, file-history-snapshot)", async () => {
    const filePath = join(tmpDir, "sess-2.jsonl");
    const lines = [
      progressLine(),
      systemLine(),
      JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
      userLine("Only real message"),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Only real message");
  });

  it("skips tool_use and thinking blocks from assistant messages", async () => {
    const filePath = join(tmpDir, "sess-3.jsonl");
    const lines = [
      assistantLine([
        { type: "thinking", text: "Let me think..." },
        { type: "tool_use" },
        { type: "text", text: "Here is the answer." },
      ]),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Here is the answer.");
  });

  it("concatenates multiple text blocks in a single assistant message", async () => {
    const filePath = join(tmpDir, "sess-4.jsonl");
    const lines = [
      assistantLine([
        { type: "text", text: "First part." },
        { type: "tool_use" },
        { type: "text", text: "Second part." },
      ]),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("First part.\nSecond part.");
  });

  it("skips assistant messages with only tool_use/thinking (no text)", async () => {
    const filePath = join(tmpDir, "sess-5.jsonl");
    const lines = [
      assistantLine([{ type: "thinking", text: "Hmm..." }, { type: "tool_use" }]),
      userLine("Follow-up question"),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].messageIndex).toBe(0);
  });

  it("skips empty/whitespace-only user messages", async () => {
    const filePath = join(tmpDir, "sess-6.jsonl");
    const lines = [
      userLine(""),
      userLine("   "),
      userLine("Actual message"),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Actual message");
  });

  it("captures timestamps, gitBranch, and project from lines", async () => {
    const filePath = join(tmpDir, "sess-7.jsonl");
    const lines = [
      userLine("msg1", {
        timestamp: "2026-03-09T08:00:00Z",
        gitBranch: "feature/foo",
        cwd: "/home/user/my-project",
      }),
      userLine("msg2", { timestamp: "2026-03-09T09:00:00Z" }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.gitBranch).toBe("feature/foo");
    expect(result.project).toBe("/home/user/my-project");
    expect(result.firstMessageAt).toEqual(new Date("2026-03-09T08:00:00Z"));
    expect(result.lastMessageAt).toEqual(new Date("2026-03-09T09:00:00Z"));
  });

  it("handles malformed JSON lines gracefully", async () => {
    const filePath = join(tmpDir, "sess-8.jsonl");
    const lines = [
      "not valid json",
      "{also bad",
      userLine("Valid message"),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Valid message");
  });

  it("supports incremental parsing with fromByte and startIndex", async () => {
    const filePath = join(tmpDir, "sess-9.jsonl");
    const line1 = userLine("First message", { timestamp: "2026-03-09T08:00:00Z" });
    const line2 = userLine("Second message", { timestamp: "2026-03-09T09:00:00Z" });
    const fullContent = line1 + "\n" + line2 + "\n";
    await writeFile(filePath, fullContent);

    // Calculate byte offset after first line
    const firstLineBytes = Buffer.byteLength(line1 + "\n", "utf-8");

    const result = await parseSessionFile(filePath, firstLineBytes, 1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Second message");
    expect(result.messages[0].messageIndex).toBe(1);
  });

  it("returns empty messages for a file with no user/assistant content", async () => {
    const filePath = join(tmpDir, "sess-10.jsonl");
    const lines = [progressLine(), systemLine()];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(0);
    expect(result.firstMessageAt).toBeNull();
    expect(result.lastMessageAt).toBeNull();
  });

  it("includes per-message metadata (gitBranch, cwd)", async () => {
    const filePath = join(tmpDir, "sess-11.jsonl");
    const lines = [
      userLine("msg", { gitBranch: "dev", cwd: "/proj" }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    expect(result.messages[0].metadata).toEqual({
      gitBranch: "dev",
      cwd: "/proj",
    });
  });

  it("assigns unique UUIDs to each message", async () => {
    const filePath = join(tmpDir, "sess-12.jsonl");
    const lines = [
      userLine("msg1"),
      userLine("msg2"),
      userLine("msg3"),
    ];
    await writeFile(filePath, lines.join("\n") + "\n");

    const result = await parseSessionFile(filePath);
    const ids = result.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("discoverSessionFiles", () => {
  it("discovers .jsonl files in a directory", async () => {
    await writeFile(join(tmpDir, "abc.jsonl"), "{}");
    await writeFile(join(tmpDir, "def.jsonl"), "{}");
    await writeFile(join(tmpDir, "readme.txt"), "ignore me");

    const files = await discoverSessionFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.sessionId).sort()).toEqual(["abc", "def"]);
  });

  it("returns empty array for non-existent directory", async () => {
    const files = await discoverSessionFiles("/nonexistent/path");
    expect(files).toHaveLength(0);
  });

  it("skips subdirectories even if named .jsonl", async () => {
    await mkdir(join(tmpDir, "fake.jsonl"));
    await writeFile(join(tmpDir, "real.jsonl"), "{}");

    const files = await discoverSessionFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe("real");
  });

  it("includes file size in results", async () => {
    const content = userLine("hello");
    await writeFile(join(tmpDir, "sized.jsonl"), content);

    const files = await discoverSessionFiles(tmpDir);
    expect(files[0].fileSize).toBe(Buffer.byteLength(content, "utf-8"));
  });
});

describe("detectSessionPath", () => {
  it("returns a path containing .claude/projects", () => {
    const result = detectSessionPath();
    expect(result).toContain(".claude");
    expect(result).toContain("projects");
  });
});
