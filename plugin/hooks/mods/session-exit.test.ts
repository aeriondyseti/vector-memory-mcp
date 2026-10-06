/**
 * Run with: claude plugin test plugin
 */

import { describe, expect, test } from "claude-code/testing";
import type { CommandRunInput, On } from "claude-code";
import { ANSWER, checkpointPrompt, exitDecision, exitMode } from "./checkpoint.ts";

const SERVER = "plugin:vector-memory:vector-memory";

const DRAFT = {
  summary: "Building the thing. Halfway done.",
  completed: [],
  in_progress_blocked: [],
  key_decisions: [],
  next_steps: ["Write tests"],
};

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function run(command: string, origin: CommandRunInput["origin"] = { kind: "composer" }): CommandRunInput {
  return { command, args: "", origin, presentation: { isFullscreen: false, columns: 120 } };
}


interface Harness {
  /** Prompts the fork received. */
  prompts: string[];
  /** `set_waypoint` arguments received. */
  saved: Record<string, unknown>[];
  /** Questions put to the person. */
  asked: string[];
  /** Whether the command itself (core) ran. */
  ran: () => boolean;
}

/**
 * Stand in for the engine: a session with `turns` exchanges, a person who
 * answers each question with the next of `answers` (`null` dismisses), and a
 * fork that drafts DRAFT unless `forkFails`.
 */
function harness(
  on: On,
  { turns = 3, answers = [] as (string | null)[], forkFails = false } = {}
): Harness {
  const h = { prompts: [] as string[], saved: [] as Record<string, unknown>[], asked: [] as string[] };
  let ran = false;

  on("session.turns", () => ({ value: turns }));
  on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
  on("model.fork", (_$, e) => {
    h.prompts.push(e.prompt);
    return {
      value: forkFails
        ? { isAnswered: false as const, reason: "nothing-to-fork" as const }
        : { isAnswered: true as const, text: JSON.stringify(DRAFT), usage: USAGE },
    };
  });
  on("mcp.call", (_$, e) => {
    if (e.tool === "set_waypoint") h.saved.push(e.args);
    return { value: { content: [{ type: "text", text: "Waypoint stored" }], isError: false } };
  });
  on("tool.call", { tool: "AskUserQuestion" }, (_$, e) => {
    const question = e.questions[0]?.question ?? "";
    h.asked.push(question);
    const answer = answers.shift() ?? null;
    if (answer === null) return { deny: "dismissed" };
    return { result: { questions: e.questions, answers: { [question]: answer } } } as never;
  });
  on("command.run", () => {
    ran = true;
    return { text: "cleared" };
  });

  return { ...h, ran: () => ran };
}

describe("exit checkpoint helpers", () => {
  test("reads the person's answer", async () => {
    expect(exitDecision(ANSWER.save)).toEqual({ kind: "save" });
    expect(exitDecision(ANSWER.skip)).toEqual({ kind: "skip" });
    expect(exitDecision(ANSWER.cancel)).toEqual({ kind: "cancel" });
    expect(exitDecision("focus on the auth refactor")).toEqual({
      kind: "save",
      notes: "focus on the auth refactor",
    });
  });

  test("falls back to ask for an unknown mode", async () => {
    expect(exitMode("always")).toBe("always");
    expect(exitMode("never")).toBe("never");
    expect(exitMode("sometimes")).toBe("ask");
    expect(exitMode(undefined)).toBe("ask");
  });

  test("puts the person's notes in the drafting prompt", async () => {
    expect(checkpointPrompt("clear", "  the auth bits  ")).toContain('"""\nthe auth bits\n"""');
    expect(checkpointPrompt("clear")).not.toContain('"""');
  });
});

describe("/clear and /exit (ask)", () => {
  test("saves a waypoint, then clears, when the person picks save", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.save] });

    const result = await $.command.run(run("clear"));

    expect(h.asked.length).toBe(1);
    expect(h.saved).toEqual([{ ...DRAFT, metadata: { source: "clear" } }]);
    expect(h.ran()).toBe(true);
    expect(result.text).toBe("cleared");
  });

  test("steers the waypoint with notes typed under Other", async ($, on) => {
    const h = harness(on, { answers: ["focus on the migration"] });

    await $.command.run(run("exit"));

    expect(h.prompts[0]).toContain("focus on the migration");
    expect(h.prompts[0]).toContain("/exit");
    expect(h.saved[0]?.metadata).toEqual({ source: "exit", user_notes: "focus on the migration" });
    expect(h.ran()).toBe(true);
  });

  test("clears without a waypoint when the person skips", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.skip] });

    await $.command.run(run("clear"));

    expect(h.prompts).toEqual([]);
    expect(h.ran()).toBe(true);
  });

  test("cancels the command on Cancel or Esc", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.cancel, null] });

    const cancelled = await $.command.run(run("clear"));
    const dismissed = await $.command.run(run("clear"));

    expect(cancelled.text).toBe("/clear cancelled.");
    expect(dismissed.text).toBe("/clear cancelled.");
    expect(h.ran()).toBe(false);
  });

  test("asks again when the waypoint cannot be saved", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.save, ANSWER.proceed], forkFails: true });

    await $.command.run(run("clear"));

    expect(h.asked.length).toBe(2);
    expect(h.saved).toEqual([]);
    expect(h.ran()).toBe(true);
  });

  test("cancels when the save failed and the person declines to go on", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.save, ANSWER.cancel], forkFails: true });

    const result = await $.command.run(run("clear"));

    expect(result.text).toBe("/clear cancelled.");
    expect(h.ran()).toBe(false);
  });

  test("does not ask in a session with no exchanges yet", async ($, on) => {
    const h = harness(on, { turns: 0 });

    await $.command.run(run("clear"));

    expect(h.asked).toEqual([]);
    expect(h.ran()).toBe(true);
  });

  test("does not ask when the command came from the SDK", async ($, on) => {
    const h = harness(on);

    await $.command.run(run("clear", { kind: "sdk" }));

    expect(h.asked).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.ran()).toBe(true);
  });
});

describe("/clear and /exit (other modes)", () => {
  test("always: saves without asking", { options: { exitCheckpoint: "always" } }, async ($, on) => {
    const h = harness(on);

    await $.command.run(run("clear", { kind: "sdk" }));

    expect(h.asked).toEqual([]);
    expect(h.saved.length).toBe(1);
    expect(h.ran()).toBe(true);
  });

  test("never: leaves the command alone", { options: { exitCheckpoint: "never" } }, async ($, on) => {
    const h = harness(on);

    await $.command.run(run("clear"));

    expect(h.asked).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.ran()).toBe(true);
  });
});
