/**
 * Run with: claude plugin test plugin
 */

import { describe, expect, test } from "claude-code/testing";
import type { On } from "claude-code";
import { ANSWER, findWaypointContext, loadQuestion } from "./checkpoint.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

const WAYPOINT =
  "## Session Waypoint (Updated: 2026-10-06T10:00:00.000Z | Branch: feat/x | Project: /repo)\n\n" +
  "# Waypoint\n\nBuilding the thing.";

const OTHER_CONTEXT = "Some other hook's context.";

interface Harness {
  /** Questions put to the person. */
  asked: string[];
}

/**
 * Stand in for the engine: classic SessionStart hooks that load `context`, a
 * session drawn on `surfaces`, and a person who answers each question with the
 * next of `answers` (`null` dismisses). Also answers what a /clear needs.
 */
function harness(
  on: On,
  {
    context = [OTHER_CONTEXT, WAYPOINT],
    surfaces = ["terminal"] as const as readonly "terminal"[],
    answers = [] as (string | null)[],
  } = {}
): Harness {
  const asked: string[] = [];

  on("classic.SessionStart", () => ({ additionalContext: context }));
  on("session.surfaces", () => ({ value: surfaces }));
  on("tool.call", { tool: "AskUserQuestion" }, (_$, e) => {
    const question = e.questions[0]?.question ?? "";
    asked.push(question);
    const answer = answers.shift() ?? null;
    if (answer === null) return { deny: "dismissed" };
    return { result: { questions: e.questions, answers: { [question]: answer } } } as never;
  });

  // What a /clear before the start needs.
  on("session.turns", () => ({ value: 3 }));
  on("mcp.connect", () => ({ value: { isConnected: true, server: "vector-memory" } }));
  on("model.fork", () => ({
    value: {
      isAnswered: true as const,
      text: '{"summary": "s"}',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }));
  on("mcp.call", () => ({ value: { content: [{ type: "text", text: "ok" }], isError: false } }));
  on("command.run", () => ({ text: "cleared" }));

  return { asked };
}

describe("session start helpers", () => {
  test("finds the waypoint among the hooks' context", async () => {
    expect(findWaypointContext([OTHER_CONTEXT, WAYPOINT])).toBe(1);
    expect(findWaypointContext([OTHER_CONTEXT])).toBe(-1);
    expect(findWaypointContext(undefined)).toBe(-1);
  });

  test("asks with the waypoint's age and branch", async () => {
    expect(loadQuestion(WAYPOINT, NOW)).toBe(
      "Load the waypoint saved 2h ago (feat/x) into this session?"
    );
    expect(loadQuestion("## Session Waypoint (Updated: bogus)\n\nx", NOW)).toBe(
      "Load the waypoint last saved into this session?"
    );
  });
});

describe("loading at session start (ask)", () => {
  test("keeps the waypoint when the person loads it", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.load] });

    const started = await $.classic.SessionStart({ source: "startup" });

    expect(h.asked.length).toBe(1);
    expect(started.additionalContext).toEqual([OTHER_CONTEXT, WAYPOINT]);
  });

  test("drops only the waypoint when the person starts fresh", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.fresh] });

    const started = await $.classic.SessionStart({ source: "clear" });

    expect(h.asked.length).toBe(1);
    expect(started.additionalContext).toEqual([OTHER_CONTEXT]);
  });

  test("keeps the waypoint when the question is dismissed", async ($, on) => {
    harness(on, { answers: [null] });

    const started = await $.classic.SessionStart({ source: "startup" });

    expect(started.additionalContext).toEqual([OTHER_CONTEXT, WAYPOINT]);
  });

  test("does not ask when there is no waypoint", async ($, on) => {
    const h = harness(on, { context: [OTHER_CONTEXT] });

    await $.classic.SessionStart({ source: "startup" });

    expect(h.asked).toEqual([]);
  });

  test("does not ask on resume or compaction", async ($, on) => {
    const h = harness(on);

    await $.classic.SessionStart({ source: "resume" });
    await $.classic.SessionStart({ source: "compact" });

    expect(h.asked).toEqual([]);
  });

  test("loads without asking when nobody is there (-p, SDK)", async ($, on) => {
    const h = harness(on, { surfaces: [] });

    const started = await $.classic.SessionStart({ source: "startup" });

    expect(h.asked).toEqual([]);
    expect(started.additionalContext).toEqual([OTHER_CONTEXT, WAYPOINT]);
  });

  test("does not ask again for a waypoint just saved at /clear", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.save] });

    await $.command.run({
      command: "clear",
      args: "",
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 120 },
    });
    const started = await $.classic.SessionStart({ source: "clear" });

    expect(h.asked.length).toBe(1); // the /clear question alone
    expect(started.additionalContext).toEqual([OTHER_CONTEXT, WAYPOINT]);
  });
});

describe("loading at session start (other modes)", () => {
  test("always: loads without asking", { options: { loadCheckpoint: "always" } }, async ($, on) => {
    const h = harness(on);

    const started = await $.classic.SessionStart({ source: "startup" });

    expect(h.asked).toEqual([]);
    expect(started.additionalContext).toEqual([OTHER_CONTEXT, WAYPOINT]);
  });

  test("never: drops the waypoint without asking", { options: { loadCheckpoint: "never" } }, async ($, on) => {
    const h = harness(on);

    const started = await $.classic.SessionStart({ source: "startup" });

    expect(h.asked).toEqual([]);
    expect(started.additionalContext).toEqual([OTHER_CONTEXT]);
  });
});
