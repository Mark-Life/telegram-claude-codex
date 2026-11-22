import { Effect, Option } from "effect";
import type { Api } from "grammy";

import { logPersistenceError } from "../db/bridge";
import { runtime } from "../runtime";
import { NotifyService } from "./notify";
import type { NotifyTarget } from "./notify";
import type { Route } from "./route";
import { sendRichSafe } from "./send";
import type { SendArgs } from "./send";
import { TelegramBot } from "./telegram-bot";
import type {
  RichDraft,
  RichMessage,
  SendMessageOther,
  SendRichOther,
  UseOptions,
} from "./telegram-bot";

/**
 * The TelegramBot service as Promises, for code that is still a grammy closure
 * or a plain async loop. This is the only telegram module that crosses into
 * the runtime. A final failure has already been logged once by the service
 * (label, reason, code), so a caller neither logs it again nor reads its
 * message: it matches `error.reason`.
 *
 * - `tg` rejects with the `TelegramBotError` itself; a catch block narrows
 *   with `error instanceof TelegramBotError` and matches `error.reason`.
 * - `tgBestEffort` resolves `undefined` instead, for a call whose failure
 *   changes nothing for the user; its failure logs at debug unless told
 *   otherwise.
 */

/** The bot handle, for bootstrap code that wires grammy (`bot`, `botId`). */
export const getTelegramBot = async () => await runtime.runPromise(TelegramBot);

/** One outbound call; rejects with `TelegramBotError`. */
export const tg = async <A>(
  label: string,
  fn: (api: Api) => Promise<A>,
  opts?: UseOptions
): Promise<A> =>
  await runtime.runPromise(TelegramBot.use((bot) => bot.use(label, fn, opts)));

/** One outbound call whose failure is dropped: resolves undefined instead. */
export const tgBestEffort = async <A>(
  label: string,
  fn: (api: Api) => Promise<A>,
  opts: UseOptions = {}
): Promise<A | undefined> => {
  try {
    return await tg(label, fn, { logLevel: "debug", ...opts });
  } catch {
    // Already logged by the service with its label and reason.
    return undefined;
  }
};

/** Send text into a route, topic included; rejects with `TelegramBotError`. */
export const sendTo = async (
  route: Route,
  text: string,
  other?: SendMessageOther
) =>
  await runtime.runPromise(
    TelegramBot.use((bot) => bot.sendTo(route, text, other))
  );

/**
 * Send a notice to a target through `NotifyService`; rejects with the
 * `TelegramBotError`, `NoWorkspace` or a `PersistenceError` (logged once).
 */
export const sendNotice = async (input: {
  opts?: SendMessageOther;
  target: NotifyTarget;
  text: string;
}) =>
  await runtime.runPromise(
    NotifyService.use((notify) => notify.send(input)).pipe(
      Effect.tapErrorTag("PersistenceError", logPersistenceError)
    )
  );

/** Where a notice to `target` would go now; undefined for no workspace. */
export const noticeRoute = async (target: NotifyTarget) =>
  await runtime.runPromise(
    NotifyService.use((notify) => notify.routeOf(target)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.tapErrorTag("PersistenceError", logPersistenceError)
    )
  );

/** Send a rich message into a route, topic included; rejects on failure. */
export const sendRichTo = async (
  route: Route,
  input: RichMessage,
  other?: SendRichOther
) =>
  await runtime.runPromise(
    TelegramBot.use((bot) => bot.sendRichTo(route, input, other))
  );

/**
 * Stream a rich draft into a route; never retried, never rejects. Resolves
 * whether the draft landed.
 */
export const sendRichDraftTo = async (
  route: Route,
  draftId: number,
  input: RichDraft
): Promise<boolean> =>
  await runtime.runPromise(
    TelegramBot.use((bot) =>
      bot.sendRichDraftTo(route, draftId, input).pipe(
        // A draft is superseded by the next one; logged at debug by the service.
        Effect.orElseSucceed(() => false)
      )
    )
  );

/**
 * Persist a rich message, plain text when Telegram rejects its markup; rejects
 * with `TelegramBotError` otherwise.
 */
export const safeSendRichMessage = async (args: SendArgs) =>
  await runtime.runPromise(sendRichSafe(args));

/** Send raw markdown as a rich message (used for one-shot content like plans). */
export const sendRichMarkdown = async ({
  markdown,
  route,
}: {
  markdown: string;
  route: Route;
}) =>
  await safeSendRichMessage({ input: { markdown: markdown || "..." }, route });

export { TelegramBotError } from "./telegram-bot";
export type {
  RetryPolicy,
  TelegramBotReason,
  UseOptions,
} from "./telegram-bot";
