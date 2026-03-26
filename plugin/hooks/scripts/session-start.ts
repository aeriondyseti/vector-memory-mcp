#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "start") for vector-memory plugin.
 *
 * Discovers the server, indexes conversations, and loads the latest waypoint.
 */

import { debug, icon, ansi, buildSystemMessage } from "../../../server/utils/formatting.js";
import { indexAndLoadWaypoint, emitHookOutput } from "./hooks-lib.js";

async function main() {
  await Bun.stdin.text();
  await indexAndLoadWaypoint("session-start");
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
