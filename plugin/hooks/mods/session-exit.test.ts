/**
 * Run with: claude plugin test plugin
 */

import { describe, expect, test } from "claude-code/testing";
import type { CommandRunInput, On } from "claude-code";
import {
  ANSWER,
  CHECKPOINT_PROMPT,
  checkpointDecision,
  checkpointMode,
  checkpointPrompt,
  MEMORIES_PROMPT,
  memoriesArgs,
  parseMemoriesDraft,
  storedMemoryIds,
} from "./checkpoint.ts";

const SERVER = "plugin:vector-memory:vector-memory";

const DRAFT = {
  summary: "Building the thing. Halfway done.",
  completed: [],
  in_progress_blocked: [],
  key_decisions: [],
  next_steps: ["Write tests"],
};

const MEMORIES = {
  memories: [
    { content: "The team chose SQLite over Postgres for its zero-setup deployment.", type: "decision" },
    { content: "The importer skips rows without an id.", type: "insight", context: "Importer > Validation" },
  ],
};

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

/** MEMORIES as `store_memories` stores them before /clear. */
const STORED_AT_CLEAR = {
  memories: [
    { content: MEMORIES.memories[0]?.content, metadata: { type: "decision", source: "clear" } },
    {
      content: MEMORIES.memories[1]?.content,
      context: "Importer > Validation",
      metadata: { type: "insight", source: "clear" },
    },
  ],
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
  /** `store_memories` arguments received. */
  stored: Record<string, unknown>[];
  /** MCP tools called, in order. */
  tools: string[];
  /** Questions put to the person. */
  asked: string[];
  /** Whether the command itself (core) ran. */
  ran: () => boolean;
}

/**
 * Stand in for the engine: a session with `turns` exchanges, a person who
 * answers each question with the next of `answers` (`null` dismisses), a
 * fork that drafts DRAFT and `memories` unless `forkFails`, and a server that
 * stores memories as IDS unless `storeFails`.
 */
function harness(
  on: On,
  {
    turns = 3,
    answers = [] as (string | null)[],
    forkFails = false,
    storeFails = false,
    memories = MEMORIES as { memories: unknown[] },
  } = {}
): Harness {
  const h = {
    prompts: [] as string[],
    saved: [] as Record<string, unknown>[],
    stored: [] as Record<string, unknown>[],
    tools: [] as string[],
    asked: [] as string[],
  };
  let ran = false;

  on("session.turns", () => ({ value: turns }));
  on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
  on("model.fork", (_$, e) => {
    h.prompts.push(e.prompt);
    return {
      value: forkFails
        ? { isAnswered: false as const, reason: "nothing-to-fork" as const }
        : { isAnswered: true as const, text: JSON.stringify({ ...memories, ...DRAFT }), usage: USAGE },
    };
  });
  on("mcp.call", (_$, e) => {
    h.tools.push(e.tool);
    if (e.tool === "set_waypoint") h.saved.push(e.args);
    if (e.tool === "store_memories") {
      h.stored.push(e.args);
      const text = storeFails ? "database is locked" : `Stored 2 memories:\n${IDS.map((id) => `- ${id}`).join("\n")}`;
      return { value: { content: [{ type: "text", text }], isError: storeFails } };
    }
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

describe("checkpoint helpers", () => {
  test("reads the person's answer", async () => {
    expect(checkpointDecision(ANSWER.save)).toEqual({ kind: "save" });
    expect(checkpointDecision(ANSWER.memories)).toEqual({ kind: "memories" });
    expect(checkpointDecision(ANSWER.skip)).toEqual({ kind: "skip" });
    expect(checkpointDecision(ANSWER.cancel)).toEqual({ kind: "cancel" });
    expect(checkpointDecision("focus on the auth refactor")).toEqual({
      kind: "save",
      notes: "focus on the auth refactor",
    });
  });

  test("falls back to ask for an unknown mode", async () => {
    expect(checkpointMode("always")).toBe("always");
    expect(checkpointMode("never")).toBe("never");
    expect(checkpointMode("sometimes")).toBe("ask");
    expect(checkpointMode(undefined)).toBe("ask");
  });

  test("puts the person's notes in the drafting prompt", async () => {
    expect(checkpointPrompt("clear", "  the auth bits  ")).toContain('"""\nthe auth bits\n"""');
    expect(checkpointPrompt("clear")).not.toContain('"""');
  });

  test("parses a memories draft, dropping empty items and unknown types", async () => {
    const text = `Here you go: ${JSON.stringify({
      memories: [
        { content: "  A decision.  ", type: "decision", context: " Doc > Section " },
        { content: "An insight.", type: "rumour" },
        { content: "   " },
        "not an object",
      ],
    })}`;
    expect(parseMemoriesDraft(text)).toEqual([
      { content: "A decision.", type: "decision", context: "Doc > Section" },
      { content: "An insight." },
    ]);
    expect(parseMemoriesDraft('{"memories": []}')).toEqual([]);
    expect(parseMemoriesDraft("no json here")).toBeNull();
    expect(parseMemoriesDraft('{"summary": "a waypoint"}')).toBeNull();
  });

  test("reads the ids store_memories names, duplicates' included", async () => {
    const [a, b] = IDS as [string, string];
    expect(storedMemoryIds(`Memory stored with ID: ${a}`)).toEqual([a]);
    expect(storedMemoryIds(`Stored 2 memories:\n- ${a}\n- ${b}`)).toEqual([a, b]);
    expect(
      storedMemoryIds(
        `Memory stored with ID: ${a}\n\nNot stored: duplicate of existing memory ${b}:\n  "x"\n\n` +
          `Stored ${a}, but it closely matches 33333333-3333-4333-8333-333333333333; review.`
      )
    ).toEqual([a, b]);
    expect(storedMemoryIds("")).toEqual([]);
  });

  test("asks for memories alongside the waypoint", async () => {
    expect(CHECKPOINT_PROMPT).toContain('"memories"');
    expect(CHECKPOINT_PROMPT).toContain('"summary"');
    expect(MEMORIES_PROMPT).toContain('"memories"');
    expect(MEMORIES_PROMPT).not.toContain('"summary"');
  });

  test("records the source on every stored memory", async () => {
    expect(memoriesArgs([{ content: "A.", type: "insight" }, { content: "B." }], "exit")).toEqual({
      memories: [
        { content: "A.", metadata: { type: "insight", source: "exit" } },
        { content: "B.", metadata: { source: "exit" } },
      ],
    });
  });
});

describe("/clear and /exit (ask)", () => {
  test("stores memories, then a waypoint linking them, then clears, on Save waypoint", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.save] });

    const result = await $.command.run(run("clear"));

    expect(h.asked.length).toBe(1);
    expect(h.prompts.length).toBe(1); // one draft for both
    expect(h.prompts[0]).toContain(CHECKPOINT_PROMPT);
    expect(h.tools).toEqual(["store_memories", "set_waypoint"]);
    expect(h.stored).toEqual([STORED_AT_CLEAR]);
    expect(h.saved).toEqual([{ ...DRAFT, memory_ids: IDS, metadata: { source: "clear" } }]);
    expect(h.ran()).toBe(true);
    expect(result.text).toBe("cleared");
  });

  test("still saves the waypoint, unlinked, when its memories fail to store", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.save], storeFails: true });

    await $.command.run(run("clear"));

    expect(h.saved).toEqual([{ ...DRAFT, metadata: { source: "clear" } }]);
    expect(h.asked.length).toBe(1);
    expect(h.ran()).toBe(true);
  });

  test("saves a waypoint without memories when there are none", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.save], memories: { memories: [] } });

    await $.command.run(run("clear"));

    expect(h.tools).toEqual(["set_waypoint"]);
    expect(h.saved).toEqual([{ ...DRAFT, metadata: { source: "clear" } }]);
  });

  test("steers the waypoint with notes typed under Other", async ($, on) => {
    const h = harness(on, { answers: ["focus on the migration"] });

    await $.command.run(run("exit"));

    expect(h.prompts[0]).toContain("focus on the migration");
    expect(h.prompts[0]).toContain("/exit");
    expect(h.saved[0]?.metadata).toEqual({ source: "exit", user_notes: "focus on the migration" });
    expect(h.ran()).toBe(true);
  });

  test("stores memories but no waypoint, then clears, on Memories only", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.memories] });

    const result = await $.command.run(run("clear"));

    expect(h.prompts.length).toBe(1);
    expect(h.prompts[0]).toContain(MEMORIES_PROMPT);
    expect(h.prompts[0]).toContain("/clear");
    expect(h.saved).toEqual([]);
    expect(h.stored).toEqual([STORED_AT_CLEAR]);
    expect(h.ran()).toBe(true);
    expect(result.text).toBe("cleared");
  });

  test("Memories only with nothing worth storing still runs the command", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.memories], memories: { memories: [] } });

    await $.command.run(run("exit"));

    expect(h.stored).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.asked.length).toBe(1);
    expect(h.ran()).toBe(true);
  });

  test("asks again when the memories cannot be saved", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.memories, ANSWER.cancel], forkFails: true });

    const result = await $.command.run(run("clear"));

    expect(h.asked[1]).toBe("The memories could not be saved. Run /clear anyway?");
    expect(result.text).toBe("/clear cancelled.");
    expect(h.ran()).toBe(false);
  });

  test("asks again when Memories only cannot store them", async ($, on) => {
    const h = harness(on, { answers: [ANSWER.memories, ANSWER.proceed], storeFails: true });

    await $.command.run(run("clear"));

    expect(h.asked[1]).toBe("The memories could not be saved. Run /clear anyway?");
    expect(h.saved).toEqual([]);
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
