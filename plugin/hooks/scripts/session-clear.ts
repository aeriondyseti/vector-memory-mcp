#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "clear") for the vector-memory plugin.
 *
 * Resets context-monitor state, then indexes and loads the waypoint.
 */

import { unlinkSync } from "fs";
import { debug, getStatePath, indexAndLoadWaypoint, withHookTimeout, runHook } from "./hooks-lib.js";

const HOOK_TIMEOUT = 45_000;

interface HookInput {
  session_id: string;
}

runHook("session-clear", async () => {
  const input: HookInput = await Bun.stdin.json();
  if (!input.session_id) return;

  const statePath = getStatePath(input.session_id);
  debug("session-clear", `session_id=${input.session_id}, statePath=${statePath}`);

  try {
    unlinkSync(statePath);
    debug("session-clear", "State file deleted");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      debug("session-clear", "No state file to delete");
    } else {
      throw err;
    }
  }

  await withHookTimeout("session-clear", HOOK_TIMEOUT, () =>
    indexAndLoadWaypoint("session-clear")
  );
});
