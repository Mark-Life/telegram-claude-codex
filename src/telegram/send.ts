import { Effect } from "effect";
import type { Context } from "grammy";
import { runtime } from "../runtime";
import type { Route } from "./route";
import { threadOpts } from "./route";

/** A rich message body: model text as raw markdown, or bot chrome as Telegram HTML */
export type RichInput = { markdown: string } | { html: string };

/** Everything a send needs: who to send through, and which chat/topic it lands in. */
export interface SendArgs {
  ctx: Context;
  input: RichInput;
  /** Plain-text fallback used when the rich send fails. */
  plain?: string;
  route: Route;
}

/** No-op rejection handler: transient Telegram draft/typing errors are non-fatal and safe to drop. */
export const ignoreError = () => {
  /* dropped draft/typing updates are harmless */
};

/**
 * Wrap a fire-and-forget Telegram send/edit so a rejection is swallowed but
 * still surfaces at debug level (annotated with the call-site label + error
 * class). Used only for high-signal sites where a rejection means a real
 * Telegram outage/rate-limit — not the silent UI cleanups (typing/draft flush).
 */
export const bestEffort =
  (label: string) =>
  <T>(p: Promise<T>): Promise<T | undefined> =>
    p.catch((e) => {
      runtime
        .runPromise(
          Effect.logDebug(`${label} failed`).pipe(
            Effect.annotateLogs({
              errorClass: (e as Error)?.name ?? "unknown",
              label,
            })
          )
        )
        .catch(ignoreError);
      return undefined;
    });

/** Stream a partial rich message into a chat/topic. Swallows transient draft errors (drafts are ephemeral). */
export const safeSendRichDraft = async ({
  ctx,
  draftId,
  input,
  route,
}: Omit<SendArgs, "plain"> & { draftId: number }) => {
  await bestEffort("sendRichMessageDraft")(
    ctx.api.sendRichMessageDraft(
      route.chatId,
      draftId,
      input,
      threadOpts(route)
    )
  );
};

/** Persist a rich message in a chat/topic. Falls back to plain text on failure. */
export const safeSendRichMessage = async ({
  ctx,
  input,
  plain,
  route,
}: SendArgs) => {
  const opts = threadOpts(route);
  const sent = await bestEffort("sendRichMessage")(
    ctx.api.sendRichMessage(route.chatId, input, opts)
  );
  if (sent) {
    return sent;
  }
  const fallback = plain ?? ("markdown" in input ? input.markdown : input.html);
  return await ctx.api.sendMessage(route.chatId, fallback || "...", opts);
};

/** Send raw markdown as a rich message (used for one-shot content like plans). */
export const sendRichMarkdown = ({
  ctx,
  markdown,
  route,
}: Omit<SendArgs, "input" | "plain"> & { markdown: string }) =>
  safeSendRichMessage({ ctx, input: { markdown: markdown || "..." }, route });
