import { apiKeyHint, isApiKeyName, TOKEN_MESSAGE_MINUTES } from "@workspace/db";
import type { ApiKeyEntry } from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import { Option, Redacted, Result } from "effect";
import { InlineKeyboard } from "grammy";

import { syncAccessSnapshot } from "../access/audit";
import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { canHoldApiKey } from "../access/tier";
import { recordApiEvent } from "../api/ledger";
import type { ApiEventInput } from "../api/ledger";
import {
  issueApiKey,
  listApiKeys,
  noteApiTokenMessage,
  revokeApiKey,
} from "../db/bridge";
import { t } from "../i18n";
import { readHomeTz } from "../reminders/home-tz";
import { stopApiRunsOfKey } from "../runs/api-run-stops";
import { runtime } from "../runtime";
import { sendTo, tgBestEffort } from "../telegram/bridge";
import type { HandlerDeps } from "./deps";
import { escapeHtml, logRejection } from "./helpers";

/**
 * `/apikeys`: the owner's and an executor's HTTP API keys, private chat only.
 * Create asks for a name and sends the token once, in a message the bot
 * deletes after `TOKEN_MESSAGE_MINUTES`; List shows each live key with a
 * Revoke button (the owner sees everyone's). Every press re-reads the tier,
 * and `ApiKeyService` checks it again, so a demoted executor makes nothing.
 */

export const APIKEYS_RE =
  /^apikeys:(?<verb>new|list|revoke)(?::(?<id>[a-z2-7]+))?$/u;

const MINUTE_MS = 60_000;
const WAIT_MINUTES = 10;
const WAIT_MS = WAIT_MINUTES * MINUTE_MS;

interface NameQuestion {
  readonly promptId: number;
  readonly until: number;
}

const isPrivate = (ctx: BotContext) => ctx.chat?.type === "private";

/** Where the API is served, or undefined while it is off. */
const apiUrl = async () => {
  const { api } = await runtime.runPromise(AppConfig);
  return Option.getOrUndefined(
    Option.map(api, ({ port, publicUrl }) =>
      Option.getOrElse(publicUrl, () => `http://127.0.0.1:${port}`)
    )
  );
};

/** One ledger line; best effort, as every ledger write. */
const record = async (event: ApiEventInput) => {
  try {
    await runtime.runPromise(recordApiEvent(event));
  } catch {
    // swallow: the ledger must never break a command
  }
};

/** Whether the update comes from someone who may hold keys. */
const mayHold = (ctx: BotContext) => canHoldApiKey(accessOf(ctx).tier);

/** Create and List; the owner's List shows everyone's keys. */
const menu = (owner: boolean) =>
  new InlineKeyboard()
    .text(t().apiKeys.create, "apikeys:new")
    .text(owner ? t().apiKeys.listAll : t().apiKeys.list, "apikeys:list");

/** A date as the list shows it, in the home zone. */
const formatTime = (millis: number, timeZone: string) =>
  new Date(millis).toLocaleString(t().dateLocale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });

/** One key in the list; the holder is named only for someone else's. */
const describeKey = (key: ApiKeyEntry, viewerId: number, timeZone: string) =>
  t().apiKeys.entry({
    created: formatTime(key.createdAt, timeZone),
    hint: apiKeyHint(key.id),
    holder: key.userId === viewerId ? undefined : key.userId,
    lastUsed:
      key.lastUsedAt === undefined
        ? undefined
        : formatTime(key.lastUsedAt, timeZone),
    name: escapeHtml(key.name),
  });

export const registerApiKeyHandlers = ({
  bot,
  defaultTz,
  ownerId,
}: HandlerDeps) => {
  /** The open name question per user; their private chat is their id. */
  const questions = new Map<number, NameQuestion>();

  const sendList = async (ctx: BotContext, viewerId: number) => {
    const keys = await listApiKeys({ ownerId, viewerId });
    if (keys.length === 0) {
      await ctx.reply(t().apiKeys.empty);
      return;
    }
    const timeZone = await readHomeTz(defaultTz);
    for (const key of keys) {
      // oxlint-disable-next-line no-await-in-loop -- one message per key, in list order
      await ctx.reply(describeKey(key, viewerId, timeZone), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text(
          t().apiKeys.revoke,
          `apikeys:revoke:${key.id}`
        ),
      });
    }
  };

  /** Issue a key named `name` to the sender and send its token once. */
  const create = async (ctx: BotContext, holderId: number, name: string) => {
    const issued = await issueApiKey({
      createdBy: holderId,
      holderId,
      name,
      ownerId,
      via: "telegram",
    });
    if (Result.isFailure(issued)) {
      await ctx.reply(
        issued.failure.reason === "name"
          ? t().apiKeys.badName
          : t().apiKeys.notForYou
      );
      return;
    }
    const { key, tier, token } = issued.success;
    try {
      const sent = await ctx.reply(
        t().apiKeys.created({
          minutes: TOKEN_MESSAGE_MINUTES,
          name: escapeHtml(key.name),
          token: Redacted.value(token),
        }),
        { parse_mode: "HTML" }
      );
      await noteApiTokenMessage({
        chatId: sent.chat.id,
        id: key.id,
        messageId: sent.message_id,
      });
    } catch (error) {
      // The secret exists nowhere else: a key nobody can read is revoked,
      // as the CLI does. The caller logs and answers `failed`.
      await revokeApiKey({ keyId: key.id, ownerId, viewerId: holderId });
      throw error;
    }
    await ctx.reply(t().apiKeys.createdNote(key.name));
    // The bot's own write is the access watcher's new baseline.
    await syncAccessSnapshot();
    await record({
      action: "key_issue",
      actor: "telegram",
      byUserId: holderId,
      holderId,
      keyId: key.id,
      op: null,
      status: null,
    });
    if (tier === "executor") {
      await sendTo(
        { chatId: ownerId, threadId: null },
        t().apiKeys.executorIssued({ name: key.name, userId: holderId })
      ).catch(logRejection("Failed to tell the owner about a new API key"));
    }
  };

  bot.command("apikeys", async (ctx) => {
    if (!mayHold(ctx)) {
      await ctx.reply(t().notForYou);
      return;
    }
    if (!isPrivate(ctx)) {
      await ctx.reply(t().apiKeys.privateOnly);
      return;
    }
    const { tier } = accessOf(ctx);
    await ctx.reply(
      t().apiKeys.intro({
        executor: tier === "executor",
        url: await apiUrl(),
      }),
      {
        link_preview_options: { is_disabled: true },
        parse_mode: "HTML",
        reply_markup: menu(tier === "owner"),
      }
    );
  });

  bot.callbackQuery(APIKEYS_RE, async (ctx) => {
    const userId = ctx.from.id;
    if (!(mayHold(ctx) && isPrivate(ctx))) {
      await ctx.answerCallbackQuery({ text: t().apiKeys.notForYou });
      return;
    }
    const [, verb, id] = ctx.match;
    await ctx.answerCallbackQuery();
    if (verb === "new") {
      const prompt = await ctx.reply(t().apiKeys.askName);
      questions.set(userId, {
        promptId: prompt.message_id,
        until: Date.now() + WAIT_MS,
      });
      return;
    }
    if (verb === "list") {
      await sendList(ctx, userId);
      return;
    }
    const revoked =
      id === undefined
        ? undefined
        : await revokeApiKey({ keyId: id, ownerId, viewerId: userId });
    if (revoked === undefined) {
      await ctx.editMessageText(t().apiKeys.notFound);
      return;
    }
    await stopApiRunsOfKey(revoked.id);
    await syncAccessSnapshot();
    await record({
      action: "key_revoke",
      actor: "telegram",
      byUserId: userId,
      holderId: revoked.userId,
      keyId: revoked.id,
      op: null,
      status: null,
    });
    await ctx.editMessageText(t().apiKeys.revoked(escapeHtml(revoked.name)), {
      parse_mode: "HTML",
    });
  });

  /**
   * Whether this update answers an open name question. A command, a text of
   * several lines or a long one closes the question and goes on to its own
   * handler: the person moved on.
   */
  const answers = (ctx: BotContext) => {
    const userId = ctx.from?.id;
    const question = userId === undefined ? undefined : questions.get(userId);
    if (userId === undefined || question === undefined || !isPrivate(ctx)) {
      return false;
    }
    const text = ctx.message?.text;
    if (text === undefined) {
      return false;
    }
    const name = text.trim();
    if (
      Date.now() > question.until ||
      name.startsWith("/") ||
      // Not a name (too long, several lines): a normal message after all.
      !isApiKeyName(name)
    ) {
      questions.delete(userId);
      tgBestEffort(
        "editMessageText",
        async (api) =>
          await api.editMessageText(
            userId,
            question.promptId,
            t().apiKeys.cancelled
          ),
        { retry: false }
      ).catch(logRejection("API key prompt close failed"));
      return false;
    }
    return true;
  };

  bot.filter(answers).on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    if (!questions.delete(userId)) {
      return;
    }
    if (!mayHold(ctx)) {
      await ctx.reply(t().apiKeys.notForYou);
      return;
    }
    try {
      await create(ctx, userId, ctx.message.text);
    } catch (error) {
      logRejection("API key not issued")(error);
      await ctx.reply(t().apiKeys.failed);
    }
  });
};
