import { tmpdir } from "node:os";

import type {
  Options,
  Query,
  SDKUserMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";

import { claudeExecutable } from "./claude-account";
import type { FollowUps } from "./follow-ups";
import type { OwnerSettings } from "./provider-settings";
import { minimalEnv } from "./run-env";
import type { RunImage, SandboxMode } from "./types";
import { untilAborted } from "./until-aborted";

/**
 * The Claude Agent SDK, imported on first use rather than with the provider
 * registry, so a host that never runs Claude never loads it.
 */
export const loadClaudeSdk = async () =>
  await import("@anthropic-ai/claude-agent-sdk");

/** Where the CLI reads `@path` as a file: a word start, or after CJK stops. */
const MENTION_START = /(?<=^|[\s\u3002\u3001\uFF1F\uFF01])@/gu;

/** A slash at the very start, where the CLI reads a built-in command. */
const COMMAND_START = /(?<=^\s*)\//u;

/**
 * Text for a Claude prompt with a leading `/` made inert. The CLI runs a
 * leading `/name` as its own command (`/usage`, `/config`) even with no
 * tools, which reads and writes the account's config dir. A zero-width space
 * before it leaves the text as the model reads it.
 */
export const inertCommand = (text: string) =>
  text.replace(COMMAND_START, "\u200B/");

/**
 * `inertCommand` plus every `@` mention made inert. The CLI attaches the file
 * an `@path` names before any tool or permission rule applies, so a sender
 * could read any file the bot user can.
 */
export const inertPrompt = (text: string) =>
  inertCommand(text.replaceAll(MENTION_START, "\u200B@"));

/**
 * Tools no run may hold. Cron and the CLI's own plan mode duplicate the bot's
 * scheduled tasks and plan mode, nobody answers a question, and notifications
 * and cloud triggers make side effects the bot never sees. `ScheduleWakeup`
 * needs a run that stays open past its last result, so only a run that waits
 * for background work is handed it (`claudeSettings`). Names absent from
 * today's CLI are kept so a later CLI cannot add them silently.
 */
const DENIED_TOOLS = [
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "EnterPlanMode",
  "ExitPlanMode",
  "ProposeGoal",
  "PushNotification",
  "ReadNotifications",
  "RemoteTrigger",
  "ScheduleWakeup",
];

/**
 * What a run without the whole machine is also denied: background work,
 * worktrees and messages to other sessions. A worktree goes to the repo's
 * `.claude/worktrees/<name>` and writes its `.git`; outside full access the
 * view would lose it or refuse the write.
 */
const SANDBOXED_DENIED_TOOLS = [
  ...DENIED_TOOLS,
  "EnterWorktree",
  "ExitWorktree",
  "Monitor",
  "NotebookEdit",
  "ReportFindings",
  "SendMessage",
  "Workflow",
];

/**
 * The flag-level settings every Claude child shares. With `settingSources: []`
 * these are the only settings it reads: no settings-file hooks (a run that
 * waits for background work adds an SDK `Stop` callback), no claude.ai
 * connectors, no bundled skills, no remote control or artifacts. No auto
 * memory either: what the owner wants remembered lives in their workspace's
 * `AGENTS.md`, which every owner run is told inline (`inlineRules`).
 * Transcripts are kept ten years, not the CLI's 30 days: a stored session
 * outlives any idle stretch.
 */
const BASE_SETTINGS = {
  autoDreamEnabled: false,
  autoMemoryEnabled: false,
  cleanupPeriodDays: 3650,
  disableAllHooks: true,
  disableArtifact: true,
  disableBundledSkills: true,
  disableClaudeAiConnectors: true,
  disableRemoteControl: true,
} satisfies Settings;

/**
 * The settings of a child by posture. A full-access run (the owner's and an
 * executor's) gets dynamic workflows, Monitor, background work and worktrees:
 * the CLI stays up after its last result while any of them runs, then reports
 * it as one more turn of the same run, and an abort (`/stop`) kills them with
 * it. `wakeups` also hands it `ScheduleWakeup`, for a run kept open until its
 * wake-up fires. Every other posture keeps the stricter list. The owner's own
 * settings (`/settings`) go first, so nothing forced here can be overridden.
 */
const claudeSettings = ({
  owner,
  sandbox,
  wakeups,
}: {
  owner: OwnerSettings;
  sandbox: SandboxMode | undefined;
  wakeups: boolean;
}): Settings =>
  sandbox === "danger-full-access"
    ? {
        ...owner,
        ...BASE_SETTINGS,
        enableWorkflows: true,
        permissions: {
          deny: wakeups
            ? DENIED_TOOLS.filter((tool) => tool !== "ScheduleWakeup")
            : DENIED_TOOLS,
        },
      }
    : {
        ...owner,
        ...BASE_SETTINGS,
        permissions: { deny: SANDBOXED_DENIED_TOOLS },
      };

/**
 * What isolates a Claude child from the account's own setup: no user,
 * project or local settings (hooks, `.mcp.json`, `CLAUDE.md`), no MCP server
 * but the ones passed in, no skills listed (a run adds the bot's own,
 * `claudeBotSkills`). `strictMcpConfig` is never optional: without it the
 * account's claude.ai connectors load anyway. `sandbox` is the run's
 * posture; absent takes the stricter tool list. `wakeups` allows
 * `ScheduleWakeup` on full access. `owner` is the owner's settings for a
 * run; a helper turn or an idle session takes none.
 */
export const claudeIsolation = (
  sandbox?: SandboxMode,
  {
    owner = {},
    wakeups = false,
  }: { owner?: OwnerSettings; wakeups?: boolean } = {}
) =>
  ({
    pathToClaudeCodeExecutable: claudeExecutable(),
    settingSources: [],
    settings: claudeSettings({ owner, sandbox, wakeups }),
    skills: [],
    strictMcpConfig: true,
  }) satisfies Options;

/** A user turn as the CLI's stream input takes it, under the id it reports. */
const userTurn = (
  text: string,
  id: ReturnType<typeof crypto.randomUUID>,
  images: readonly RunImage[] = []
): SDKUserMessage => ({
  message: {
    content:
      images.length === 0
        ? text
        : [
            { text, type: "text" },
            ...images.map((image) => ({
              source: {
                data: image.data,
                media_type: image.mimeType,
                type: "base64" as const,
              },
              type: "image" as const,
            })),
          ],
    role: "user",
  },
  parent_tool_use_id: null,
  type: "user",
  uuid: id,
});

/**
 * A prompt that stays open for follow-ups: the first turn, then every
 * message `followUps` yields, made inert like the first. The CLI folds one
 * into the running turn at its next tool boundary, or runs it as one more
 * turn when the model had already answered. It ends when `followUps` closes.
 *
 * @yields {SDKUserMessage} the first turn, then each follow-up.
 */
export const steerablePrompt = async function* steerablePrompt(input: {
  first: string;
  firstId: ReturnType<typeof crypto.randomUUID>;
  followUps: FollowUps;
  images?: readonly RunImage[];
  inert: (text: string) => string;
}): AsyncGenerator<SDKUserMessage> {
  yield userTurn(input.first, input.firstId, input.images);
  for await (const followUp of input.followUps.listen()) {
    yield userTurn(input.inert(followUp.text), followUp.id);
  }
};

/** A prompt that never sends anything: the session runs no turn. */
const silentPrompt = (until: Promise<void>): AsyncIterable<SDKUserMessage> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => {
      await until;
      return { done: true, value: undefined };
    },
  }),
});

/**
 * Ask the CLI something about the account through a session that is opened
 * and closed unused: it answers its init and control requests, runs no turn,
 * spends no tokens and keeps no transcript. The CLI owns the login, so a
 * stale token is refreshed the way a run would refresh it. The session closes
 * when `use` settles or `signal` aborts, whichever comes first.
 */
export const withIdleSession = async <T>(input: {
  signal: AbortSignal;
  use: (session: Query) => Promise<T>;
}) => {
  const sdk = await loadClaudeSdk();
  const idle = Promise.withResolvers<undefined>();
  const session = sdk.query({
    options: {
      ...claudeIsolation(),
      cwd: tmpdir(),
      env: minimalEnv("claude"),
      persistSession: false,
      tools: [],
    },
    prompt: silentPrompt(idle.promise),
  });
  try {
    // The deadline is raced here and the session closed after it, so one
    // signal ends both the wait and the CLI.
    return await untilAborted(input.signal, input.use(session));
  } finally {
    session.close();
    idle.resolve();
  }
};
