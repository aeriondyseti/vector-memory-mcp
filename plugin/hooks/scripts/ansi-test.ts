#!/usr/bin/env bun
/**
 * ANSI color test hook — verifies hook-output module rendering.
 */
import {
  ansi,
  icon,
  buildSystemMessage,
  emitHookOutput,
  debug,
} from "./hooks-lib";

// Read stdin (hook protocol)
await Bun.stdin.text();

debug("ansi-test", "Hook fired, testing output module");

const systemMessage = buildSystemMessage("Vector Memory", [
  {
    icon: icon.check,
    iconColor: ansi.green,
    text: `Waypoint loaded ${ansi.dim}(2m ago)${ansi.reset}`,
  },
  {
    icon: icon.book,
    iconColor: ansi.magenta,
    text: `3 memories ${ansi.dim}${icon.dot}${ansi.reset} ${ansi.blue}${icon.branch} main${ansi.reset} branch`,
  },
]);

emitHookOutput({
  systemMessage,
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext:
      "ANSI test: if you see clean text, ANSI is stripped before injection.",
  },
});
