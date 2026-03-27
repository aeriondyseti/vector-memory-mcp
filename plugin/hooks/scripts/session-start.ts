#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "start") for vector-memory plugin.
 *
 * Discovers the server, indexes conversations, and loads the latest waypoint.
 */

import { indexAndLoadWaypoint, withHookTimeout, runHook } from "./hooks-lib.js";

const HOOK_TIMEOUT = 45_000;

runHook("session-start", async () => {
  await Bun.stdin.text();
  await withHookTimeout("session-start", HOOK_TIMEOUT, () =>
    indexAndLoadWaypoint("session-start")
  );
});
