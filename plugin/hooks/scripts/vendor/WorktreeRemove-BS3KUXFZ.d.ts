/**
 * Theme controls how tagged markup renders: colors on/off.
 *
 * Default is ON — hook scripts don't write to a TTY (stdout is a pipe to
 * Claude Code), but Claude Code renders the emitted ANSI. The usual TTY
 * auto-detect would disable colors here, which is exactly backwards.
 *
 * Honored env vars:
 *   - NO_COLOR (any non-empty value) → colors off
 *   - FORCE_COLOR=0                  → colors off
 *
 * `setTheme` lets hook authors override explicitly.
 */
interface Theme {
    colors: boolean;
}
declare function setTheme(override: Partial<Theme>): void;
declare function currentTheme(): Theme;

/**
 * Canonical names for colors and text modifiers.
 *
 * Exported as `as const` tuples so callers can both type-check against the
 * union AND iterate the values (e.g. to build a picker). Adding a new color
 * here forces every code map (FG/BG in tags.ts) to also cover it.
 */
declare const COLORS: readonly ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray", "grey"];
type ColorName = typeof COLORS[number];
declare const MODIFIERS: readonly ["bold", "dim", "italic", "underline"];
type ModifierName = typeof MODIFIERS[number];

/**
 * OutputBuilder — a tiny accumulator for formatted text.
 *
 * Append strings (optionally containing tag markup). Call `render()` (or
 * `toString()`) to get the final ANSI-rendered string. Tags are resolved
 * against the current theme at render time, not at append time — so you can
 * `setTheme()` anywhere before emit and still get the right output.
 *
 * Structural helpers (boxes, tables, lists) will layer on later.
 */

interface ListOptions {
    bullet?: string;
    indent?: number;
}
interface DividerOptions {
    width?: number;
    color?: ColorName;
}
interface BoxOptions {
    title?: string;
    color?: ColorName;
    padding?: number;
}
interface TableOptions {
    headers?: readonly string[];
    color?: ColorName;
}
declare class OutputBuilder {
    private content;
    append(text: string): this;
    appendLine(text?: string): this;
    /**
     * Append a divider line — `char` repeated as many complete copies as fit
     * in the terminal width (partial trailing copies are not emitted).
     *
     * Width resolution order: `opts.width` → `$COLUMNS` env var →
     * `process.stderr.columns` → 80. We probe stderr, not stdout: in hook
     * scripts stdout is piped to Claude Code, but stderr usually stays
     * attached to the terminal so its `.columns` is the real TTY width.
     * Values ≤ 20 are treated as garbage and fall through to 80.
     *
     * `char` may be multi-cell (emoji, wide glyphs) or contain tag markup —
     * `visualWidth` is used to count cells, so the math stays honest.
     */
    appendDivider(char?: string, opts?: DividerOptions): this;
    /**
     * Append items as a bulleted list, one per line.
     *
     * Items may contain tag markup — it resolves at render time like any other
     * appended text. Multi-line item strings are not reflowed; the caller owns
     * that.
     */
    appendList(items: readonly string[], opts?: ListOptions): this;
    /**
     * Wrap content in a unicode-drawn box.
     *
     *   ┌─ Title ──────┐
     *   │  line one    │
     *   │  line two    │
     *   └──────────────┘
     *
     * Content may be multi-line and may contain tag markup — width math uses
     * `visualWidth`, so ANSI, CJK, and emoji widths are all counted correctly.
     * A single trailing newline on `content` is dropped so `box('hi\n')`
     * doesn't produce an empty bottom row.
     */
    appendBox(content: string, opts?: BoxOptions): this;
    /**
     * Render a table. Each row is an array of cell strings (may contain tag
     * markup). Column widths auto-size to the widest cell across header + rows.
     *
     *   ┌────┬─────┐
     *   │ H1 │ H2  │
     *   ├────┼─────┤
     *   │ a  │ bb  │
     *   │ cc │ ddd │
     *   └────┴─────┘
     *
     * Ragged rows are OK — missing cells render as empty. If there are no
     * rows and no headers, the call is a no-op.
     */
    appendTable(rows: readonly (readonly string[])[], opts?: TableOptions): this;
    render(theme?: Theme): string;
    toString(): string;
    get isEmpty(): boolean;
}

/**
 * Shared emit-side helpers used by every event's `emitOutput`.
 *
 * - `asString(body)`: accept a string or a built-up `OutputBuilder`, return
 *   a plain string. Used for `toUser` / `toClaude` options.
 *
 * - `CommonEmitOptions` / `CommonJsonOutput`: the fields every Claude Code
 *   hook supports at the top level of the output JSON.
 *
 * - `mixinCommon(out, opts)`: apply those top-level common fields from an
 *   options object onto an output payload. Each event's `emitOutput` calls
 *   this first, then layers its event-specific fields on top.
 *
 * - `hasHookSpecificFields(hs)`: whether a `hookSpecificOutput` carries
 *   anything worth emitting.
 */

interface CommonEmitOptions {
    /**
     * Shown to the user in the Claude Code UI. Maps to `systemMessage`,
     * with a leading newline prepended so the first row of formatted output
     * (a box's top border, a table header) doesn't render on the same line
     * as Claude Code's hook label.
     */
    toUser?: string | OutputBuilder;
    /** Default true. Setting false tells Claude to stop entirely. */
    continue?: boolean;
    /** Shown when `continue: false`. */
    stopReason?: string;
    /** If true, hide the hook's stdout from the transcript. */
    suppressOutput?: boolean;
    /**
     * Terminal escape sequence for Claude Code to emit on your behalf, e.g. an
     * OSC 9 desktop notification. Only OSC 0/1/2/9/99/777 and BEL survive.
     */
    terminalSequence?: string;
}

/** Every hook event Claude Code fires, in the order its schema lists them. */
declare const HOOK_EVENT_NAMES: readonly ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch", "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded", "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay"];
type HookEventName = typeof HOOK_EVENT_NAMES[number];
/**
 * `defer` pauses a headless (`-p`) run with the call preserved so an Agent
 * SDK wrapper can decide; interactive sessions ignore it.
 */
type DecisionType = 'allow' | 'deny' | 'ask' | 'defer';
/**
 * A union of the values Claude Code sends today that still accepts any
 * string. Claude Code types these fields as plain strings and adds values
 * between releases, so a closed union would reject real input.
 */
type OpenUnion<T extends string> = T | (string & {});
type PermissionMode = OpenUnion<'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'>;
type EffortLevel = OpenUnion<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
/** The MCP server behind an `mcp__*` tool. Absent for built-in tools. */
interface McpServerInfo {
    /** The server's config key. */
    name: string;
    source: OpenUnion<'sdk' | 'plugin' | 'user' | 'project' | 'local' | 'dynamic' | 'managed' | 'enterprise' | 'claudeai' | 'agent'>;
}
type PermissionRuleBehavior = 'allow' | 'deny' | 'ask';
type PermissionDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
interface PermissionRule {
    toolName: string;
    ruleContent?: string;
}
/**
 * A change to permission settings — what "always allow" in the permission
 * dialog applies. `PermissionRequest` receives these as suggestions and can
 * return them as `updatedPermissions`.
 */
type PermissionUpdate = {
    type: 'addRules' | 'replaceRules' | 'removeRules';
    rules: PermissionRule[];
    behavior: PermissionRuleBehavior;
    destination: PermissionDestination;
} | {
    type: 'setMode';
    mode: PermissionMode;
    destination: PermissionDestination;
} | {
    type: 'addDirectories' | 'removeDirectories';
    directories: string[];
    destination: PermissionDestination;
};
/**
 * Common fields every hook receives. Keys match the Claude Code hook spec
 * verbatim (snake_case) so what you read in the docs is what you type.
 */
interface CommonHookInput {
    hook_event_name: HookEventName;
    session_id: string;
    transcript_path: string;
    cwd: string;
    /** Correlates every event from one user prompt until the next. Absent before the first prompt. */
    prompt_id?: string;
    permission_mode?: PermissionMode;
    /** Present only inside a subagent. Use this, not `agent_type`, to tell subagent calls from main-thread calls. */
    agent_id?: string;
    /** Present inside a subagent, or on the main thread of a `--agent` session. */
    agent_type?: string;
    /** Present for tool-context events on models that support effort. */
    effort?: {
        level: EffortLevel;
    };
}

/**
 * Shared stdin read + event-name validation for all hook events.
 *
 * Each event's static `parse()` calls `readHookInput('PreToolUse')` to get a
 * validated raw payload, typed so `hook_event_name` is narrowed to the
 * expected literal. Field keys stay snake_case — they match the Claude Code
 * hook spec verbatim, so what you read in the docs is what you type.
 *
 * Parse failures throw `HookParseError`. It carries the would-be exit code
 * (2) and a human-readable message so callers can handle it however they
 * like — write to stderr and exit, turn it into a different signal, swallow
 * it in tests, etc.
 */

type RawHookInput<N extends HookEventName> = CommonHookInput & {
    hook_event_name: N;
};
/**
 * Thrown when `readHookInput` can't produce a valid payload for the expected
 * event. The message is user-facing; `exitCode` is the hook-protocol signal
 * a top-level runner should relay to the OS.
 */
declare class HookParseError extends Error {
    readonly parseError: string;
    readonly exitCode: 2;
    constructor(parseError: string);
}

/**
 * ConfigChange — runs when a settings file or skill changes on disk during a
 * session.
 *
 * Set `deny: true` to keep the change from taking effect in this session
 * (e.g. an unreviewed edit that loosens permissions). Changes to
 * `policy_settings` can't be blocked.
 */

interface ConfigChangeInput extends RawHookInput<'ConfigChange'> {
    source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills';
    file_path?: string;
}
interface ConfigChangeEmitOptions extends CommonEmitOptions {
    /** Reject the change. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; explains why. */
    reason?: string;
}
declare class ConfigChange {
    static parse(): ConfigChangeInput;
    static emitOutput(opts?: ConfigChangeEmitOptions): never;
}

/**
 * CwdChanged — runs when the session's working directory changes.
 *
 * Return `watchPaths` to (re)arm `FileChanged` hooks for files in the new
 * directory — e.g. watch `.envrc` or `.nvmrc` wherever the user goes.
 */

interface CwdChangedInput extends RawHookInput<'CwdChanged'> {
    old_cwd: string;
    new_cwd: string;
}
interface CwdChangedEmitOptions extends CommonEmitOptions {
    /** Files to watch; changes fire `FileChanged` hooks. Maps to `hookSpecificOutput.watchPaths`. */
    watchPaths?: string[];
}
declare class CwdChanged {
    static parse(): CwdChangedInput;
    static emitOutput(opts?: CwdChangedEmitOptions): never;
}

/**
 * DirectoryAdded — runs when a working directory is added mid-session, via
 * `/add-dir` or the SDK's `register_repo_root`. Observational.
 */

interface DirectoryAddedInput extends RawHookInput<'DirectoryAdded'> {
    /** Absolute path of the added directory. */
    directory: string;
    source: 'slash_command' | 'register_repo_root';
}
type DirectoryAddedEmitOptions = CommonEmitOptions;
declare class DirectoryAdded {
    static parse(): DirectoryAddedInput;
    static emitOutput(opts?: DirectoryAddedEmitOptions): never;
}

/**
 * Elicitation — runs when an MCP server asks the user for input mid-tool-call.
 *
 * Answer it programmatically instead of showing the dialog:
 *
 *   Elicitation.emitOutput({ action: 'accept', content: { env: 'staging' } });
 *   Elicitation.emitOutput({ action: 'decline', reason: 'not allowed from CI' });
 *
 * Emit nothing to let the user answer as usual. `requested_schema` is the
 * JSON schema `content` must satisfy (form mode); `url` is set in URL mode.
 */

type ElicitationAction = 'accept' | 'decline' | 'cancel';
interface ElicitationInput extends RawHookInput<'Elicitation'> {
    mcp_server_name: string;
    message: string;
    mode?: 'form' | 'url';
    url?: string;
    elicitation_id?: string;
    requested_schema?: Record<string, unknown>;
}
interface ElicitationEmitOptions extends CommonEmitOptions {
    /** Respond on the user's behalf. Maps to `hookSpecificOutput.action`. */
    action?: ElicitationAction;
    /** The form values to send with `accept`. Maps to `hookSpecificOutput.content`. */
    content?: Record<string, unknown>;
    /** With `decline`, the message reported back. */
    reason?: string;
}
declare class Elicitation {
    static parse(): ElicitationInput;
    static emitOutput(opts?: ElicitationEmitOptions): never;
}

/**
 * ElicitationResult — runs after the user answers an MCP elicitation, before
 * the answer is sent back to the server.
 *
 * Observe the answer, or override it: `action` / `content` replace what the
 * user chose; `action: 'decline'` blocks the response, with `reason` as the
 * message.
 */

interface ElicitationResultInput extends RawHookInput<'ElicitationResult'> {
    mcp_server_name: string;
    elicitation_id?: string;
    mode?: 'form' | 'url';
    /** What the user chose. */
    action: ElicitationAction;
    /** The values the user submitted. */
    content?: Record<string, unknown>;
}
type ElicitationResultEmitOptions = ElicitationEmitOptions;
declare class ElicitationResult {
    static parse(): ElicitationResultInput;
    static emitOutput(opts?: ElicitationResultEmitOptions): never;
}

/**
 * FileChanged — runs when a watched file changes on disk. Files are watched
 * via the hook's matcher or `watchPaths` returned by `SessionStart`,
 * `CwdChanged`, or an earlier `FileChanged`.
 *
 * Return `watchPaths` to update the watch list.
 */

interface FileChangedInput extends RawHookInput<'FileChanged'> {
    file_path: string;
    event: 'change' | 'add' | 'unlink';
}
interface FileChangedEmitOptions extends CommonEmitOptions {
    /** Files to watch. Maps to `hookSpecificOutput.watchPaths`. */
    watchPaths?: string[];
}
declare class FileChanged {
    static parse(): FileChangedInput;
    static emitOutput(opts?: FileChangedEmitOptions): never;
}

/**
 * InstructionsLoaded — runs when a CLAUDE.md or `.claude/rules/*.md` file is
 * loaded into context. Observational: audit which instructions a session
 * actually saw, and why (`load_reason`).
 */

interface InstructionsLoadedInput extends RawHookInput<'InstructionsLoaded'> {
    file_path: string;
    memory_type: 'User' | 'Project' | 'Local' | 'Managed';
    load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact';
    /** For `path_glob_match`: the rule's globs. */
    globs?: string[];
    /** The file whose access triggered the load. */
    trigger_file_path?: string;
    /** For `include`: the file that included this one. */
    parent_file_path?: string;
}
type InstructionsLoadedEmitOptions = CommonEmitOptions;
declare class InstructionsLoaded {
    static parse(): InstructionsLoadedInput;
    static emitOutput(opts?: InstructionsLoadedEmitOptions): never;
}

/**
 * MessageDisplay — runs with each batch of newly completed lines while an
 * assistant message streams to the screen.
 *
 * Display-only: `displayContent` replaces the `delta` on screen (redact a
 * token, restyle a line) without changing the stored message Claude sees.
 * Runs on every flush, so keep it fast.
 */

interface MessageDisplayInput extends RawHookInput<'MessageDisplay'> {
    turn_id: string;
    /** Stable across every flush of the same message. Not the API `msg_…` id. */
    message_id: string;
    /** Zero-based flush index within the message. */
    index: number;
    /** True on the message's last flush. */
    final: boolean;
    /** Lines completed since the previous flush. Whole lines, except possibly on the final flush. */
    delta: string;
}
interface MessageDisplayEmitOptions extends CommonEmitOptions {
    /** Text shown in place of `delta`. Maps to `hookSpecificOutput.displayContent`. */
    displayContent?: string;
}
declare class MessageDisplay {
    static parse(): MessageDisplayInput;
    static emitOutput(opts?: MessageDisplayEmitOptions): never;
}

/**
 * Notification — runs when Claude Code wants to notify the user (permission
 * prompt, idle, auth success, MCP elicitation, background-agent status,
 * usage-limit auto-resume). Mostly observational: show the user something,
 * forward it elsewhere, or ring the terminal with `terminalSequence`.
 */

type NotificationType = OpenUnion<'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog' | 'elicitation_url_dialog' | 'elicitation_complete' | 'elicitation_response' | 'agent_needs_input' | 'agent_completed' | 'quota_auto_resume_fired' | 'quota_auto_resume_stale' | 'quota_auto_resume_disabled'>;
interface NotificationInput extends RawHookInput<'Notification'> {
    message: string;
    title?: string;
    notification_type: NotificationType;
}
interface NotificationEmitOptions extends CommonEmitOptions {
    /** Added to Claude's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
}
declare class Notification {
    static parse(): NotificationInput;
    static emitOutput(opts?: NotificationEmitOptions): never;
}

/**
 * PermissionDenied — runs when auto mode's classifier denies a tool call.
 *
 * Set `retry: true` to tell Claude it may try the call again (e.g. after
 * your hook has fixed whatever the classifier objected to). Ignored when the
 * classifier produced no verdict.
 */

interface PermissionDeniedInput extends RawHookInput<'PermissionDenied'> {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    /** Why the call was denied. */
    reason: string;
    mcp_server?: McpServerInfo;
}
interface PermissionDeniedEmitOptions extends CommonEmitOptions {
    /** Let Claude retry the denied call. Maps to `hookSpecificOutput.retry`. */
    retry?: boolean;
}
declare class PermissionDenied {
    static parse(): PermissionDeniedInput;
    static emitOutput(opts?: PermissionDeniedEmitOptions): never;
}

/**
 * PermissionRequest — runs when a permission dialog is about to be shown.
 *
 * Answer it on the user's behalf, or emit nothing to let the dialog appear:
 *
 *   PermissionRequest.emitOutput({ decision: 'allow' });
 *   PermissionRequest.emitOutput({ decision: 'deny', reason: 'not on main', interrupt: true });
 *
 * Unlike `PreToolUse`, this only fires when a prompt would actually be
 * shown, so it can't see calls that settings already allow. The options are
 * a discriminated union on `decision`: `updatedInput` / `updatedPermissions`
 * only type-check with `allow`, `reason` / `interrupt` only with `deny`.
 */

interface PermissionRequestInput extends RawHookInput<'PermissionRequest'> {
    tool_name: string;
    tool_input: Record<string, unknown>;
    /** The "always allow" options the dialog would offer. */
    permission_suggestions?: PermissionUpdate[];
    mcp_server?: McpServerInfo;
}
interface PermissionRequestNoDecision {
    decision?: undefined;
}
interface PermissionRequestAllow {
    /** Approve the call without showing the dialog. */
    decision: 'allow';
    /** Replace the tool's input before it runs. */
    updatedInput?: Record<string, unknown>;
    /** Apply permission changes, e.g. one of `permission_suggestions`. */
    updatedPermissions?: PermissionUpdate[];
}
interface PermissionRequestDeny {
    /** Reject the call without showing the dialog. */
    decision: 'deny';
    /** Tells Claude why. Maps to `decision.message`. */
    reason?: string;
    /** Stop Claude's turn instead of letting it try something else. */
    interrupt?: boolean;
}
type PermissionRequestEmitOptions = CommonEmitOptions & (PermissionRequestNoDecision | PermissionRequestAllow | PermissionRequestDeny);
declare class PermissionRequest {
    static parse(): PermissionRequestInput;
    static emitOutput(opts?: PermissionRequestEmitOptions): never;
}

/**
 * PostCompact — runs after Claude Code compacts the conversation.
 *
 * `compact_summary` is the summary that replaced the history — useful for
 * archiving or checking that nothing important was dropped. Compaction has
 * already happened, so there's nothing to block.
 */

interface PostCompactInput extends RawHookInput<'PostCompact'> {
    trigger: 'manual' | 'auto';
    compact_summary: string;
}
type PostCompactEmitOptions = CommonEmitOptions;
declare class PostCompact {
    static parse(): PostCompactInput;
    static emitOutput(opts?: PostCompactEmitOptions): never;
}

/**
 * PreModelSwitch — runs before a model change takes effect.
 *
 * Same decision contract as `PreToolUse`: `allow` proceeds (skipping the
 * interactive cache-miss confirmation), `deny` cancels the switch, `ask`
 * asks the user (treated as deny where nobody can answer). The input carries
 * what the switch will cost — a switch forfeits the prompt cache, so
 * `estimated_cache_write_usd` is what re-caching `context_tokens` will run.
 */

/** Fields shared by `PreModelSwitch` and `PostModelSwitch`. */
interface ModelSwitchInfo {
    /** Resolved model id before the switch. */
    from_model: string;
    /** Resolved model id after the switch. */
    to_model: string;
    /** What was asked for (an alias like `opus`, a full id, or `null` for the default). */
    requested_model: string | null;
    /** Prompt tokens the next request re-sends. */
    context_tokens: number;
    /** Whether the current model's prompt cache is likely still warm (a switch forfeits it). */
    prompt_cache_warm: boolean;
    cache_ttl: '5m' | '1h';
    /** Estimated cost of re-caching `context_tokens` on `to_model`. */
    estimated_cache_write_usd: number;
    /** How the estimate was priced: org-configured pricing, list price, or a default tier for an unknown model. */
    pricing: 'configured' | 'catalog' | 'default';
}
interface PreModelSwitchInput extends RawHookInput<'PreModelSwitch'>, ModelSwitchInfo {
    /** `command` = `/model` or config, `picker` = the model picker, `sdk` = headless `set_model`. */
    source: 'command' | 'picker' | 'sdk';
}
interface PreModelSwitchEmitOptions extends CommonEmitOptions {
    /** allow / deny / ask. Maps to `hookSpecificOutput.permissionDecision`. */
    decision?: 'allow' | 'deny' | 'ask';
    /** Explanation shown alongside the decision. */
    reason?: string;
}
declare class PreModelSwitch {
    static parse(): PreModelSwitchInput;
    static emitOutput(opts?: PreModelSwitchEmitOptions): never;
}

/**
 * PostModelSwitch — runs after the session's model has changed, including
 * automatic fallbacks (`source: 'auto'`) and restores on resume, which
 * `PreModelSwitch` never sees.
 *
 * `toClaude` reaches the new model with the first request it serves.
 */

interface PostModelSwitchInput extends RawHookInput<'PostModelSwitch'>, ModelSwitchInfo {
    /** As `PreModelSwitch`, plus `auto` (fallback or programmatic change) and `resume`. */
    source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume';
}
interface PostModelSwitchEmitOptions extends CommonEmitOptions {
    /** Added to the new model's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
}
declare class PostModelSwitch {
    static parse(): PostModelSwitchInput;
    static emitOutput(opts?: PostModelSwitchEmitOptions): never;
}

/**
 * PostToolBatch — runs once after every tool call in a batch has resolved,
 * before the next model request.
 *
 * `PostToolUse` fires per tool and may run concurrently for parallel calls;
 * this fires exactly once with the whole batch, so it's the place for checks
 * that need to see all the results together.
 */

interface ToolCallResult {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    tool_response?: unknown;
}
interface PostToolBatchInput extends RawHookInput<'PostToolBatch'> {
    tool_calls: ToolCallResult[];
}
interface PostToolBatchEmitOptions extends CommonEmitOptions {
    /** Added to Claude's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
}
declare class PostToolBatch {
    static parse(): PostToolBatchInput;
    static emitOutput(opts?: PostToolBatchEmitOptions): never;
}

/**
 * PostToolUse — runs after a tool has finished.
 *
 * Typical use: inspect `tool_response` and either let the result through
 * unchanged or tell Claude to treat it as failed (`deny: true`) with a
 * `reason` so the model knows why.
 */

interface PostToolUseInput extends RawHookInput<'PostToolUse'> {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_response: unknown;
    tool_use_id: string;
    /** Tool execution time, excluding permission-prompt and hook time. */
    duration_ms?: number;
    mcp_server?: McpServerInfo;
}
interface PostToolUseEmitOptions extends CommonEmitOptions {
    /** Added to Claude's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
    /** Tell Claude to treat the just-completed call as rejected. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny` (shown to Claude) or as context for the user. */
    reason?: string;
    /** Replace what Claude sees as the tool's response. Works for every tool. */
    updatedToolOutput?: unknown;
    /** @deprecated MCP tools only — use `updatedToolOutput`, which works for every tool. */
    updatedMCPToolOutput?: Record<string, unknown>;
}
declare class PostToolUse {
    static parse(): PostToolUseInput;
    static emitOutput(opts?: PostToolUseEmitOptions): never;
}

/**
 * PostToolUseFailure — runs after a tool call fails (the counterpart to
 * `PostToolUse`, which only fires on success).
 *
 * The call has already failed, so there's nothing to block. Use `toClaude`
 * to explain the failure or suggest a fix. `is_interrupt` separates a user
 * interrupt from a genuine error.
 */

interface PostToolUseFailureInput extends RawHookInput<'PostToolUseFailure'> {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    error: string;
    is_interrupt?: boolean;
    /** Tool execution time, excluding permission-prompt and hook time. */
    duration_ms?: number;
    mcp_server?: McpServerInfo;
}
interface PostToolUseFailureEmitOptions extends CommonEmitOptions {
    /** Added to Claude's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
}
declare class PostToolUseFailure {
    static parse(): PostToolUseFailureInput;
    static emitOutput(opts?: PostToolUseFailureEmitOptions): never;
}

/**
 * PreCompact — runs before Claude Code compacts the conversation.
 *
 * `trigger` distinguishes `auto` (context limit reached) from `manual`
 * (user ran /compact). Set `deny: true` to prevent the compaction.
 */

interface PreCompactInput extends RawHookInput<'PreCompact'> {
    trigger: 'manual' | 'auto';
    /** Extra instructions for the summary (e.g. from `/compact <text>`); `null` when none were given. */
    custom_instructions: string | null;
}
interface PreCompactEmitOptions extends CommonEmitOptions {
    /** Prevent compaction. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; shown to Claude. */
    reason?: string;
}
declare class PreCompact {
    static parse(): PreCompactInput;
    static emitOutput(opts?: PreCompactEmitOptions): never;
}

/**
 * PreToolUse — runs before Claude calls a tool.
 *
 *   const input = PreToolUse.parse();
 *   if (isDangerous(input.tool_name, input.tool_input)) {
 *       PreToolUse.emitOutput({ decision: 'deny', reason: 'no raw rm' });
 *   } else {
 *       PreToolUse.emitOutput({});
 *   }
 *
 * Input fields are snake_case — they match Claude Code's JSON spec verbatim.
 * Output option names are camelCase — they're our API, mapped to the spec's
 * JSON field names by `emitOutput`.
 */

interface PreToolUseInput extends RawHookInput<'PreToolUse'> {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    mcp_server?: McpServerInfo;
}
interface PreToolUseEmitOptions extends CommonEmitOptions {
    /** Added to Claude's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
    /** allow / deny / ask / defer. Maps to `hookSpecificOutput.permissionDecision`. */
    decision?: DecisionType;
    /** Explanation Claude (or the user, for `ask`) sees alongside the decision. */
    reason?: string;
    /** Patch to apply to the tool input before the call. */
    updatedInput?: Record<string, unknown>;
}
declare class PreToolUse {
    static parse(): PreToolUseInput;
    static emitOutput(opts?: PreToolUseEmitOptions): never;
}

/**
 * SessionEnd — runs when a Claude Code session ends.
 *
 * Output-only to the user — there's no future turn to influence. Use it for
 * teardown messaging: final stats, cleanup confirmations, etc.
 */

interface SessionEndInput extends RawHookInput<'SessionEnd'> {
    reason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other';
}
type SessionEndEmitOptions = CommonEmitOptions;
declare class SessionEnd {
    static parse(): SessionEndInput;
    static emitOutput(opts?: SessionEndEmitOptions): never;
}

/**
 * SessionStart — runs when a Claude Code session begins.
 *
 * `source` tells you which flavor of start this is — `startup`, `resume`,
 * `clear`, `compact`, or `fork`. Scripts commonly branch on it to seed
 * different context (e.g. only inject TODO reminders on `startup`).
 *
 * No deny: there's no "session-start rejected" in the spec.
 */

interface SessionStartInput extends RawHookInput<'SessionStart'> {
    source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
    model?: string;
    session_title?: string;
    /** resume/fork only: seconds since the resumed transcript's last assistant response. */
    seconds_since_last_response?: number;
    /** resume/fork only: tokens the first request will re-send. */
    context_tokens?: number;
    /** resume/fork only: the prompt cache has likely expired, so `context_tokens` will be re-cached. */
    prompt_cache_likely_expired?: boolean;
    /** resume/fork only: estimated USD cost of re-caching `context_tokens`. */
    estimated_cache_write_usd?: number;
}
interface SessionStartEmitOptions extends CommonEmitOptions {
    /** Appended to Claude's session context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
    /** Submitted as the session's first user message. */
    initialUserMessage?: string;
    /** Set the session's title. */
    sessionTitle?: string;
    /** Files to watch; changes fire `FileChanged` hooks. */
    watchPaths?: string[];
    /** Re-scan skill directories after SessionStart hooks finish, so skills this hook installed are usable immediately. */
    reloadSkills?: boolean;
}
declare class SessionStart {
    static parse(): SessionStartInput;
    static emitOutput(opts?: SessionStartEmitOptions): never;
}

/**
 * Setup — runs for Claude Code's `--init`, `--init-only`, and
 * `--maintenance` flags: one-off repository setup (install deps, seed
 * config) or periodic upkeep, outside a normal session start.
 *
 * `trigger` says which flag ran it. `toClaude` adds context for the run.
 */

interface SetupInput extends RawHookInput<'Setup'> {
    trigger: 'init' | 'maintenance';
}
interface SetupEmitOptions extends CommonEmitOptions {
    /** Added to Claude's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
}
declare class Setup {
    static parse(): SetupInput;
    static emitOutput(opts?: SetupEmitOptions): never;
}

/**
 * Stop — runs when Claude finishes responding.
 *
 * Two ways to keep Claude going:
 *   - `deny: true` + `reason` blocks the stop; `reason` tells Claude why it
 *     must continue. `stop_hook_active` lets you detect re-entry and avoid
 *     loops.
 *   - `toClaude` sends non-error feedback; the conversation continues so
 *     Claude can act on it, without the stop being treated as rejected.
 *
 * `background_tasks` / `session_crons` tell "done" apart from "paused until
 * background work or a scheduled wakeup resumes the session".
 */

/** In-flight background work (shells, subagents, monitors, workflows). */
interface BackgroundTask {
    id: string;
    /** e.g. `shell`, `subagent`, `monitor`, `workflow`. */
    type: string;
    status: string;
    description: string;
    /** `shell` tasks only. */
    command?: string;
    /** `subagent` tasks only. */
    agent_type?: string;
    /** MCP tasks only. */
    server?: string;
    /** MCP tasks only. */
    tool?: string;
    /** `workflow` tasks only. */
    name?: string;
}
/** A session-scoped scheduled wakeup (CronCreate, ScheduleWakeup, /loop). */
interface SessionCron {
    id: string;
    /** Cron expression, e.g. `0 9 * * 1-5`. */
    schedule: string;
    /** False for one-shot wakeups. */
    recurring: boolean;
    prompt: string;
}
interface StopInput extends RawHookInput<'Stop'> {
    stop_hook_active: boolean;
    /** Text of Claude's final message — saves parsing the transcript. */
    last_assistant_message?: string;
    background_tasks?: BackgroundTask[];
    session_crons?: SessionCron[];
}
interface StopEmitOptions extends CommonEmitOptions {
    /** Non-error feedback for Claude; the conversation continues. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
    /** Prevent Claude from stopping. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; tells Claude why it must keep going. */
    reason?: string;
}
declare class Stop {
    static parse(): StopInput;
    static emitOutput(opts?: StopEmitOptions): never;
}

/**
 * StopFailure — runs when a turn ends because of an API error instead of
 * Claude finishing normally.
 *
 * Observational: log the failure, notify someone, or show the user a hint.
 * Claude isn't running, so there's no context to inject and nothing to block.
 */

type StopFailureError = 'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' | 'verification_required' | 'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens' | 'cloud_credential_error';
interface StopFailureInput extends RawHookInput<'StopFailure'> {
    error: StopFailureError;
    error_details?: string;
    last_assistant_message?: string;
}
type StopFailureEmitOptions = CommonEmitOptions;
declare class StopFailure {
    static parse(): StopFailureInput;
    static emitOutput(opts?: StopFailureEmitOptions): never;
}

/**
 * SubagentStart — runs when a subagent is spawned.
 *
 * Use `toClaude` to seed the subagent with context (conventions, a reminder
 * of the task's constraints) before it starts working. Pair with
 * `SubagentStop` on `agent_id` to track a subagent's lifetime.
 */

interface SubagentStartInput extends RawHookInput<'SubagentStart'> {
    agent_id: string;
    /** e.g. `general-purpose`, `Explore`, or a custom agent name. */
    agent_type: string;
}
interface SubagentStartEmitOptions extends CommonEmitOptions {
    /** Added to the subagent's context. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
}
declare class SubagentStart {
    static parse(): SubagentStartInput;
    static emitOutput(opts?: SubagentStartEmitOptions): never;
}

/**
 * SubagentStop — runs when a subagent finishes.
 *
 * Same shape as `Stop`: `deny: true` forces the subagent to keep going,
 * `toClaude` sends it non-error feedback. Separate event so you can gate
 * subagents differently from the top-level agent — `agent_type` says which
 * kind of subagent this is.
 */

interface SubagentStopInput extends RawHookInput<'SubagentStop'> {
    stop_hook_active: boolean;
    agent_id: string;
    /** e.g. `general-purpose`, `Explore`, or a custom agent name. */
    agent_type: string;
    agent_transcript_path: string;
    /** Text of the subagent's final message — saves parsing the transcript. */
    last_assistant_message?: string;
    background_tasks?: BackgroundTask[];
    session_crons?: SessionCron[];
}
interface SubagentStopEmitOptions extends CommonEmitOptions {
    /** Non-error feedback for the subagent; it continues. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
    /** Prevent the subagent from stopping. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; tells the subagent why it must keep going. */
    reason?: string;
}
declare class SubagentStop {
    static parse(): SubagentStopInput;
    static emitOutput(opts?: SubagentStopEmitOptions): never;
}

/**
 * TaskCreated — runs when a task is created with the `TaskCreate` tool.
 *
 * Set `deny: true` to reject the task (e.g. it lacks acceptance criteria);
 * `reason` tells Claude what to fix.
 */

/** Fields shared by `TaskCreated` and `TaskCompleted`. */
interface TaskInfo {
    task_id: string;
    task_subject: string;
    task_description?: string;
    /** Set when the task belongs to an agent-team teammate. */
    teammate_name?: string;
    /** @deprecated Sessions have a single implicit team; Claude Code will remove this. */
    team_name?: string;
}
interface TaskCreatedInput extends RawHookInput<'TaskCreated'>, TaskInfo {
}
interface TaskCreatedEmitOptions extends CommonEmitOptions {
    /** Reject the task. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; tells Claude why. */
    reason?: string;
}
declare class TaskCreated {
    static parse(): TaskCreatedInput;
    static emitOutput(opts?: TaskCreatedEmitOptions): never;
}

/**
 * TaskCompleted — runs when a task is being marked completed.
 *
 * Set `deny: true` to keep the task open (e.g. tests still fail); `reason`
 * tells Claude what's missing.
 */

interface TaskCompletedInput extends RawHookInput<'TaskCompleted'>, TaskInfo {
}
interface TaskCompletedEmitOptions extends CommonEmitOptions {
    /** Keep the task open. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; tells Claude what's missing. */
    reason?: string;
}
declare class TaskCompleted {
    static parse(): TaskCompletedInput;
    static emitOutput(opts?: TaskCompletedEmitOptions): never;
}

/**
 * TeammateIdle — runs when an agent-team teammate is about to go idle.
 *
 * Set `deny: true` to keep the teammate working; `reason` tells it what's
 * left to do. To stop the teammate outright, use `continue: false`.
 */

interface TeammateIdleInput extends RawHookInput<'TeammateIdle'> {
    teammate_name: string;
    /** @deprecated Sessions have a single implicit team; Claude Code will remove this. */
    team_name: string;
}
interface TeammateIdleEmitOptions extends CommonEmitOptions {
    /** Keep the teammate working. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; tells the teammate why it must keep going. */
    reason?: string;
}
declare class TeammateIdle {
    static parse(): TeammateIdleInput;
    static emitOutput(opts?: TeammateIdleEmitOptions): never;
}

/**
 * UserPromptExpansion — runs when a slash command or MCP prompt the user
 * typed expands, before the expanded text reaches Claude.
 *
 * Same controls as `UserPromptSubmit`: `deny: true` cancels it, `toClaude`
 * adds context alongside it. `prompt` is the expanded text; `command_name` /
 * `command_args` are what the user actually typed.
 */

interface UserPromptExpansionInput extends RawHookInput<'UserPromptExpansion'> {
    expansion_type: 'slash_command' | 'mcp_prompt';
    command_name: string;
    command_args: string;
    command_source?: string;
    prompt: string;
}
interface UserPromptExpansionEmitOptions extends CommonEmitOptions {
    /** Added alongside the expanded prompt. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
    /** Cancel the expansion. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; explains why. */
    reason?: string;
    /** With `deny`, leave the original prompt out of the block message. */
    suppressOriginalPrompt?: boolean;
}
declare class UserPromptExpansion {
    static parse(): UserPromptExpansionInput;
    static emitOutput(opts?: UserPromptExpansionEmitOptions): never;
}

/**
 * UserPromptSubmit — runs when the user submits a prompt, before Claude sees it.
 *
 * Set `deny: true` to cancel the prompt entirely. Use `toClaude` to inject
 * extra context alongside the user's prompt (Claude sees it, user doesn't).
 *
 * `source` distinguishes a prompt typed by the user from one a machine
 * injected (SDK, /loop wakeups, scheduled tasks, task notifications) — handy
 * when a hook should only react to real user input.
 */

interface UserPromptSubmitInput extends RawHookInput<'UserPromptSubmit'> {
    prompt: string;
    /** Optional while the field rolls out — treat absent as unknown, not as `user`. */
    source?: 'user' | 'sdk' | 'system' | 'loop_wakeup' | 'schedule_wakeup' | 'poll_event';
    session_title?: string;
}
interface UserPromptSubmitEmitOptions extends CommonEmitOptions {
    /** Injected alongside the user's prompt. Maps to `hookSpecificOutput.additionalContext`. */
    toClaude?: string | OutputBuilder;
    /** Cancel the prompt before Claude sees it. Maps to top-level `decision: "block"`. */
    deny?: boolean;
    /** Paired with `deny`; explains why the prompt was cancelled. */
    reason?: string;
    /** With `deny`, leave the original prompt out of the block message. */
    suppressOriginalPrompt?: boolean;
    /** Set or update the session's title. */
    sessionTitle?: string;
}
declare class UserPromptSubmit {
    static parse(): UserPromptSubmitInput;
    static emitOutput(opts?: UserPromptSubmitEmitOptions): never;
}

/**
 * WorktreeCreate — runs when Claude Code needs a worktree (`--worktree`,
 * `isolation: "worktree"`, background sessions). The hook *replaces* the
 * default `git worktree add`: create the directory however you like, then
 * report where it is.
 *
 *   const { name } = WorktreeCreate.parse();
 *   const path = createMyWorktree(name);
 *   WorktreeCreate.emitOutput({ worktreePath: path });
 *
 * The one event whose reply isn't JSON: command hooks print the bare path on
 * stdout, so `emitOutput` does exactly that. To fail creation, throw — any
 * non-zero exit fails it.
 */

interface WorktreeCreateInput extends RawHookInput<'WorktreeCreate'> {
    /** Suggested worktree name. */
    name: string;
}
interface WorktreeCreateEmitOptions {
    /** Absolute path of the worktree you created. */
    worktreePath: string;
}
declare class WorktreeCreate {
    static parse(): WorktreeCreateInput;
    static emitOutput(opts: WorktreeCreateEmitOptions): never;
}

/**
 * WorktreeRemove — runs when a worktree is removed (at session exit or on
 * deletion). The counterpart to `WorktreeCreate`: clean up whatever that
 * hook set up. Observational; removal can't be blocked.
 */

interface WorktreeRemoveInput extends RawHookInput<'WorktreeRemove'> {
    worktree_path: string;
}
type WorktreeRemoveEmitOptions = CommonEmitOptions;
declare class WorktreeRemove {
    static parse(): WorktreeRemoveInput;
    static emitOutput(opts?: WorktreeRemoveEmitOptions): never;
}

export { PermissionRequest as $, type McpServerInfo as A, type BackgroundTask as B, COLORS as C, type DecisionType as D, type EffortLevel as E, FileChanged as F, MessageDisplay as G, HOOK_EVENT_NAMES as H, InstructionsLoaded as I, type MessageDisplayEmitOptions as J, type MessageDisplayInput as K, type ListOptions as L, MODIFIERS as M, type ModelSwitchInfo as N, type ModifierName as O, Notification as P, type NotificationEmitOptions as Q, type NotificationInput as R, type NotificationType as S, type Theme as T, type OpenUnion as U, OutputBuilder as V, PermissionDenied as W, type PermissionDeniedEmitOptions as X, type PermissionDeniedInput as Y, type PermissionDestination as Z, type PermissionMode as _, type BoxOptions as a, type ToolCallResult as a$, type PermissionRequestEmitOptions as a0, type PermissionRequestInput as a1, type PermissionRule as a2, type PermissionRuleBehavior as a3, type PermissionUpdate as a4, PostCompact as a5, type PostCompactEmitOptions as a6, type PostCompactInput as a7, PostModelSwitch as a8, type PostModelSwitchEmitOptions as a9, Setup as aA, type SetupEmitOptions as aB, type SetupInput as aC, Stop as aD, type StopEmitOptions as aE, StopFailure as aF, type StopFailureEmitOptions as aG, type StopFailureError as aH, type StopFailureInput as aI, type StopInput as aJ, SubagentStart as aK, type SubagentStartEmitOptions as aL, type SubagentStartInput as aM, SubagentStop as aN, type SubagentStopEmitOptions as aO, type SubagentStopInput as aP, type TableOptions as aQ, TaskCompleted as aR, type TaskCompletedEmitOptions as aS, type TaskCompletedInput as aT, TaskCreated as aU, type TaskCreatedEmitOptions as aV, type TaskCreatedInput as aW, type TaskInfo as aX, TeammateIdle as aY, type TeammateIdleEmitOptions as aZ, type TeammateIdleInput as a_, type PostModelSwitchInput as aa, PostToolBatch as ab, type PostToolBatchEmitOptions as ac, type PostToolBatchInput as ad, PostToolUse as ae, type PostToolUseEmitOptions as af, PostToolUseFailure as ag, type PostToolUseFailureEmitOptions as ah, type PostToolUseFailureInput as ai, type PostToolUseInput as aj, PreCompact as ak, type PreCompactEmitOptions as al, type PreCompactInput as am, PreModelSwitch as an, type PreModelSwitchEmitOptions as ao, type PreModelSwitchInput as ap, PreToolUse as aq, type PreToolUseEmitOptions as ar, type PreToolUseInput as as, type SessionCron as at, SessionEnd as au, type SessionEndEmitOptions as av, type SessionEndInput as aw, SessionStart as ax, type SessionStartEmitOptions as ay, type SessionStartInput as az, type ColorName as b, UserPromptExpansion as b0, type UserPromptExpansionEmitOptions as b1, type UserPromptExpansionInput as b2, UserPromptSubmit as b3, type UserPromptSubmitEmitOptions as b4, type UserPromptSubmitInput as b5, WorktreeCreate as b6, type WorktreeCreateEmitOptions as b7, type WorktreeCreateInput as b8, WorktreeRemove as b9, type WorktreeRemoveEmitOptions as ba, type WorktreeRemoveInput as bb, currentTheme as bc, setTheme as bd, type CommonHookInput as c, ConfigChange as d, type ConfigChangeEmitOptions as e, type ConfigChangeInput as f, CwdChanged as g, type CwdChangedEmitOptions as h, type CwdChangedInput as i, DirectoryAdded as j, type DirectoryAddedEmitOptions as k, type DirectoryAddedInput as l, type DividerOptions as m, Elicitation as n, type ElicitationAction as o, type ElicitationEmitOptions as p, type ElicitationInput as q, ElicitationResult as r, type ElicitationResultEmitOptions as s, type ElicitationResultInput as t, type FileChangedEmitOptions as u, type FileChangedInput as v, type HookEventName as w, HookParseError as x, type InstructionsLoadedEmitOptions as y, type InstructionsLoadedInput as z };
