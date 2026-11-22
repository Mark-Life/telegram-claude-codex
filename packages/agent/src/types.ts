import type { TaskStamp } from "@workspace/db";
import type { ModelTier } from "@workspace/env/bot";
import type { Cause, Effect, Queue } from "effect";

import type { AgentError } from "./errors";
import type { readExecutorMcpServers } from "./executor-mcp";
import type { FollowUps } from "./follow-ups";
import type { OwnerSettings } from "./provider-settings";
import type { AccountMcpEndpoint } from "./telegram-account-mcp";

/** Supported coding-agent provider identifiers */
export type ProviderId = "claude" | "codex" | "pi";

/**
 * Every provider identifier, in menu order, which is also the order the
 * detected default is picked in. The one place that enumerates providers:
 * adding a provider is a new entry here plus one in `registry.ts`.
 */
export const PROVIDER_IDS = [
  "codex",
  "claude",
  "pi",
] as const satisfies readonly ProviderId[];

/**
 * The model tiers the router picks between, weakest first; defined beside the
 * `CODEX_TIER_MODELS` parser, which is where a tier name is validated. Each
 * provider maps the tiers it offers to its own slugs.
 */
export { isModelTier, MODEL_TIERS, type ModelTier } from "@workspace/env/bot";

/**
 * The reasoning efforts the router picks between, lightest first. This is the
 * router's own scale; a provider maps it onto its own levels.
 */
export const ROUTED_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** The efforts the router picks between, lightest first. */
export type RoutedEffort = (typeof ROUTED_EFFORTS)[number];

/** Narrows a stored effort id to the router's scale; "default" and junk fall out. */
export const isRoutedEffort = (
  effort: string | undefined
): effort is RoutedEffort => ROUTED_EFFORTS.some((level) => level === effort);

/**
 * What a parked run waits on, as the CLI reported it at its last result: the
 * live background tasks, the workflows among them with what relaunches one
 * (`Workflow({scriptPath, resumeFromRunId})`), and the pending wake-up.
 */
export interface BackgroundPending {
  readonly tasks: readonly { description: string; type: string }[];
  readonly wakeup?: { prompt: string; scheduledFor: number };
  readonly workflows: readonly {
    name: string;
    runId: string;
    scriptPath: string;
  }[];
}

/**
 * Where a sub-agent or a workflow is. `pending` is queued and not started;
 * `stopped` was cut short (killed, interrupted, shut down).
 */
export type SubAgentStatus =
  | "done"
  | "failed"
  | "pending"
  | "running"
  | "stopped";

/** The statuses a sub-agent ends in. */
export type SubAgentEnd = Extract<
  SubAgentStatus,
  "done" | "failed" | "stopped"
>;

/** Whether a sub-agent's status is one it ends in. */
export const isSubAgentEnd = (status: SubAgentStatus): status is SubAgentEnd =>
  status === "done" || status === "failed" || status === "stopped";

/**
 * A provider's word for how a sub-agent ended: `completed` is done, `failed`
 * failed, anything else (killed, interrupted, shut down) stopped.
 */
export const subAgentEndOf = (status: string): SubAgentEnd => {
  if (status === "completed") {
    return "done";
  }
  return status === "failed" ? "failed" : "stopped";
};

/**
 * What a provider knows of one sub-agent at a time; every field but the id
 * is left out when it did not change or is not known. The usage counts are
 * totals so far, never increments.
 */
export interface SubAgentStats {
  /** The provider's own id: a Claude task id, a Codex thread id. */
  readonly id: string;
  /** The last tool it called, as the provider names it. */
  readonly lastTool?: string;
  readonly tokens?: number;
  readonly toolUses?: number;
  /** How long it has run, as the provider measures it. */
  readonly durationMs?: number;
}

/**
 * A sub-agent or a workflow a run started. A workflow's agents carry it as
 * their parent and the wave (the workflow's phase) they run in; an agent a
 * sub-agent spawned carries that one.
 */
export interface SubAgentStart extends SubAgentStats {
  readonly role: "agent" | "workflow";
  /** What it is doing: a task's description, a workflow's name. */
  readonly label: string;
  /** The kind of agent, such as `general-purpose` or `Explore`. */
  readonly agentType?: string;
  readonly parentId?: string;
  readonly status: Extract<SubAgentStatus, "pending" | "running">;
  /** A workflow agent's wave, 1-based. */
  readonly wave?: number;
}

/** A workflow's waves in order, as its script declares them. */
export interface WorkflowWave {
  readonly index: number;
  readonly title: string;
}

/** Normalized internal event model consumed by the Telegram layer (provider-agnostic) */
export type AgentEvent =
  /**
   * The sub-agents and workflows a run spawns, as they start, work and end.
   * The main thread's own events never include their tool calls or text.
   */
  | { kind: "agent_started"; agent: SubAgentStart }
  | {
      kind: "agent_progress";
      agent: SubAgentStats & {
        readonly status?: Extract<SubAgentStatus, "pending" | "running">;
        /** A workflow's waves, once known. */
        readonly waves?: readonly WorkflowWave[];
      };
    }
  | {
      kind: "agent_finished";
      agent: SubAgentStats & {
        readonly status: SubAgentEnd;
        /** Why it failed, in the provider's words (English). */
        readonly error?: string;
      };
    }
  | { kind: "session_init"; sessionId: string }
  /** One complete assistant message; the chat must preserve this boundary. */
  | { kind: "text_message"; text: string }
  | { kind: "tool_use"; name: string; input: string }
  | { kind: "thinking_start" }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_done"; durationMs: number }
  | { kind: "plan_ready"; planPath: string }
  /**
   * Background work a run started, once it answered: `waiting` when the
   * answer is out and the run stays open for that work's report, `working`
   * when a later turn starts, `expired` when the run stopped waiting at a cap,
   * `full` when it did not wait because no waiting slot was free.
   */
  | { kind: "background"; state: "expired" | "full" | "working" }
  /**
   * The run parked: what it waits on, and the session it waits in, so the
   * host can carry the work across its own restart.
   */
  | {
      kind: "background";
      pending: BackgroundPending;
      sessionId: string;
      state: "waiting";
    }
  /**
   * How full the session's context window is, as the provider's own CLI
   * counts it. Claude sends each request's prompt (input and cache) while a
   * run works, then the CLI's own `/context` total once the answer settles;
   * Codex the newest request's input and output. A figure with no window
   * keeps the one known before.
   */
  | {
      kind: "context";
      sessionId: string;
      usedTokens: number;
      /** The window the figure is measured against. */
      windowTokens?: number;
      /** The model's own window, when the CLI measures against a smaller one. */
      modelWindowTokens?: number;
      /** Where the CLI compacts on its own. */
      compactAt?: number;
      /**
       * Tokens the CLI leaves out of both sides of its percentage, as fixed
       * in every request.
       */
      baselineTokens?: number;
      model?: string;
    }
  | {
      kind: "result";
      text: string;
      sessionId: string;
      // Optional: only providers that actually report economics populate these.
      // Providers that never report them (e.g. Codex) leave them undefined so
      // downstream `?? null` correctly degrades to NULL instead of a fabricated 0.
      cost?: number;
      durationMs: number;
      turns?: number;
      totalTokens?: number;
    }
  // Terminal events of a compaction run (see compact.ts). They never appear in
  // a prompt run's stream, and the Telegram layer ignores them.
  | {
      kind: "compact_done";
      /** The session to continue on: the same one for a compaction in place. */
      sessionId: string;
      preTokens?: number;
      postTokens?: number;
      /**
       * What the next request carries, as the run's `context` events count
       * it, when the compaction measured it with a real request (Codex's
       * seed turn). Claude's own count right after compacting still holds
       * the summary call's input, so it reports none.
       */
      contextTokens?: number;
    }
  | { kind: "compact_failed"; reason: string }
  | { kind: "error"; message: string; class?: AgentError };

/** The terminal event of a compaction run: it either compacted, or it did not. */
export type CompactEvent = Extract<
  AgentEvent,
  { kind: "compact_done" | "compact_failed" }
>;

/** The event queue bridged from an Effect producer fiber to the AsyncGenerator consumer. */
export type EventQueue = Queue.Queue<AgentEvent, Cause.Done>;

/**
 * Identifies one run slot. A chat's forum topics are separate conversations, so
 * they run in parallel; everything outside a topic (private chat, plain group,
 * the General topic) shares the chat's single slot.
 */
export interface RunKey {
  chatId: number;
  /**
   * Where the run came from when it is not a chat or a scheduled task:
   * `api`, a run the HTTP API started. Part of the slot's identity, so an
   * API run's slot never equals a conversation's or a task fire's, whatever
   * its chat and thread say. Absent for every chat and task run.
   */
  origin?: "api";
  /** Forum topic the run belongs to; null/undefined outside a topic. */
  threadId?: number | null;
  userId: number;
}

/**
 * Sandbox postures a run can be given: the Codex SDK's three, plus `none`, no
 * local tools at all, which is narrower than `read-only`. Kept here so the
 * host can decide a posture without importing any provider's SDK.
 */
export type SandboxMode =
  | "danger-full-access"
  | "none"
  | "read-only"
  | "workspace-write";

/**
 * Privileges of one run, resolved by the host from who asked and where. It is
 * plain data so the gating matrix lives in one testable place instead of being
 * re-derived inside providers.
 */
export interface RunAccess {
  /** Name the owner-only helper scripts in the first-turn prompt. */
  adminScripts: boolean;
  /**
   * Whether the agent process inherits the bot's own environment, secrets
   * included. Absent is the closed answer — the run receives only the handful
   * of names an agent needs to start — so a profile that never states it cannot
   * print `BOT_TOKEN` or an API key out of a shell command. Only profiles
   * trusted with the helper scripts and external tools say `"inherit"`.
   */
  env?: "inherit" | "minimal";
  /** Expose account apps, plugins and MCP servers, including Executor. */
  externalTools: boolean;
  /** Whether the run gets memory tools locked to its current Telegram group. */
  groupMemory: "current" | "none";
  /**
   * Which model the run gets. `main` is the one operators pick with /model;
   * `light` is the provider's cheap, fast model at low effort, for surfaces
   * where a quick answer is enough and the main model would drain the plan.
   */
  modelClass: "light" | "main";
  /** Remember the session id so a later prompt can resume it. */
  persistSession: boolean;
  /** Low-priority runs never take the last concurrency slot; the owner's do. */
  priority: "low" | "normal";
  sandbox: SandboxMode;
  /**
   * Wire the owner's own Telegram account (read their chats, write as them).
   * True in the owner's and an executor's private chat and in a scheduled
   * task one of them wrote. A tool gate, not a security boundary: a
   * full-access run can read `.data`.
   */
  telegramAccount: boolean;
  webSearch: boolean;
  /** Which identity may load the user's workspace rules and skills. */
  workspaceMemory: "executor" | "none" | "owner";
}

/** What the owner's own runs get: the whole machine, every helper wired. */
export const OWNER_ACCESS = {
  adminScripts: true,
  env: "inherit",
  externalTools: true,
  groupMemory: "none",
  modelClass: "main",
  persistSession: true,
  priority: "normal",
  sandbox: "danger-full-access",
  telegramAccount: true,
  webSearch: true,
  workspaceMemory: "owner",
} as const satisfies RunAccess;

/** The image types every provider takes inline. */
export const RUN_IMAGE_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** One image a run sees inline: base64 bytes and their type. */
export interface RunImage {
  data: string;
  mimeType: (typeof RUN_IMAGE_TYPES)[number];
}

/**
 * What a run started from a group gets, whoever sent it: web search plus a
 * current-chat-only memory interface — no filesystem writes, account tools or
 * resumable session.
 */
export const LIGHT_ACCESS = {
  adminScripts: false,
  env: "minimal",
  externalTools: false,
  groupMemory: "current",
  modelClass: "light",
  persistSession: false,
  priority: "low",
  sandbox: "read-only",
  telegramAccount: false,
  webSearch: true,
  workspaceMemory: "none",
} as const satisfies RunAccess;

/**
 * Who the bot is in a run: the name it answers to, the grammatical gender it
 * uses for itself, and whose assistant it is. The host reads it from the
 * owner's settings; unset owner name means the run names no owner.
 */
export interface RunPersona {
  readonly callName: string;
  readonly gender: "female" | "male";
  readonly ownerName: string | undefined;
}

/** Options passed to a provider run, normalized across providers */
export interface RunOptions extends RunKey {
  /**
   * Privileges of this run; every caller states them, so nothing defaults
   * open. A provider reads them narrowed to what it can enforce and wire
   * (`narrowAccess`, applied by `runAgent`).
   */
  access: RunAccess;
  /**
   * The access the host granted, before `runAgent` narrowed it. Only the task
   * author stamp reads it; absent means `access`.
   */
  grantedAccess?: RunAccess;
  /** Reasoning effort; absent leaves the provider default in place. */
  effort?: string;
  /**
   * Whether the run may stay open past its last answer while work it started
   * in the background (a wake-up, a Monitor, a background command or
   * workflow) is pending, and run that work's report as one more turn. A
   * conversation run or a prompt-task fire sets it; Claude honours it on full
   * access only, and keeps the session of a run that waits.
   */
  waitForBackground?: boolean;
  /** Model slug; absent leaves the provider default in place. */
  model?: string;
  /**
   * Who the bot is. Every caller states it, so a sandboxed group run speaks of
   * itself in the same name and gender as an owner run.
   */
  persona: RunPersona;
  /**
   * What a `light` run is pinned to instead of the provider's own
   * `lightPick`, in the router's terms so it holds on any provider: the
   * owner's choice in `/settings`. A half left out keeps the light pick's;
   * ignored on a `main` run.
   */
  lightChoice?: {
    effort?: RoutedEffort;
    /** A model picked by name, per provider: it wins over the tier there. */
    models?: Partial<Record<ProviderId, string>>;
    tier?: ModelTier;
  };
  /**
   * Photos the run sees in its first message, beside `prompt`: for a run
   * that has no tool to open a file, the bot reads them outside the sandbox
   * and hands over the bytes, never a path or a URL.
   */
  images?: readonly RunImage[];
  projectDir: string;
  prompt: string;
  sessionId?: string;
  /**
   * Who the run works for. A task it writes through the tasks CLI is stamped
   * with it, and an account write names it in the confirmation. Used only
   * when the granted access holds the owner's account; absent stamps
   * `executor` with no id and wires no account tools.
   */
  taskAuthor?: TaskStamp;
}

/**
 * Config the host resolves inside Effect before a run starts and hands to the
 * provider as plain data, so provider bodies do no config lookups of their own.
 */
export interface RunContext {
  /**
   * Messages the user sends while the run works. A provider that can fold
   * them into its running turn listens; one that cannot leaves them be, and
   * they queue for the next run.
   */
  followUps: FollowUps;
  /**
   * Move the run from a working slot to one for runs waiting on background
   * work, freeing the working one for good: its later turns run on the
   * waiting slot. False when none is free. Called again once moved, it holds.
   */
  waitSlot: () => boolean;
  /** MCP servers to expose to the run; undefined when none is configured. */
  mcpServers: Effect.Success<typeof readExecutorMcpServers>;
  /**
   * The owner's settings for this run's provider (`/settings`), read when it
   * starts. The provider merges them under what it forces, never over.
   */
  ownerSettings: OwnerSettings;
  /**
   * The owner's Telegram account server; set only when the run's access
   * allows it and the account is logged in.
   */
  telegramAccount?: AccountMcpEndpoint;
}

/**
 * The model id that means "no manual choice": the thread is routed instead.
 * It is never handed to a provider — the router resolves it to a real slug
 * first — so it can only appear in a chat menu or a stored thread pick.
 */
export const AUTO_MODEL = "auto";

/**
 * The stored model that means "leave the CLI's default in place": a pick for a
 * provider that names no default slug of its own. Never handed to a CLI.
 */
export const DEFAULT_MODEL = "default";

/**
 * A selectable option (model or reasoning effort). `id` `"auto"` clears any
 * override. `label` is a name, not copy: the chat names the router's efforts
 * and what each tier is good for in its own language.
 */
export interface Choice {
  id: string;
  label: string;
  /** The tier this model serves; absent for any other entry. */
  tier?: ModelTier;
}

/** Feature flags describing what a provider supports, as the chat shows it */
export interface ProviderCapabilities {
  /** Session compaction (`/compact`); true iff the provider has `compact`. */
  compaction: boolean;
  cost: boolean;
  planMode: boolean;
  thinking: boolean;
}

/**
 * What a provider can enforce and wire on this host, as data: a caller checks
 * a flag, never a provider id. Part of `AgentProvider.capabilities`.
 */
export interface ProviderWiring {
  /** Whether a new conversation on it may be routed by the model router. */
  autoModel: boolean;
  /** Account apps, plugins and MCP servers, Executor included, can be wired. */
  externalTools: boolean;
  /** The chat-scoped `group_memory` stdio MCP server can be wired. */
  groupMemory: boolean;
  /** The sandbox postures it can enforce for a run. */
  postures: readonly SandboxMode[];
  /**
   * Whether a run inside the bwrap view (`sandbox/bwrap.ts`) can keep and
   * resume its session. False narrows such a run to a throwaway session.
   */
  sessionsInView: boolean;
  /** The owner's `telegram_account` MCP server can be wired. */
  telegramAccount: boolean;
}

/**
 * Whether this host can run a provider: its CLI is there and logged in
 * (`ready`), there is no CLI (`missing`), it is there with no account
 * (`logged_out`), it is installed but no binary a run could spawn starts on
 * this host (`unsupported`), or the check did not answer in time (`unknown`).
 */
export type ProviderAvailability =
  | "logged_out"
  | "missing"
  | "ready"
  | "unknown"
  | "unsupported";

/**
 * One rolling window of a subscription's allowance, as the provider's own
 * CLI reports it. `minutes` is how long the window is (300 for five hours,
 * 10080 for a week), absent when the provider does not say; `scope` names a
 * window that covers one model or feature rather than the whole account.
 */
export interface UsageWindow {
  minutes?: number;
  /** Unix milliseconds the window starts over, absent when not reported. */
  resetsAt?: number;
  scope?: string;
  /** How much of the window is spent, 0–100. */
  usedPercent: number;
}

/**
 * A subscription's allowance right now. `windows` is empty when the login
 * has no plan limits to report (an API key); `limitReached` is a limit the
 * provider reports as reached — a window of the plan, a workspace's cap or
 * credits — until it starts over or is topped up. Paid usage credits, where
 * the account has them, may still carry runs.
 */
export interface ProviderUsage {
  limitReached: boolean;
  /** The plan's name as the chat shows it (`Plus`, `Max`); absent when unknown. */
  plan?: string;
  windows: readonly UsageWindow[];
}

/** A login process the bot started and the owner finishes on another device. */
export interface LoginProcess {
  /** Exit code once the owner approved, failed or the process was killed. */
  exited: Promise<number>;
  kill: () => void;
  /** What the CLI prints: the link and the code the owner needs. */
  stdout: ReadableStream<Uint8Array> | undefined;
}

/**
 * A provider's account login from the phone: a device flow that prints a link
 * and a code, then exits once the owner approved it in a browser. `bin` is
 * the provider's CLI as the host resolved it at boot.
 */
export interface DeviceLogin {
  /** The CLI's own status check; exit code 0 means the account is connected. */
  status: (bin: string) => Promise<{ exitCode: number; output: string }>;
  /** Start the device flow; throws when the CLI cannot be spawned. */
  start: (bin: string) => LoginProcess;
}

/**
 * One throwaway turn the bot asks itself — format a result, judge an address,
 * name a topic: text in, final text out, no tools, no session, on the
 * provider's cheapest model unless `model` names another, in a read-only
 * working directory.
 */
export interface OneTurnRequest {
  /** Reasoning effort, when the caller wants one; absent keeps the model's own. */
  effort?: RoutedEffort;
  /** How the turn registry files it. */
  kind: "format" | "side_turn";
  /** Finer name within the kind, as the turn registry and the ledger name it. */
  label: string;
  /** Model slug, when the owner picked one; absent keeps the light model. */
  model?: string;
  /**
   * The depth the owner set for this helper pass, also in `effort`. Only pi
   * reads it: its thinking stays off unless the owner asked, while the low
   * `effort` a pass sends by default is what Codex and Claude already ran.
   */
  ownEffort?: RoutedEffort;
  prompt: string;
  /** Cancels the turn; a helper's timeout rides here. */
  signal?: AbortSignal;
  /** Directory the turn runs in; read-only, never the bot repo. */
  workingDirectory: string;
}

/**
 * What a helper turn is told instead of its provider's own instructions, so
 * a one-line task carries none of the owner's workspace context.
 */
export const HELPER_INSTRUCTIONS =
  "You answer one request from a program. Reply with the answer text only. You have no tools.";

/** Run one throwaway turn and answer its final text; rejects on any failure. */
export type OneTurn = (request: OneTurnRequest) => Promise<string>;

/**
 * The helper passes a `oneTurn` can serve: the script-task format pass, topic
 * titles and the address judge's fallback. Each provider lists the ones it
 * serves.
 */
export const ONE_TURN_USES = ["format", "judge", "title"] as const;

/** One kind of helper pass. */
export type OneTurnUse = (typeof ONE_TURN_USES)[number];

/**
 * What a helper pass runs on: a provider, undefined when none serves it, and
 * the owner's model slug and depth on it; each absent keeps the pass's own.
 */
export interface HelperPick {
  effort?: RoutedEffort;
  helper: ProviderId | undefined;
  model?: string;
}

/** A `OneTurn` whose kind and label its caller already fixed. */
export type HelperTurn = (
  request: Omit<OneTurnRequest, "kind" | "label">
) => Promise<string>;

/**
 * A session a provider kept in its own files before the bot recorded its
 * history: the directory it worked in, the request its first turn carried
 * (the run's own blocks dropped) and its times in epoch milliseconds.
 */
export interface PastSession {
  lastActiveAt: number;
  projectPath: string;
  request: string;
  sessionId: string;
  startedAt: number;
}

/**
 * Minimal contract the generic runner needs to run a provider: the provider owns
 * its own subprocess and yields normalized events, and `signal` is how the run
 * is cancelled. A provider that is a bare binary would be wrapped into this
 * shape rather than given a second one.
 */
export interface ProviderSpec {
  id: ProviderId;
  run: (
    opts: RunOptions,
    ctx: RunContext,
    signal: AbortSignal
  ) => AsyncGenerator<AgentEvent, void, unknown>;
}

/** Full provider definition: spec plus capabilities and session history access */
export type AgentProvider = ProviderSpec & {
  /**
   * Whether this host can run it, given its CLI as the host resolved it.
   * Never rejects: `bin` that cannot be spawned is `missing`; a run binary
   * other than `bin` that cannot be spawned is `unsupported`. `signal` ends a
   * check that hangs; the host then reads `unknown`.
   */
  availability: (
    bin: string,
    signal?: AbortSignal
  ) => Promise<ProviderAvailability>;
  capabilities: ProviderCapabilities & ProviderWiring;
  /** The CLI's bare name, as PATH and an install instruction name it. */
  command: string;
  /**
   * Where a user-scoped install of the CLI lands, relative to the home
   * directory, highest priority first. Searched after PATH, because a
   * systemd unit does not get the PATH a shell rc file builds.
   */
  homeBinDirs: readonly string[];
  /** In-chat account login; absent when the provider is logged in from a shell. */
  deviceLogin?: DeviceLogin;
  /** The provider's own effort id for a routed effort on `model`. */
  mapEffort: (routed: RoutedEffort, model: string | undefined) => string;
  /**
   * What every `light` run is pinned to, whatever /model and /effort say;
   * `runAgent` applies it before the provider sees the run.
   */
  lightPick: () => { effort?: string; model?: string };
  /**
   * Refresh a live model list in the background when the cached one is older
   * than `maxAgeMs`; never rejects. Absent when the list is fixed data.
   */
  refreshModels?: (input: { maxAgeMs: number }) => Promise<void>;
  /** Helper passes; absent when the provider cannot run a cheap single turn. */
  oneTurn?: OneTurn;
  /** Which helper passes `oneTurn` may serve; empty without one. */
  oneTurnUses: readonly OneTurnUse[];
  /** Where the provider keeps its own auth and config on this host. */
  stateRoots: readonly string[];
  /**
   * Summarize `opts.sessionId` and hand back the session to continue on. Same
   * shape as a run — one run, one terminal `compact_done`/`compact_failed`
   * event — so the generic runner drives it unchanged. Absent when
   * `capabilities.compaction` is false.
   */
  compact?: ProviderSpec["run"];
  displayName: string;
  /** Selectable models; first entry is the `AUTO_MODEL` sentinel (no override). */
  models: () => readonly Choice[];
  /**
   * The provider's own slug for each routed tier. A tier this account does not
   * offer is simply absent, and `tierModel` clamps a pick to the nearest tier
   * that is present — the router never names a model the account cannot run.
   */
  tierModels: () => Partial<Record<ModelTier, string>>;
  /** The model a run gets with no pick; undefined leaves the CLI's own. */
  defaultModel: () => string | undefined;
  /**
   * A stored model slug as this provider can still run it: kept when it is
   * one of its own, else undefined, which means `defaultModel`.
   */
  resolveStored: (model: string) => string | undefined;
  /** Selectable reasoning-effort levels (no sentinel; the default is marked via `defaultEffort`). */
  effortLevels: Choice[];
  /**
   * The levels `model` itself takes, when they differ per model; empty when
   * it has no setting at all. Absent means `effortLevels` for every model.
   */
  effortLevelsFor?: (model: string | undefined) => readonly Choice[];
  /** The effort id used when the user has made no selection. */
  defaultEffort: string;
  /**
   * The newest `limit` sessions the bot's own main runs left in the
   * provider's files, newest first; read once per provider to seed
   * `/history`. Resolves undefined when those files cannot be read yet, so
   * the import tries again at the next boot. Absent when the provider cannot
   * tell the bot's sessions from anyone else's.
   */
  pastSessions?: (limit: number) => Promise<readonly PastSession[] | undefined>;
  /**
   * The account's allowance, asked of the provider's own CLI so the bot
   * never holds its token, given the CLI as the host resolved it. Never
   * rejects: resolves undefined when the CLI could not tell, and `signal`
   * ends a read that hangs. Absent when the provider cannot report one.
   */
  usage?: (
    bin: string,
    signal: AbortSignal
  ) => Promise<ProviderUsage | undefined>;
};
