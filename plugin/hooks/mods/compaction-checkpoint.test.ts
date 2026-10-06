/**
 * Run with: claude plugin test plugin
 * (bun's own runner is rooted at tests/ and does not pick this up.)
 */

import { describe, expect, test } from "claude-code/testing";
import type { SessionMessage } from "claude-code";
import { parseWaypointDraft } from "./compaction-checkpoint.ts";

const SERVER = "plugin:vector-memory:vector-memory";

const DRAFT = {
  branch: "feat/x",
  summary: "Building the thing. Halfway done.",
  completed: ["Wrote server/a.ts"],
  in_progress_blocked: [],
  key_decisions: ["Chose A because B"],
  next_steps: ["Write tests"],
};

const TRANSCRIPT: SessionMessage[] = [
  { role: "user", text: "build the thing", toolUses: [] },
  { role: "assistant", text: "on it", toolUses: [] },
];

const SUMMARY: SessionMessage = { role: "user", text: "Summary of the session.", toolUses: [] };

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

// A test's hooks beneath the plugin stand for the engine: a `$` call they
// answer is answered as `{ value }`.
const forkReplies = (text: string) => () => ({ value: { isAnswered: true as const, text, usage: USAGE } });
const forkFails = () => ({ value: { isAnswered: false as const, reason: "nothing-to-fork" as const } });
const mcpText = (text: string) => ({ value: { content: [{ type: "text", text }], isError: false } });

describe("parseWaypointDraft", () => {
  test("reads a bare JSON object", async () => {
    expect(parseWaypointDraft(JSON.stringify(DRAFT))).toEqual(DRAFT);
  });

  test("reads JSON wrapped in prose or a code fence", async () => {
    const text = "Here it is:\n```json\n" + JSON.stringify(DRAFT) + "\n```";
    expect(parseWaypointDraft(text)).toEqual(DRAFT);
  });

  test("drops non-string list items and a blank branch", async () => {
    const parsed = parseWaypointDraft(
      JSON.stringify({ branch: " ", summary: "s", completed: ["a", 1, ""], next_steps: "x" })
    );
    expect(parsed).toEqual({
      summary: "s",
      completed: ["a"],
      in_progress_blocked: [],
      key_decisions: [],
      next_steps: [],
    });
  });

  test("refuses a reply without a summary or without JSON", async () => {
    expect(parseWaypointDraft('{"completed": []}')).toBe(null);
    expect(parseWaypointDraft("no json here")).toBe(null);
    expect(parseWaypointDraft("{not json}")).toBe(null);
  });
});

describe("session.compact", () => {
  test("saves a waypoint before compacting and appends it after", async ($, on) => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let compactedAfterSave = false;

    on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
    on("model.fork", forkReplies(JSON.stringify(DRAFT)));
    on("mcp.call", (_$, e) => {
      calls.push({ tool: e.tool, args: e.args });
      const text = e.tool === "get_waypoint" ? "# Waypoint\n\nBuilding the thing." : "Waypoint stored";
      return mcpText(text);
    });
    on("session.compact", () => {
      compactedAfterSave = calls.some((c) => c.tool === "set_waypoint");
      return { messages: [SUMMARY] };
    });

    const result = await $.session.compact({ trigger: "manual", messages: TRANSCRIPT });

    expect(compactedAfterSave).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(["set_waypoint", "get_waypoint"]);
    expect(calls[0]?.args).toEqual({ ...DRAFT, metadata: { source: "auto-compaction" } });
    expect(result.messages?.length).toBe(2);
    expect(result.messages?.[0]?.text).toBe(SUMMARY.text);
    expect(result.messages?.[1]?.role).toBe("user");
    expect(result.messages?.[1]?.text).toContain("Building the thing.");
  });

  test("compacts unchanged when the fork cannot draft a waypoint", async ($, on) => {
    const tools: string[] = [];
    on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
    on("model.fork", forkFails);
    on("mcp.call", (_$, e) => {
      tools.push(e.tool);
      return mcpText("");
    });
    on("session.compact", () => ({ messages: [SUMMARY] }));

    const result = await $.session.compact({ trigger: "auto", messages: TRANSCRIPT });

    expect(tools).toEqual([]);
    expect(result.messages?.length).toBe(1);
  });

  test("compacts unchanged when the server is not connected", async ($, on) => {
    let forked = false;
    on("mcp.connect", () => ({ value: { isConnected: false, reason: "disabled", message: "off" } }));
    on("model.fork", () => {
      forked = true;
      return forkFails();
    });
    on("session.compact", () => ({ messages: [SUMMARY] }));

    const result = await $.session.compact({ trigger: "manual", messages: TRANSCRIPT });

    expect(forked).toBe(false);
    expect(result.messages?.length).toBe(1);
  });

  test("leaves precompute and subagent compactions alone", async ($, on) => {
    let forked = false;
    on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
    on("model.fork", () => {
      forked = true;
      return forkFails();
    });
    on("session.compact", () => ({ messages: [SUMMARY] }));

    await $.session.compact({ trigger: "precompute", messages: TRANSCRIPT });
    await $.session.compact({ trigger: "auto", agentId: "agent-1", messages: TRANSCRIPT });

    expect(forked).toBe(false);
  });

  test("passes a vetoed compaction through without reloading", async ($, on) => {
    const tools: string[] = [];
    on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
    on("model.fork", forkReplies(JSON.stringify(DRAFT)));
    on("mcp.call", (_$, e) => {
      tools.push(e.tool);
      return mcpText("ok");
    });
    on("session.compact", () => ({ skip: "blocked" }));

    const result = await $.session.compact({ trigger: "manual", messages: TRANSCRIPT });

    expect(result.skip).toBe("blocked");
    expect(tools).toEqual(["set_waypoint"]);
  });
});
