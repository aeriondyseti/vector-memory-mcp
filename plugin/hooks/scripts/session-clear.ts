#!/usr/bin/env bun
/**
 * SessionStart hook (matcher: "clear") for the vector-memory plugin.
 *
 * Indexes the conversation and loads the waypoint.
 */

import { indexAndLoadWaypoint, withHookTimeout, runHook } from "./hooks-lib";

const HOOK_TIMEOUT = 45_000;

interface HookInput {
  session_id: string;
}

runHook("session-clear", async () => {
  const input: HookInput = await Bun.stdin.json();
  if (!input.session_id) return;

  await withHookTimeout("session-clear", HOOK_TIMEOUT, () =>
    indexAndLoadWaypoint("session-clear")
  );
});
