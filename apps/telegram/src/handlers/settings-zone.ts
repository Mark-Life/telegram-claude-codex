import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";

import type { BotContext } from "../access/context";
import { t } from "../i18n";
import { resolveZone } from "../reminders/zone";
import { tgBestEffort } from "../telegram/bridge";
import { logRejection } from "./helpers";
import { TZ_CANCEL } from "./settings-menu";

/**
 * The time zone row of `/settings`: a press asks for the zone, and the
 * owner's next text message in that chat and topic is the answer. One answer
 * closes the question: a zone boot would refuse gets an error and leaves the
 * value. A text that cannot be a zone (a sentence, several lines) is not
 * taken: the question closes and the text goes on to the run as usual. A
 * command, the Cancel button or ten minutes of silence close it too.
 */

const WAIT_MINUTES = 10;
const MINUTE_MS = 60_000;
const WAIT_MS = WAIT_MINUTES * MINUTE_MS;
/** The longest text taken as a zone answer; the error repeats it back. */
const ECHO_LIMIT = 64;
/** The most words a zone or a city name takes, as in "Port of Spain". */
const ZONE_WORDS = 3;

interface ZoneQuestion {
  readonly chatId: number;
  /** The menu to redraw once the zone is stored. */
  readonly menuId: number;
  readonly promptId: number;
  /** The topic the menu is in; a text from another topic is not an answer. */
  readonly threadId: number | undefined;
  readonly until: number;
}

const isCommand = (text: string | undefined) => text?.startsWith("/") ?? false;

/** Whether a text could be meant as a zone at all, right or wrong. */
const looksLikeZone = (text: string) => {
  const trimmed = text.trim();
  return (
    trimmed.length <= ECHO_LIMIT &&
    !trimmed.includes("\n") &&
    trimmed.split(/\s+/u).length <= ZONE_WORDS
  );
};

/** Take the Cancel button off the question, best effort. */
const closePrompt = async (question: ZoneQuestion, text?: string) => {
  await tgBestEffort(
    text === undefined ? "editMessageReplyMarkup" : "editMessageText",
    async (api) =>
      text === undefined
        ? await api.editMessageReplyMarkup(question.chatId, question.promptId, {
            reply_markup: undefined,
          })
        : await api.editMessageText(question.chatId, question.promptId, text),
    { retry: false }
  );
};

export const registerZoneInput = (input: {
  bot: Bot<BotContext>;
  isOwner: (ctx: BotContext) => boolean;
  readZone: () => Promise<string>;
  redraw: (target: { chatId: number; messageId: number }) => Promise<void>;
  /** Store a zone `resolveZone` returned; the next read sees it. */
  writeZone: (zone: string) => Promise<void>;
}) => {
  /** The one open question: the owner has one menu to answer from. */
  let open: ZoneQuestion | undefined;

  const ask = async (
    ctx: BotContext,
    menu: { chatId: number; menuId: number; threadId: number | undefined }
  ) => {
    const current = await input.readZone();
    // `ctx.reply` lands in the menu's topic on its own.
    const sent = await ctx.reply(t().settings.timeZone.ask(current), {
      reply_markup: new InlineKeyboard().text(
        t().cancel,
        `settings:default_tz:${TZ_CANCEL}`
      ),
    });
    open = {
      chatId: menu.chatId,
      menuId: menu.menuId,
      promptId: sent.message_id,
      threadId: menu.threadId,
      until: Date.now() + WAIT_MS,
    };
  };

  const cancel = async (chatId: number | undefined) => {
    const question = open;
    if (question === undefined || question.chatId !== chatId) {
      return;
    }
    open = undefined;
    await closePrompt(question, t().settings.timeZone.cancelled);
  };

  /**
   * Whether this update answers the open question. A command, or a text that
   * cannot be a zone, closes it and goes on to its own handler: the owner
   * moved on.
   */
  const answers = (ctx: BotContext) => {
    const question = open;
    if (
      question === undefined ||
      ctx.chat?.id !== question.chatId ||
      ctx.message?.message_thread_id !== question.threadId ||
      !input.isOwner(ctx)
    ) {
      return false;
    }
    const text = ctx.message?.text;
    if (Date.now() > question.until || isCommand(text)) {
      open = undefined;
      return false;
    }
    if (text !== undefined && !looksLikeZone(text)) {
      open = undefined;
      closePrompt(question, t().settings.timeZone.cancelled).catch(
        logRejection("Time zone prompt close failed")
      );
      return false;
    }
    return true;
  };

  input.bot.filter(answers).on("message:text", async (ctx) => {
    const question = open;
    if (question === undefined) {
      return;
    }
    open = undefined;
    const typed = ctx.message.text;
    await closePrompt(question);
    const zone = resolveZone(typed);
    if (zone === undefined) {
      await ctx.reply(t().settings.timeZone.bad(typed.trim()));
      return;
    }
    try {
      await input.writeZone(zone);
    } catch (error) {
      logRejection("Time zone write failed")(error);
      await ctx.reply(t().settings.writeFailed);
      return;
    }
    await ctx.reply(t().settings.timeZone.set(zone));
    await input.redraw({ chatId: question.chatId, messageId: question.menuId });
  });

  return { ask, cancel };
};
