#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "clear") for the vector-memory plugin.
 *
 * Resets context-monitor state, then indexes and loads the waypoint.
 */

import { unlinkSync } from "fs";
import { debug, icon, ansi, buildSystemMessage, getStatePath, indexAndLoadWaypoint, emitHookOutput, withHookTimeout } from "./hooks-lib.js";

const HOOK_TIMEOUT = 45_000;

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

  await withHookTimeout("session-clear", HOOK_TIMEOUT, () =>
    indexAndLoadWaypoint("session-clear")
  );
}

main().catch((err) => {
  debug("session-clear", `Fatal: ${err?.message ?? err}`);
  emitHookOutput({
    systemMessage: buildSystemMessage("Vector Memory", [
      {
        icon: icon.warning,
        iconColor: ansi.yellow,
        text: `Hook error: ${err?.message ?? "unknown"}`,
      },
    ]),
  });
});
