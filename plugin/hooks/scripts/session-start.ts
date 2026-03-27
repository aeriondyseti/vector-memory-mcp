#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "start") for vector-memory plugin.
 *
 * Discovers the server, indexes conversations, and loads the latest waypoint.
 */

import { debug, icon, ansi, buildSystemMessage, indexAndLoadWaypoint, emitHookOutput, withHookTimeout } from "./hooks-lib.js";

const HOOK_TIMEOUT = 45_000;

async function main() {
  await Bun.stdin.text();
  await withHookTimeout("session-start", HOOK_TIMEOUT, () =>
    indexAndLoadWaypoint("session-start")
  );
}

main().catch((err) => {
  debug("session-start", `Fatal: ${err?.message ?? err}`);
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
