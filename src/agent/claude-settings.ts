import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Hardened default `Settings` applied to every bot-driven Claude run, passed to
 * `query()` via `options.settings` (the highest-priority user-controlled layer,
 * so it wins over any ambient `~/.claude/settings.json`).
 *
 * It trims interactive / harness tools that make no sense for a headless
 * Telegram agent (it cannot prompt the operator, schedule wakeups, or drive
 * cron/remote surfaces) and turns off bundled skills, remote control,
 * artifacts, and the claude.ai cloud MCP connectors that would otherwise be
 * auto-fetched from the logged-in account (Notion, Canva, Gmail, …).
 * Plan mode is denied by default (`EnterPlanMode`/`ExitPlanMode`),
 * so the bot's `plan_ready` UI stays dormant unless re-enabled. Workflows are
 * left ON. Everything here is overridable at boot via `CLAUDE_SETTINGS_JSON`
 * (see `AppConfig.claudeSettings`) — e.g. `{"permissions":{"deny":[]}}` to
 * clear the deny list and turn plan mode back on.
 */
export const DEFAULT_CLAUDE_SETTINGS: Settings = {
  permissions: {
    deny: [
      "EnterPlanMode",
      "ExitPlanMode",
      "NotebookEdit",
      "AskUserQuestion",
      "SendMessage",
      "PushNotification",
      "RemoteTrigger",
      "DesignSync",
      "ReportFindings",
      "ScheduleWakeup",
      "CronCreate",
      "CronDelete",
      "CronList",
    ],
  },
  disableBundledSkills: true,
  disableRemoteControl: true,
  disableArtifact: true,
  disableClaudeAiConnectors: true,
  effortLevel: "high",
};

/**
 * Overlay a user override onto the base settings. Top-level keys replace
 * wholesale; `permissions` merges one level deep so an override can redefine
 * `deny` (or add `allow`/`ask`) without discarding the other permission arrays.
 * To fully drop a default, override that key explicitly (e.g. `deny: []`).
 */
export const mergeClaudeSettings = (
  base: Settings,
  override: Settings
): Settings => ({
  ...base,
  ...override,
  ...(base.permissions || override.permissions
    ? { permissions: { ...base.permissions, ...override.permissions } }
    : {}),
});

/** Parse a `CLAUDE_SETTINGS_JSON` override; throws on invalid JSON. */
export const parseClaudeSettings = (json: string): Settings =>
  JSON.parse(json) as Settings;
