import { T as Theme } from './WorktreeRemove-BS3KUXFZ.js';
export { B as BackgroundTask, a as BoxOptions, C as COLORS, b as ColorName, c as CommonHookInput, d as ConfigChange, e as ConfigChangeEmitOptions, f as ConfigChangeInput, g as CwdChanged, h as CwdChangedEmitOptions, i as CwdChangedInput, D as DecisionType, j as DirectoryAdded, k as DirectoryAddedEmitOptions, l as DirectoryAddedInput, m as DividerOptions, E as EffortLevel, n as Elicitation, o as ElicitationAction, p as ElicitationEmitOptions, q as ElicitationInput, r as ElicitationResult, s as ElicitationResultEmitOptions, t as ElicitationResultInput, F as FileChanged, u as FileChangedEmitOptions, v as FileChangedInput, H as HOOK_EVENT_NAMES, w as HookEventName, x as HookParseError, I as InstructionsLoaded, y as InstructionsLoadedEmitOptions, z as InstructionsLoadedInput, L as ListOptions, M as MODIFIERS, A as McpServerInfo, G as MessageDisplay, J as MessageDisplayEmitOptions, K as MessageDisplayInput, N as ModelSwitchInfo, O as ModifierName, P as Notification, Q as NotificationEmitOptions, R as NotificationInput, S as NotificationType, U as OpenUnion, V as OutputBuilder, W as PermissionDenied, X as PermissionDeniedEmitOptions, Y as PermissionDeniedInput, Z as PermissionDestination, _ as PermissionMode, $ as PermissionRequest, a0 as PermissionRequestEmitOptions, a1 as PermissionRequestInput, a2 as PermissionRule, a3 as PermissionRuleBehavior, a4 as PermissionUpdate, a5 as PostCompact, a6 as PostCompactEmitOptions, a7 as PostCompactInput, a8 as PostModelSwitch, a9 as PostModelSwitchEmitOptions, aa as PostModelSwitchInput, ab as PostToolBatch, ac as PostToolBatchEmitOptions, ad as PostToolBatchInput, ae as PostToolUse, af as PostToolUseEmitOptions, ag as PostToolUseFailure, ah as PostToolUseFailureEmitOptions, ai as PostToolUseFailureInput, aj as PostToolUseInput, ak as PreCompact, al as PreCompactEmitOptions, am as PreCompactInput, an as PreModelSwitch, ao as PreModelSwitchEmitOptions, ap as PreModelSwitchInput, aq as PreToolUse, ar as PreToolUseEmitOptions, as as PreToolUseInput, at as SessionCron, au as SessionEnd, av as SessionEndEmitOptions, aw as SessionEndInput, ax as SessionStart, ay as SessionStartEmitOptions, az as SessionStartInput, aA as Setup, aB as SetupEmitOptions, aC as SetupInput, aD as Stop, aE as StopEmitOptions, aF as StopFailure, aG as StopFailureEmitOptions, aH as StopFailureError, aI as StopFailureInput, aJ as StopInput, aK as SubagentStart, aL as SubagentStartEmitOptions, aM as SubagentStartInput, aN as SubagentStop, aO as SubagentStopEmitOptions, aP as SubagentStopInput, aQ as TableOptions, aR as TaskCompleted, aS as TaskCompletedEmitOptions, aT as TaskCompletedInput, aU as TaskCreated, aV as TaskCreatedEmitOptions, aW as TaskCreatedInput, aX as TaskInfo, aY as TeammateIdle, aZ as TeammateIdleEmitOptions, a_ as TeammateIdleInput, a$ as ToolCallResult, b0 as UserPromptExpansion, b1 as UserPromptExpansionEmitOptions, b2 as UserPromptExpansionInput, b3 as UserPromptSubmit, b4 as UserPromptSubmitEmitOptions, b5 as UserPromptSubmitInput, b6 as WorktreeCreate, b7 as WorktreeCreateEmitOptions, b8 as WorktreeCreateInput, b9 as WorktreeRemove, ba as WorktreeRemoveEmitOptions, bb as WorktreeRemoveInput, bc as currentTheme, bd as setTheme } from './WorktreeRemove-BS3KUXFZ.js';

/**
 * Tag parser + ANSI renderer.
 *
 * Tiny XML-like markup so callers can style strings declaratively:
 *
 *   <color:"red">error</color>
 *   <bg:"yellow">!</bg>
 *   <bold><color:"red">hi</color></bold>
 *
 * For icons, use the `ICONS` constants directly in template strings:
 *
 *   `${ICONS.check} done`
 *
 * Rules:
 *   - Unknown tags pass through literally (users see their typos).
 *   - Colors off → tags are stripped, contents survive.
 *   - A trailing `\x1b[0m` is appended when any ANSI was emitted, so escape
 *     state never leaks past the rendered string.
 *
 * Known limitation: same-kind nesting (`<color:"red">..<color:"blue">..</color>..</color>`)
 * doesn't restore the outer color after the inner close — `</color>` always
 * emits the default-foreground reset. Cross-kind nesting (`<bold><color>`) is
 * fine. For the common case (colorize a span, optionally bold it) this is
 * more than enough.
 */

declare function renderTags(input: string, theme?: Theme): string;
declare function stripTags(input: string): string;
/**
 * Cell width of a rendered string. Delegates to `string-width` for CJK /
 * emoji / ZWJ correctness; strips our own tag markup first.
 */
declare function visualWidth(input: string): number;

/**
 * Named icons for use in output strings.
 *
 * Drop them in with template literals — no parser, no tag grammar:
 *
 *   builder.appendLine(`${ICONS.check} build passed`);
 *   builder.appendLine(`${ICONS.warn} ${count} files skipped`);
 *
 * To add an icon: put it in `ICONS` and it's instantly available.
 * Typos are compile errors (`ICONS.chek` won't typecheck).
 */
declare const ICONS: {
    readonly check: "✓";
    readonly cross: "✗";
    readonly warn: "⚠";
    readonly info: "ℹ";
    readonly arrow: "▸";
    readonly bullet: "•";
    readonly dot: "·";
    readonly star: "★";
};
type IconName = keyof typeof ICONS;

/**
 * Opt-in wrapper for a hook script's body.
 *
 * The library's `parse()` methods throw `HookParseError` on bad input — that
 * keeps the parser SRP-clean, but it means a bare top-level script would
 * exit with Node's default (code 1 + a stack trace) on a misconfigured
 * `settings.json`. Claude Code's hook protocol distinguishes exit 2
 * (blocking error, stderr relayed to Claude) from exit 1 (non-blocking), so
 * that default is worse than the old auto-handling.
 *
 * Wrap your hook body in `runHook` to restore the protocol-correct behavior
 * without giving up the flexibility of opting out:
 *
 *   // hooks/pre-tool-use.ts
 *   import { runHook, PreToolUse } from '@aeriondyseti/hook-kit';
 *
 *   runHook(() => {
 *     const input = PreToolUse.parse();
 *     if (isDangerous(input)) {
 *       PreToolUse.emitOutput({ decision: 'deny', reason: '...' });
 *     } else {
 *       PreToolUse.emitOutput({});
 *     }
 *   });
 *
 * `emitOutput` calls `process.exit(0)` itself on success, so `runHook` only
 * needs to catch failures. A non-parse error is re-thrown so Node's default
 * handling (stack trace, exit 1) still surfaces actual bugs.
 */
declare function runHook(fn: () => void): void;

export { ICONS, type IconName, Theme, renderTags, runHook, stripTags, visualWidth };
