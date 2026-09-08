import { type Context, InlineKeyboard } from "grammy";
import type { HandlerDeps, RunPipeline } from "./deps";
import {
  COMPOSE_CANCEL_RE,
  COMPOSE_SEND_RE,
  cleanupComposeStatus,
  forwardSenderName,
  mainKeyboard,
  swallow,
  updateComposeStatus,
} from "./helpers";
import { saveUploadedFile, transcribeVoiceForCompose } from "./uploads";
import {
  addComposeMessage,
  type ComposeMessage,
  clearComposeMessages,
  getState,
  MAX_COMPOSE_MESSAGES,
  startCompose,
  type UserState,
} from "./user-state";

/**
 * Compose-mode interceptor: capture non-command messages while composing.
 * Registered before the typed message handlers, so a buffered message never
 * reaches the prompt path. Media group photos pass through to the photo handler
 * for batching.
 */
export const registerComposeInterceptor = (deps: HandlerDeps) => {
  const { bot } = deps;

  /** Build a ComposeMessage from the incoming message, or undefined if unsupported */
  const buildComposeMessage = async (
    ctx: Context
  ): Promise<ComposeMessage | undefined> => {
    const message = ctx.message;
    if (!message) {
      return;
    }
    if (message.voice) {
      const content = await transcribeVoiceForCompose(
        deps.token,
        ctx,
        message.message_id
      );
      return { type: "voice", content };
    }
    if (message.document) {
      const filename = message.document.file_name ?? `file_${Date.now()}`;
      const dest = await saveUploadedFile(deps, ctx, filename);
      const caption = message.caption ?? "";
      return {
        type: "file",
        content: `[File: ${filename} saved at ${dest}]\n${caption}`.trim(),
      };
    }
    if (message.photo) {
      const largest = message.photo.at(-1);
      if (!largest) {
        return;
      }
      const filename = `photo_${Date.now()}.jpg`;
      const dest = await saveUploadedFile(deps, ctx, filename, largest.file_id);
      const caption = message.caption ?? "";
      return {
        type: "photo",
        content: `[Photo saved at ${dest}]\n${caption}`.trim(),
      };
    }
    if (message.forward_origin) {
      const text = message.text ?? message.caption ?? "";
      return {
        type: "forwarded",
        content: `[Forwarded from ${forwardSenderName(message.forward_origin)}]\n${text}`,
      };
    }
    if (message.text) {
      return { type: "text", content: message.text };
    }
    return;
  };

  /** Collect a message into compose queue based on its type */
  const collectComposeMessage = async (ctx: Context, state: UserState) => {
    const messages = state.composeMessages;
    if (!messages) {
      return;
    }
    if (messages.length >= MAX_COMPOSE_MESSAGES) {
      await ctx.reply(
        `Compose limit reached (${MAX_COMPOSE_MESSAGES} messages). Use /send to submit or /stop to clear.`
      );
      return;
    }
    try {
      const message = await buildComposeMessage(ctx);
      if (message) {
        addComposeMessage(state, message);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "unknown error";
      await ctx.reply(`Error collecting message: ${errMsg}`).catch(swallow);
      return;
    }
    await updateComposeStatus(ctx, state);
  };

  bot.on("message", async (ctx, next) => {
    const state = getState(ctx);
    if (!state.composeMessages) {
      return next();
    }
    if (ctx.message?.text?.startsWith("/")) {
      return next();
    }
    if (ctx.message?.photo && ctx.message.media_group_id) {
      return next();
    }
    await collectComposeMessage(ctx, state);
  });
};

/** /compose, /send, /cancel and the compose status-message buttons. */
export const registerComposeHandlers = (
  { bot }: HandlerDeps,
  { handlePrompt }: RunPipeline
) => {
  /** Execute send: combine composed messages and send to the active provider */
  const executeSend = async (ctx: Context, state: UserState) => {
    if (!state.composeMessages) {
      await ctx.reply("Not in compose mode.", { reply_markup: mainKeyboard });
      return;
    }
    if (state.composeMessages.length === 0) {
      clearComposeMessages(state);
      await cleanupComposeStatus(state, ctx);
      await ctx.reply("Nothing to send. Compose cancelled.", {
        reply_markup: mainKeyboard,
      });
      return;
    }
    const combined = state.composeMessages.map((m) => m.content).join("\n\n");
    clearComposeMessages(state);
    await cleanupComposeStatus(state, ctx);
    handlePrompt(ctx, combined).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  };

  /** Execute cancel: discard composed messages */
  const executeCancel = async (ctx: Context, state: UserState) => {
    if (!state.composeMessages) {
      await ctx.reply("Not in compose mode.", { reply_markup: mainKeyboard });
      return;
    }
    const count = state.composeMessages.length;
    clearComposeMessages(state);
    await cleanupComposeStatus(state, ctx);
    await ctx.reply(`Compose cancelled. ${count} message(s) discarded.`, {
      reply_markup: mainKeyboard,
    });
  };

  bot.command("compose", async (ctx) => {
    const state = getState(ctx);
    if (state.composeMessages) {
      await ctx.reply(
        `Already composing (${state.composeMessages.length} messages). /send when done.`
      );
      return;
    }
    startCompose(state);
    const keyboard = new InlineKeyboard()
      .text("Send", `compose_send:${state.userId}`)
      .text("Cancel", `compose_cancel:${state.userId}`);
    const msg = await ctx.reply(
      "Compose mode. Send messages — /send when done.",
      {
        reply_markup: keyboard,
      }
    );
    state.composeStatusMessageId = msg.message_id;
  });

  bot.command("send", async (ctx) => {
    const state = getState(ctx);
    await executeSend(ctx, state);
  });

  bot.command("cancel", async (ctx) => {
    const state = getState(ctx);
    await executeCancel(ctx, state);
  });

  bot.callbackQuery(COMPOSE_SEND_RE, async (ctx) => {
    const state = getState(ctx);
    await ctx.answerCallbackQuery();
    await executeSend(ctx, state);
  });

  bot.callbackQuery(COMPOSE_CANCEL_RE, async (ctx) => {
    const state = getState(ctx);
    await ctx.answerCallbackQuery();
    await executeCancel(ctx, state);
  });
};
