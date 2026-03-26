#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "clear") for the vector-memory plugin.
 *
 * Resets context-monitor state, then indexes and loads the waypoint.
 */

import { unlinkSync } from "fs";
import { debug } from "../../../server/utils/formatting.js";
import { getStatePath, indexAndLoadWaypoint } from "./hooks-lib.js";

interface HookInput {
  session_id: string;
}

async function main() {
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

  await indexAndLoadWaypoint("session-clear");
}

main().catch((err) => {
  debug("session-clear", `Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
});
