import type { Bot, Context } from "grammy";
import type { UserState } from "./user-state";

/** Shared dependencies handed to every register*() group by createBot. */
export interface HandlerDeps {
  bot: Bot;
  /** Id of the bot itself, used to ignore its own messages in reply context. */
  botId: number;
  projectsDir: string;
  /** Bot token, needed to build Telegram file download URLs. */
  token: string;
}

/** Reads a plan file and offers the execute/modify choices. */
export type PresentPlan = (
  ctx: Context,
  state: UserState,
  result: { planPath?: string; sessionId?: string }
) => Promise<void>;

/**
 * The prompt pipeline: entry point, queue-draining runner, and manual drain.
 * The state carries the conversation it belongs to, so nothing else has to be
 * threaded through.
 */
export interface RunPipeline {
  drainQueuedMessages: (state: UserState) => Promise<void>;
  handlePrompt: (ctx: Context, prompt: string) => Promise<void>;
  runAndDrain: (
    ctx: Context,
    prompt: string,
    state: UserState
  ) => Promise<void>;
}
