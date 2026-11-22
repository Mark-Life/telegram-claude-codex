import path from "node:path";

import type { Options, StopHookInput } from "@anthropic-ai/claude-agent-sdk";

import { claudeBotSkills } from "./bot-skills";
import { claudeEffort, claudeModelRow } from "./claude-models";
import type { ClaudeSandbox } from "./claude-sandbox";
import { claudeIsolation, inertCommand, inertPrompt } from "./claude-sdk";
import type { OwnerSettings } from "./provider-settings";
import { runEnv } from "./run-env";
import { buildRunPrompt } from "./run-prompt";
import { credentialViewPostures } from "./sandbox/host";
import { claudeConfigDir } from "./state-roots";
import { AUTO_MODEL, DEFAULT_MODEL } from "./types";
import type {
  ProviderCapabilities,
  ProviderWiring,
  RunContext,
  RunOptions,
} from "./types";

/**
 * What the Claude provider supports. Executor and the owner's Telegram
 * account come through in-process proxies, group memory over stdio
 * (`claude-mcp-proxy.ts`).
 */
export const CLAUDE_CAPABILITIES = {
  autoModel: true,
  compaction: true,
  cost: false,
  externalTools: true,
  groupMemory: true,
  planMode: false,
  get postures() {
    // Its file tools and Bash run in the same view as the real credentials
    // file, which stays bound so the run bills the subscription; `none` has
    // no local tools (web search runs at Anthropic).
    return credentialViewPostures();
  },
  sessionsInView: false,
  telegramAccount: true,
  thinking: true,
} satisfies ProviderCapabilities & ProviderWiring;

/** Who started the child, for Anthropic's own client stats. */
const CLIENT_APP = "owner-telegram-bot";

/** The model option: a real slug, never the default or auto sentinels. */
const modelOf = (model: string | undefined) =>
  model === undefined || model === DEFAULT_MODEL || model === AUTO_MODEL
    ? undefined
    : model;

/** No local tools at all: only web search, which runs at Anthropic. */
const noneTools = (webSearch: boolean) => (webSearch ? ["WebSearch"] : []);

/** What makes a turn's text inert for this run: see `claudePrompt`. */
export const claudeInert = (opts: RunOptions) =>
  opts.access.sandbox === "danger-full-access" ? inertCommand : inertPrompt;

/**
 * Whether a run stays open past its last result for background work it
 * started: asked for by the host, and on full access, the only posture that
 * holds background tools at all.
 */
export const claudeWaits = (opts: RunOptions) =>
  opts.waitForBackground === true &&
  opts.access.sandbox === "danger-full-access";

/**
 * What a run that waits is told about `ScheduleWakeup`: the wake-up belongs
 * to this conversation, so it is for the run's own work, never the user's
 * reminder.
 */
const WAKEUP_PROMPT =
  "ScheduleWakeup is only for checking back on your own work in this conversation. Anything the user wants to be reminded of goes through the bot's reminders.";

/**
 * The prompt of one turn and the system text. Claude takes standing
 * instructions in the system prompt, sent on every turn so a resumed session
 * keeps them; the routing block and the request are the turn itself. A full
 * access run can read any file anyway, so its `@` mentions stay as written:
 * `@username` and `@scope/pkg` reach its tools unchanged.
 */
export const claudePrompt = (
  opts: RunOptions,
  ctx: Pick<RunContext, "telegramAccount">
) => {
  const { request, routing, system } = buildRunPrompt(opts, ctx, {
    userRules: path.join(claudeConfigDir(), "CLAUDE.md"),
  });
  const prompt = [routing, request].filter((part) => part.length > 0);
  return {
    prompt: claudeInert(opts)(prompt.join("\n\n")),
    system: [...system, ...(claudeWaits(opts) ? [WAKEUP_PROMPT] : [])].join(
      "\n\n"
    ),
  };
};

/**
 * The options of one run, every value fixed rather than left to a default.
 * Permission prompts are off: nobody would answer them, and the boundary is
 * the posture (the bwrap view, or the whole machine for full access). A run
 * that waits for background work hears every main-thread `Stop` through
 * `onStop`: the hook lists what is still pending just before each result.
 */
export const claudeRunOptions = (input: {
  abortController: AbortController;
  mcpServers: NonNullable<Options["mcpServers"]>;
  onStop?: (stop: StopHookInput) => void;
  opts: RunOptions;
  /** The owner's settings (`/settings`); absent keeps every default. */
  owner?: OwnerSettings;
  sandbox?: ClaudeSandbox;
  system: string;
}): Options => {
  const { access } = input.opts;
  const model = modelOf(input.opts.model);
  const row = claudeModelRow(model);
  const waits = claudeWaits(input.opts);
  const options: Options = {
    ...claudeIsolation(access.sandbox, { owner: input.owner, wakeups: waits }),
    abortController: input.abortController,
    allowDangerouslySkipPermissions: true,
    cwd: input.opts.projectDir,
    env: {
      ...runEnv({
        access,
        granted: input.opts.grantedAccess ?? access,
        provider: "claude",
        stamp: input.opts.taskAuthor,
      }),
      CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
      DISABLE_AUTOUPDATER: "1",
    },
    includePartialMessages: false,
    mcpServers: input.mcpServers,
    permissionMode: "bypassPermissions",
    // A run that waits keeps its session, so a restart can resume it; the
    // host drops a fresh task fire's transcript at its end.
    persistSession: access.persistSession || waits,
    ...claudeBotSkills(access, input.opts.projectDir),
    systemPrompt: {
      append: input.system,
      preset: "claude_code",
      snapshot: true,
      type: "preset",
    },
    tools:
      access.sandbox === "none"
        ? noneTools(access.webSearch)
        : { preset: "claude_code", type: "preset" },
  };
  if (model !== undefined) {
    options.model = model;
  }
  const effort = claudeEffort(model, input.opts.effort);
  if (effort !== undefined) {
    options.effort = effort;
  }
  if (row?.supportsAdaptiveThinking !== false) {
    options.thinking = { display: "summarized", type: "adaptive" };
  }
  const { sessionId } = input.opts;
  if (sessionId !== undefined && sessionId.length > 0) {
    options.resume = sessionId;
  }
  if (input.sandbox !== undefined) {
    options.spawnClaudeCodeProcess = input.sandbox.spawn;
  }
  const { onStop } = input;
  if (onStop !== undefined) {
    // SDK callback hooks fire even with `disableAllHooks`, which covers only
    // hooks from settings files.
    options.hooks = {
      Stop: [
        {
          hooks: [
            async (hook) => {
              if (
                hook.hook_event_name === "Stop" &&
                hook.agent_id === undefined
              ) {
                onStop(hook);
              }
              return await Promise.resolve({});
            },
          ],
        },
      ],
    };
  }
  if (access.sandbox === "workspace-write") {
    // The view reaches only Anthropic, so a fetch from the CLI always fails.
    options.disallowedTools = ["WebFetch"];
  }
  return options;
};
