#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "compact") for the vector-memory plugin.
 *
 * Increments the compression counter in context-monitor state.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { debug } from "../../../server/utils/formatting.js";
import { getStatePath } from "./hooks-lib.js";

interface HookInput {
  session_id: string;
}

async function main() {
  const input: HookInput = await Bun.stdin.json();
  if (!input.session_id) return;

  const statePath = getStatePath(input.session_id);
  debug("session-compact", `session_id=${input.session_id}, statePath=${statePath}`);

  let state = {
    last_offset: 0,
    turn_count: 0,
    compressions: 0,
    context_length: 0,
  };

  try {
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    }
  } catch (err) {
    debug("session-compact", `Failed to read state: ${err instanceof Error ? err.message : String(err)}`);
  }

  state.compressions += 1;
  writeFileSync(statePath, JSON.stringify(state));
  debug("session-compact", `compressions=${state.compressions}`);
}

main().catch((err) => {
  debug("session-compact", `Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
});
