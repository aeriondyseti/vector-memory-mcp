/**
 * Pure helpers for the vector-memory waypoint checkpoints: the drafting
 * prompt, parsing the draft, and reading MCP results. Everything that calls
 * the engine lives in index.ts (the validator follows `$` within one file).
 */

export const CHECKPOINT_PROMPT = `Write a checkpoint of this session so work can resume seamlessly afterwards.

Reply with ONLY a JSON object (no prose, no code fence) of this shape:
{
  "branch": "current git branch, or omit if unknown",
  "summary": "2-3 sentences: the primary goal and the current status",
  "completed": ["specific completed items, with file paths where relevant"],
  "in_progress_blocked": ["work in flight with its current state, or blockers and what they need"],
  "key_decisions": ["decisions made and WHY"],
  "next_steps": ["concrete, actionable next steps, in priority order"]
}

Be thorough but concise: capture what would take time to reconstruct, skip what is obvious from the code.`;

/** Why the checkpoint is being taken, as the fork is told and metadata records. */
export type CheckpointSource = "auto-compaction" | "clear" | "exit";

const OCCASION: Record<CheckpointSource, string> = {
  "auto-compaction": "The conversation is about to be compacted.",
  clear: "The conversation is about to be cleared (/clear); the next session starts from this checkpoint.",
  exit: "The session is about to end (/exit); the next session starts from this checkpoint.",
};

export function checkpointPrompt(source: CheckpointSource, notes?: string): string {
  const guidance = notes?.trim()
    ? `\n\nThe user gave this guidance for the checkpoint; follow it:\n"""\n${notes.trim()}\n"""`
    : "";
  return `${OCCASION[source]} ${CHECKPOINT_PROMPT}${guidance}`;
}

export interface WaypointDraft {
  branch?: string;
  summary: string;
  completed: string[];
  in_progress_blocked: string[];
  key_decisions: string[];
  next_steps: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

/** Parse the fork's reply into `set_waypoint` arguments; null when unusable. */
export function parseWaypointDraft(text: string): WaypointDraft | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") return null;

  return {
    ...(typeof obj.branch === "string" && obj.branch.trim() !== ""
      ? { branch: obj.branch.trim() }
      : {}),
    summary: obj.summary.trim(),
    completed: stringList(obj.completed),
    in_progress_blocked: stringList(obj.in_progress_blocked),
    key_decisions: stringList(obj.key_decisions),
    next_steps: stringList(obj.next_steps),
  };
}

/** `set_waypoint` arguments for a draft, recording why and any notes. */
export function waypointArgs(
  draft: WaypointDraft,
  source: CheckpointSource,
  notes?: string
): Record<string, unknown> {
  return {
    ...draft,
    metadata: { source, ...(notes?.trim() ? { user_notes: notes.trim() } : {}) },
  };
}

export function resultText(result: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── /clear and /exit ────────────────────────────────────────────────

export type ExitCheckpointMode = "ask" | "always" | "never";

export function exitMode(value: unknown): ExitCheckpointMode {
  return value === "always" || value === "never" ? value : "ask";
}

export const ANSWER = {
  save: "Save waypoint",
  skip: "Skip",
  cancel: "Cancel",
  proceed: "Continue anyway",
} as const;

export type ExitDecision = { kind: "save"; notes?: string } | { kind: "skip" } | { kind: "cancel" };

/** Read the person's answer; free text typed under "Other" saves with it as notes. */
export function exitDecision(answer: string): ExitDecision {
  if (answer === ANSWER.save) return { kind: "save" };
  if (answer === ANSWER.skip) return { kind: "skip" };
  if (answer === ANSWER.cancel) return { kind: "cancel" };
  return { kind: "save", notes: answer };
}
