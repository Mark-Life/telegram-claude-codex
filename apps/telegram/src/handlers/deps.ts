import type { RouteInput } from "@workspace/agent";
import type { ProviderId, RunImage } from "@workspace/agent/types";
import type { Bot } from "grammy";

import type { AccessInfo, BotContext } from "../access/context";
import type { PendingWork } from "../pending-work";
import type { StreamResult } from "../telegram/format";
import type { Route } from "../telegram/route";
import type { UserState } from "./user-state";

/** Shared dependencies handed to every register*() group by createBot. */
export interface HandlerDeps {
  bot: Bot<BotContext>;
  botId: number;
  /**
   * `DEFAULT_TZ`: the home zone while the owner has set none in `/settings`.
   * Read the zone in force through `readHomeTz`.
   */
  defaultTz: string;
  /** `ALLOWED_USER_ID`: the immutable root tier, and the only user manager. */
  ownerId: number;
  pendingWork: PendingWork["Service"];
  projectsDir: string;
  token: string;
}

/** Reads a plan file and offers the execute/modify choices. */
export type PresentPlan = (
  ctx: BotContext,
  state: UserState,
  result: { planPath?: string; provider: ProviderId; sessionId?: string }
) => Promise<void>;

/**
 * What the model router reads, when the caller knows more than the assembled
 * prompt does. The prompt carries the reply quote, the group excerpt and the
 * reminder block; the router wants the human's own message on its own, so a
 * handler that has it passes it here. Absent, the whole prompt is the message.
 */
export interface PromptRouting extends RouteInput {
  /**
   * Photos the run sees inline, for a conversation that cannot open files.
   * They travel with the prompt through the queue; the router never reads
   * them. A group run never steers, so they always start a run of their own.
   */
  images?: readonly RunImage[];
  /**
   * Route this run but store no pick for the conversation: an upload with no
   * caption says nothing of the work, so the words that follow it decide.
   */
  provisional?: boolean;
}

/**
 * How a run that `RunOrigin.onDone` reports on ended: `refused` before it
 * started, which the chat was already told; else the provider it ran on and
 * how its render ended, no result when it failed to start or was cut off
 * before it rendered.
 */
export type RunDone =
  | { refused: true }
  | { provider?: ProviderId; result?: StreamResult };

/**
 * Who a run answers and where: the update that asked for it, or the bot
 * itself resuming a conversation after a restart, which has no update.
 */
export interface RunOrigin {
  access: AccessInfo;
  /** How many restarts in a row this run continues; 0 for the user's own. */
  continuation: number;
  /** The update behind the run; absent for a resume. */
  ctx?: BotContext;
  /** Called once the run first parks on background work, or ends. */
  onSettle?: () => void;
  /** Called exactly once, when the run ends or is refused before it starts. */
  onDone?: (done: RunDone) => void;
  /** Says one sentence in the run's chat and topic. */
  reply: (text: string) => Promise<void>;
  route: Route;
}

/** The prompt pipeline: entry point plus the queue-draining runner. */
export interface RunPipeline {
  handlePrompt: (
    ctx: BotContext,
    prompt: string,
    routing?: PromptRouting
  ) => Promise<void>;
  /** Start a run with no update behind it; false when one already runs. */
  resume: (origin: RunOrigin, prompt: string, state: UserState) => boolean;
  runAndDrain: (
    ctx: BotContext,
    prompt: string,
    state: UserState,
    routing?: PromptRouting
  ) => Promise<void>;
}
