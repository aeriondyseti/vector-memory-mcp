import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { ClaudeCodeSessionParser } from "../server/core/parsers/claude-code.parser";

const TEST_DIR = join(import.meta.dir, ".test-sessions");
const PROJECT_DIR = join(TEST_DIR, "-home-user-project");

function writeJsonl(filePath: string, entries: object[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(filePath, content);
}

describe("ClaudeCodeSessionParser", () => {
  let parser: ClaudeCodeSessionParser;

  beforeEach(() => {
    parser = new ClaudeCodeSessionParser();
    mkdirSync(PROJECT_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("parse", () => {
    test("extracts user messages with string content", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Hello world" },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello world");
      expect(messages[0].messageIndex).toBe(0);
    });

    test("extracts assistant text blocks, skips thinking and tool_use", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "assistant",
          uuid: "msg-2",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:01:00Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Internal reasoning" },
              { type: "text", text: "Here is my response" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: { command: "ls" },
              },
              { type: "text", text: "And more text" },
            ],
          },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].content).toBe("Here is my response\nAnd more text");
    });

    test("skips user messages with tool_result content (arrays)", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Hello" },
          isSidechain: false,
        },
        {
          type: "user",
          uuid: "msg-3",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:02:00Z",
          message: {
            role: "user",
            content: [
              { tool_use_id: "tool-1", type: "tool_result", content: "OK" },
            ],
          },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello");
    });

    test("skips progress and file-history-snapshot entries", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "file-history-snapshot",
          messageId: "snap-1",
          snapshot: { messageId: "snap-1", trackedFileBackups: {} },
        },
        {
          type: "progress",
          data: { type: "hook_progress" },
          uuid: "prog-1",
        },
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Real message" },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Real message");
    });

    test("skips sidechain messages by default", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Main message" },
          isSidechain: false,
        },
        {
          type: "user",
          uuid: "msg-2",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:01:00Z",
          message: { role: "user", content: "Subagent message" },
          isSidechain: true,
          agentId: "agent-123",
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Main message");
    });

    test("includes sidechain messages when indexSubagents is true", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Main message" },
          isSidechain: false,
        },
        {
          type: "user",
          uuid: "msg-2",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:01:00Z",
          message: { role: "user", content: "Subagent message" },
          isSidechain: true,
          agentId: "agent-123",
        },
      ]);

      const messages = await parser.parse(filePath, true);
      expect(messages).toHaveLength(2);
    });

    test("skips assistant messages with no text content", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "assistant",
          uuid: "msg-1",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Read",
                input: { file_path: "/tmp" },
              },
            ],
          },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(0);
    });

    test("handles malformed JSONL lines gracefully", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeFileSync(
        filePath,
        `{"type":"user","uuid":"msg-1","sessionId":"s1","timestamp":"2026-03-03T10:00:00Z","message":{"role":"user","content":"Good"},"isSidechain":false}
not valid json
{"type":"user","uuid":"msg-2","sessionId":"s1","timestamp":"2026-03-03T10:01:00Z","message":{"role":"user","content":"Also good"},"isSidechain":false}`
      );

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(2);
    });

    test("extracts project name from path-encoded directory", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Test" },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages[0].project).toBe("home/user/project");
    });

    test("tracks message indices correctly", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "s1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "First" },
          isSidechain: false,
        },
        {
          type: "assistant",
          uuid: "msg-2",
          sessionId: "s1",
          timestamp: "2026-03-03T10:01:00Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Second" }],
          },
          isSidechain: false,
        },
        {
          type: "user",
          uuid: "msg-3",
          sessionId: "s1",
          timestamp: "2026-03-03T10:02:00Z",
          message: { role: "user", content: "Third" },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(3);
      expect(messages[0].messageIndex).toBe(0);
      expect(messages[1].messageIndex).toBe(1);
      expect(messages[2].messageIndex).toBe(2);
    });
  });

  describe("findSessionFiles", () => {
    test("finds JSONL files with UUID names", async () => {
      const sessionFile = join(
        PROJECT_DIR,
        "11111111-2222-3333-4444-555555555555.jsonl"
      );
      writeFileSync(sessionFile, "{}");

      const files = await parser.findSessionFiles(TEST_DIR);
      expect(files).toHaveLength(1);
      expect(files[0].sessionId).toBe("11111111-2222-3333-4444-555555555555");
      expect(files[0].project).toBe("home/user/project");
    });

    test("skips non-UUID JSONL files", async () => {
      writeFileSync(join(PROJECT_DIR, "not-a-uuid.jsonl"), "{}");
      writeFileSync(
        join(
          PROJECT_DIR,
          "11111111-2222-3333-4444-555555555555.jsonl"
        ),
        "{}"
      );

      const files = await parser.findSessionFiles(TEST_DIR);
      expect(files).toHaveLength(1);
    });

    test("filters by since date", async () => {
      const oldFile = join(
        PROJECT_DIR,
        "11111111-2222-3333-4444-555555555555.jsonl"
      );
      const newFile = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeFileSync(oldFile, "{}");
      writeFileSync(newFile, "{}");

      // Use a future date to filter out both
      const futureDate = new Date("2099-01-01");
      const files = await parser.findSessionFiles(TEST_DIR, futureDate);
      expect(files).toHaveLength(0);
    });

    test("returns empty for nonexistent directory", async () => {
      const files = await parser.findSessionFiles("/nonexistent/path");
      expect(files).toHaveLength(0);
    });

    test("recurses into project subdirectories", async () => {
      // Simulate: TEST_DIR/<project-dir>/<session-dir>/<file.jsonl>
      const nestedProjectDir = join(TEST_DIR, "-home-user-other");
      mkdirSync(nestedProjectDir, { recursive: true });
      writeFileSync(
        join(nestedProjectDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
        "{}"
      );
      // Also has a file in the original PROJECT_DIR
      writeFileSync(
        join(PROJECT_DIR, "11111111-2222-3333-4444-555555555555.jsonl"),
        "{}"
      );

      const files = await parser.findSessionFiles(TEST_DIR);
      expect(files).toHaveLength(2);
      const projects = files.map((f) => f.project).sort();
      expect(projects).toContain("home/user/project");
      expect(projects).toContain("home/user/other");
    });

    test("skips subagents directory when indexSubagents is false", async () => {
      // Create a session dir with a subagents subdirectory
      const sessionDir = join(PROJECT_DIR, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      const subagentsDir = join(sessionDir, "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(
        join(subagentsDir, "11111111-2222-3333-4444-555555555555.jsonl"),
        "{}"
      );

      const files = await parser.findSessionFiles(TEST_DIR, undefined, false);
      // Should not find the subagent file
      expect(files).toHaveLength(0);
    });

    test("includes subagent files when indexSubagents is true", async () => {
      // Create: PROJECT_DIR/<session-uuid>/subagents/<subagent-uuid>.jsonl
      const sessionDir = join(PROJECT_DIR, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      const subagentsDir = join(sessionDir, "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(
        join(subagentsDir, "11111111-2222-3333-4444-555555555555.jsonl"),
        "{}"
      );

      const files = await parser.findSessionFiles(TEST_DIR, undefined, true);
      expect(files.length).toBeGreaterThanOrEqual(1);
      const subagentFile = files.find((f) => f.sessionId === "11111111-2222-3333-4444-555555555555");
      expect(subagentFile).toBeDefined();
    });

    test("filters subagent files by since date", async () => {
      const sessionDir = join(PROJECT_DIR, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      const subagentsDir = join(sessionDir, "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(
        join(subagentsDir, "11111111-2222-3333-4444-555555555555.jsonl"),
        "{}"
      );

      const futureDate = new Date("2099-01-01");
      const files = await parser.findSessionFiles(TEST_DIR, futureDate, true);
      expect(files).toHaveLength(0);
    });
  });

  describe("parse - subagent files", () => {
    test("marks messages from subagent file path as isSubagent", async () => {
      const sessionDir = join(PROJECT_DIR, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      const subagentsDir = join(sessionDir, "subagents");
      mkdirSync(subagentsDir, { recursive: true });

      const subagentFile = join(
        subagentsDir,
        "11111111-2222-3333-4444-555555555555.jsonl"
      );
      writeJsonl(subagentFile, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-sub",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Subagent task" },
        },
      ]);

      // Subagent file is excluded by default
      const messagesDefault = await parser.parse(subagentFile, false);
      expect(messagesDefault).toHaveLength(0);

      // Included with indexSubagents=true
      const messages = await parser.parse(subagentFile, true);
      expect(messages).toHaveLength(1);
      expect(messages[0].isSubagent).toBe(true);
    });

    test("extracts project from subagent file path (3 levels up)", async () => {
      const sessionDir = join(PROJECT_DIR, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      const subagentsDir = join(sessionDir, "subagents");
      mkdirSync(subagentsDir, { recursive: true });

      const subagentFile = join(
        subagentsDir,
        "11111111-2222-3333-4444-555555555555.jsonl"
      );
      writeJsonl(subagentFile, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "session-sub",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Task" },
        },
      ]);

      const messages = await parser.parse(subagentFile, true);
      expect(messages[0].project).toBe("home/user/project");
    });
  });

  describe("parse - edge cases", () => {
    test("handles entry with no message field", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        { type: "user", uuid: "msg-1", sessionId: "s1" },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(0);
    });

    test("handles entry with non-user/assistant role", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "s1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "system", content: "System prompt" },
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(0);
    });

    test("uses filename as sessionId when entry has no sessionId", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Hello" },
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });

    test("generates uuid from sessionId+index when entry has no uuid", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          sessionId: "s1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Hello" },
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages[0].uuid).toBe("s1-0");
    });

    test("preserves gitBranch and agentId fields", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "s1",
          timestamp: "2026-03-03T10:00:00Z",
          gitBranch: "feature/test",
          agentId: "agent-42",
          message: { role: "user", content: "Hello" },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages[0].gitBranch).toBe("feature/test");
      expect(messages[0].agentId).toBe("agent-42");
    });

    test("uses current date when entry has no timestamp", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "s1",
          message: { role: "user", content: "Hello" },
        },
      ]);

      const before = new Date();
      const messages = await parser.parse(filePath);
      const after = new Date();
      expect(messages[0].timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(messages[0].timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    test("skips unknown entry types", async () => {
      const filePath = join(
        PROJECT_DIR,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
      );
      writeJsonl(filePath, [
        { type: "system_event", data: {} },
        { type: "summary", content: "..." },
        {
          type: "user",
          uuid: "msg-1",
          sessionId: "s1",
          timestamp: "2026-03-03T10:00:00Z",
          message: { role: "user", content: "Real" },
          isSidechain: false,
        },
      ]);

      const messages = await parser.parse(filePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Real");
    });
  });
});
