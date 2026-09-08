import type { Context } from "grammy";
import type { AgentEvent, ProviderCapabilities } from "./agent/types";
import { EDIT_INTERVAL_MS, TYPING_INTERVAL_MS } from "./telegram/format";
import type { RenderPolicy } from "./telegram/render-policy";
import type { Route } from "./telegram/route";
import { threadOpts } from "./telegram/route";
import { ignoreError } from "./telegram/send";
import { dispatchEvent } from "./telegram/stream-handlers";
import {
  finalizeStream,
  flushPending,
  makeStreamCtx,
} from "./telegram/stream-state";

export type { StreamResult } from "./telegram/format";
export { splitText } from "./telegram/format";
export { sendRichMarkdown } from "./telegram/send";

export interface StreamArgs {
  branchName?: string | null;
  capabilities: ProviderCapabilities;
  ctx: Context;
  events: AsyncGenerator<AgentEvent>;
  /** Persist the session id before any later event can interrupt the run. */
  onSessionInit?: (sessionId: string) => Promise<void> | void;
  /** How much of the run reaches the chat; quiet in production, full for dev. */
  policy: RenderPolicy;
  projectName: string;
  /** Chat and forum topic every message of this run goes to. */
  route: Route;
}

/**
 * Stream agent events into Telegram messages, gated by the provider's
 * capabilities and the render policy, all inside the topic the run answers.
 */
export const streamToTelegram = async ({
  branchName,
  capabilities,
  ctx,
  events,
  onSessionInit,
  policy,
  projectName,
  route,
}: StreamArgs) => {
  const s = makeStreamCtx({ capabilities, ctx, policy, route });
  const typingOpts = threadOpts(route);

  const editTimer = setInterval(() => {
    flushPending(s).catch(ignoreError);
  }, EDIT_INTERVAL_MS);

  // The only progress signal under the quiet policy, so it runs for the whole
  // stream regardless of what is being rendered.
  const typingTimer = setInterval(() => {
    ctx.api
      .sendChatAction(route.chatId, "typing", typingOpts)
      .catch(ignoreError);
  }, TYPING_INTERVAL_MS);
  ctx.api.sendChatAction(route.chatId, "typing", typingOpts).catch(ignoreError);

  try {
    for await (const event of events) {
      if (event.kind === "session_init") {
        await onSessionInit?.(event.sessionId);
      }
      const stop = await dispatchEvent(s, event);
      if (stop) {
        break;
      }
    }
  } finally {
    // Cleared on every exit path: normal end, plan-ready break, a thrown
    // error, and interrupts — which arrive as an in-stream `error` event
    // (consumed by handleError, not thrown), so the loop still exits here.
    clearInterval(editTimer);
    clearInterval(typingTimer);
  }

  await finalizeStream(s, projectName, branchName);
  return s.result;
};
