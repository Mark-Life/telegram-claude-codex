import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";

import { accessOf } from "../access/context";
import { t } from "../i18n";
import { logError } from "../log";
import type { HandlerDeps, PromptRouting, RunPipeline } from "./deps";
import {
  COMPOSE_CANCEL_RE,
  COMPOSE_SEND_RE,
  forwardSenderName,
  getUserId,
  logRejection,
  removedKeyboard,
  swallow,
} from "./helpers";
import { transcribeVoiceNote } from "./messages";
import { chargePrivateRun } from "./private-quota";
import { cleanupComposeStatus, updateComposeStatus } from "./status";
import { titleImplicitTopic } from "./topic-titles";
import {
  assertWithinUploadCap,
  describeSavedUpload,
  saveRepliedAttachment,
  saveUploadedFile,
  uploadTooLargeText,
  UploadTooLargeError,
  withoutSavedUploads,
} from "./uploads";
import {
  addComposeMessage,
  clearComposeMessages,
  getState,
  MAX_COMPOSE_MESSAGES,
  startCompose,
} from "./user-state";
import type { ComposeMessage, UserState } from "./user-state";

/** Download a voice note and transcribe it, echoing the text when allowed. */
const transcribeVoiceForCompose = async (
  deps: HandlerDeps,
  ctx: Context,
  messageId: number
) => {
  const file = await ctx.getFile();
  assertWithinUploadCap(file.file_size);
  const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  return await transcribeVoiceNote({ buffer, ctx, echo: true, messageId });
};

/** Turn an incoming message into a ComposeMessage, or undefined if unsupported. */
const buildComposeMessage = async (
  deps: HandlerDeps,
  ctx: Context
): Promise<ComposeMessage | undefined> => {
  const { message } = ctx;
  if (!message) {
    return undefined;
  }
  if (message.voice) {
    const content = await transcribeVoiceForCompose(
      deps,
      ctx,
      message.message_id
    );
    return { content, type: "voice" };
  }
  if (message.document) {
    const filename = message.document.file_name ?? `file_${Date.now()}`;
    const saved = await saveUploadedFile(deps, {
      ctx,
      filename,
      kind: "document",
    });
    const caption = message.caption ?? "";
    return {
      content: `${describeSavedUpload(saved)}\n${caption}`.trim(),
      type: "file",
    };
  }
  if (message.photo) {
    const largest = message.photo.at(-1);
    if (!largest) {
      return undefined;
    }
    const filename = `photo_${Date.now()}.jpg`;
    const saved = await saveUploadedFile(deps, {
      ctx,
      fileId: largest.file_id,
      filename,
      kind: "photo",
    });
    const caption = message.caption ?? "";
    return {
      content: `${describeSavedUpload(saved)}\n${caption}`.trim(),
      type: "photo",
    };
  }
  if (message.forward_origin) {
    const text = message.text ?? message.caption ?? "";
    return {
      content: `[Forwarded from ${forwardSenderName(message.forward_origin)}]\n${text}`,
      type: "forwarded",
    };
  }
  const text = message.text ?? "";
  const replied = await saveRepliedAttachment(deps, ctx);
  if (text.length > 0 || replied !== undefined) {
    const attachment =
      replied === undefined ? "" : `\n${describeSavedUpload(replied)}`;
    return { content: `${text}${attachment}`.trim(), type: "text" };
  }
  return undefined;
};

/** Collect one message into the compose buffer. */
const collectComposeMessage = async (
  deps: HandlerDeps,
  ctx: Context,
  state: UserState
) => {
  const messages = state.composeMessages;
  if (!messages) {
    return;
  }
  if (messages.length >= MAX_COMPOSE_MESSAGES) {
    await ctx.reply(t().compose.full(MAX_COMPOSE_MESSAGES));
    return;
  }
  // A collected voice note goes through transcription before /send ever fires,
  // so it is charged here like a voice note sent directly.
  if (ctx.message?.voice && !(await chargePrivateRun(ctx, deps.ownerId))) {
    return;
  }
  try {
    const message = await buildComposeMessage(deps, ctx);
    if (message) {
      await addComposeMessage(state, message);
    }
  } catch (error) {
    logError("compose collect error", error);
    await ctx
      .reply(
        error instanceof UploadTooLargeError
          ? uploadTooLargeText()
          : t().compose.notAccepted
      )
      .catch(swallow);
    return;
  }
  await updateComposeStatus(ctx, state);
};

/** What `/send` needs: the pipeline, and `pendingWork` to track the detached prompt. */
interface SendDeps {
  pendingWork: HandlerDeps["pendingWork"];
  pipeline: RunPipeline;
}

/**
 * The composed messages as one message to name a new topic from: every part
 * but the saved-file blocks, so a forward keeps its `[Forwarded from …]` label
 * and a file only its caption. A forward with no words of its own adds none.
 */
const composeTitleText = (messages: readonly ComposeMessage[]) =>
  messages
    .flatMap((m) => {
      const words = withoutSavedUploads(m.content);
      const body =
        m.type === "forwarded" ? words.replace(/^\[[^\n]*\]/u, "") : words;
      return body.trim().length > 0 ? [words] : [];
    })
    .join("\n\n");

/** Join the composed messages and hand them to the prompt pipeline. */
const executeSend = async (
  { pendingWork, pipeline }: SendDeps,
  ctx: Context,
  state: UserState
) => {
  if (!state.composeMessages) {
    await ctx.reply(t().compose.idle, {
      reply_markup: removedKeyboard,
    });
    return;
  }
  if (state.composeMessages.length === 0) {
    await clearComposeMessages(state);
    await cleanupComposeStatus(state, ctx);
    await ctx.reply(t().compose.nothingToSend, {
      reply_markup: removedKeyboard,
    });
    return;
  }
  const combined = state.composeMessages.map((m) => m.content).join("\n\n");
  const words = composeTitleText(state.composeMessages);
  // Files with no words say nothing of the work: the run keeps no pick, so
  // the words that follow decide what the conversation runs on.
  const routing: PromptRouting =
    words.length === 0
      ? { kind: "attachment", message: combined, provisional: true }
      : { kind: "text", message: words };
  pendingWork
    .track(titleImplicitTopic({ content: words, ctx }))
    .catch(logRejection("topic title"));
  await clearComposeMessages(state);
  await cleanupComposeStatus(state, ctx);
  // Detached from the update, so tracked here: a shutdown must see the prompt
  // from its first await, before `runAndDrain` registers the run itself.
  pendingWork
    .track(pipeline.handlePrompt(ctx, combined, routing))
    .catch(logRejection("handlePrompt"));
};

/** Discard the composed messages. */
const executeCancel = async (ctx: Context, state: UserState) => {
  if (!state.composeMessages) {
    await ctx.reply(t().compose.idle, {
      reply_markup: removedKeyboard,
    });
    return;
  }
  const count = state.composeMessages.length;
  await clearComposeMessages(state);
  await cleanupComposeStatus(state, ctx);
  await ctx.reply(t().compose.cancelled(count), {
    reply_markup: removedKeyboard,
  });
};

export const registerComposeHandlers = (
  deps: HandlerDeps,
  pipeline: RunPipeline
) => {
  const { bot, pendingWork } = deps;
  const send: SendDeps = { pendingWork, pipeline };

  // Capture non-command messages while composing. Media-group photos fall
  // through to the photo handler so the whole group is batched together.
  bot.on("message", async (ctx, proceed) => {
    // Group chatter is never swallowed: the bot reads it for context and
    // answers only when addressed.
    if (accessOf(ctx).surface === "group") {
      await proceed();
      return;
    }
    const state = await getState(ctx);
    const isCommand = ctx.message?.text?.startsWith("/") === true;
    const isMediaGroupPhoto =
      ctx.message?.photo !== undefined &&
      ctx.message.media_group_id !== undefined;
    if (!state.composeMessages || isCommand || isMediaGroupPhoto) {
      await proceed();
      return;
    }
    await collectComposeMessage(deps, ctx, state);
  });

  bot.command("compose", async (ctx) => {
    if (accessOf(ctx).surface === "group") {
      await ctx.reply(t().compose.privateOnly);
      return;
    }
    const userId = getUserId(ctx);
    const state = await getState(ctx);
    if (state.composeMessages) {
      await ctx.reply(t().compose.already(state.composeMessages.length));
      return;
    }
    startCompose(state);
    const keyboard = new InlineKeyboard()
      .text(t().compose.send, `compose_send:${userId}`)
      .text(t().cancel, `compose_cancel:${userId}`);
    const msg = await ctx.reply(t().compose.started, {
      reply_markup: keyboard,
    });
    state.composeStatusMessageId = msg.message_id;
  });

  bot.command("send", async (ctx) => {
    await executeSend(send, ctx, await getState(ctx));
  });

  bot.command("cancel", async (ctx) => {
    await executeCancel(ctx, await getState(ctx));
  });

  bot.callbackQuery(COMPOSE_SEND_RE, async (ctx) => {
    await ctx.answerCallbackQuery();
    await executeSend(send, ctx, await getState(ctx));
  });

  bot.callbackQuery(COMPOSE_CANCEL_RE, async (ctx) => {
    await ctx.answerCallbackQuery();
    await executeCancel(ctx, await getState(ctx));
  });
};
