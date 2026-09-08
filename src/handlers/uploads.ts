import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Effect } from "effect";
import type { Context } from "grammy";
import { runtime } from "../runtime";
import { TranscribeService } from "../transcribe";
import type { HandlerDeps, RunPipeline } from "./deps";
import {
  buildPromptWithReplyContext,
  escapeHtml,
  mainKeyboard,
  swallow,
  updateComposeStatus,
} from "./helpers";
import { setRouteProject } from "./session-routing";
import { titleImplicitTopic } from "./topic-titles";
import { addComposeMessage, getState } from "./user-state";

const MEDIA_GROUP_DEBOUNCE_MS = 500;

interface MediaGroupEntry {
  caption: string;
  ctx: Context;
  photos: { fileId: string; filename: string }[];
  timer: ReturnType<typeof setTimeout>;
}

/** Pending media groups keyed by media_group_id */
const mediaGroupBuffers = new Map<string, MediaGroupEntry>();

/**
 * Promise-facing bridge to the Effect TranscribeService: resolves the spoken
 * text or rejects (TranscriptionError) so the existing voice handlers keep their
 * try/catch shape.
 */
const transcribeAudio = (buffer: Buffer, filename: string) =>
  runtime.runPromise(
    Effect.flatMap(TranscribeService, (t) => t.transcribe(buffer, filename))
  );

/** Transcribe a voice message and show the transcription as a status reply */
export const transcribeVoiceForCompose = async (
  token: string,
  ctx: Context,
  messageId: number
) => {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const status = await ctx.reply("Transcribing...", {
    reply_parameters: { message_id: messageId },
  });
  const transcription = await transcribeAudio(buffer, "voice.ogg");
  const maxDisplay = 3800;
  const displayText =
    transcription.length > maxDisplay
      ? `${transcription.slice(0, maxDisplay)}... (truncated)`
      : transcription;
  await ctx.api.editMessageText(
    status.chat.id,
    status.message_id,
    `<blockquote>${escapeHtml(displayText)}</blockquote>`,
    { parse_mode: "HTML" }
  );
  return transcription;
};

/** Download a Telegram file and save to project's user-sent-files dir */
export const saveUploadedFile = async (
  { projectsDir, token }: Pick<HandlerDeps, "projectsDir" | "token">,
  ctx: Context,
  filename: string,
  fileId?: string
) => {
  const state = getState(ctx);
  if (!state.activeProject) {
    setRouteProject(state, projectsDir);
    await ctx.reply("No project selected. Using General (all projects).", {
      reply_markup: mainKeyboard,
    });
  }

  const file = fileId ? await ctx.api.getFile(fileId) : await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());

  const dir = join(state.activeProject, "user-sent-files");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(filename));
  writeFileSync(dest, buffer);
  return dest;
};

/** Voice, document and photo (incl. media groups) message handlers. */
export const registerUploadHandlers = (
  deps: HandlerDeps,
  { handlePrompt }: RunPipeline
) => {
  const { bot, botId, projectsDir, token } = deps;

  bot.on("message:voice", async (ctx) => {
    const state = getState(ctx);

    if (!state.activeProject) {
      setRouteProject(state, projectsDir);
      await ctx.reply("No project selected. Using General (all projects).", {
        reply_markup: mainKeyboard,
      });
    }

    let prompt: string;
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());

      const status = await ctx.reply("Transcribing...", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      prompt = await transcribeAudio(buffer, "voice.ogg");
      const maxDisplay = 3800;
      const displayText =
        prompt.length > maxDisplay
          ? `${prompt.slice(0, maxDisplay)}... (truncated)`
          : prompt;
      await ctx.api.editMessageText(
        state.chatId,
        status.message_id,
        `<blockquote>${escapeHtml(displayText)}</blockquote>`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      console.error("Voice transcription error:", e);
      await ctx.reply(
        `Transcription failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
      return;
    }

    // Fired, not awaited: a topic rename must never hold up the prompt.
    titleImplicitTopic({
      content: prompt,
      ctx,
      provider: state.activeProvider,
      workingDirectory: state.activeProject || projectsDir,
    }).catch(swallow);

    const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
    handlePrompt(ctx, fullPrompt).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const filename = doc.file_name ?? `file_${Date.now()}`;

    try {
      const dest = await saveUploadedFile(deps, ctx, filename);
      if (!dest) {
        return;
      }

      const caption = ctx.message.caption ?? "See the attached file.";
      const prompt = `${caption}\n\n[File: ${filename} saved at ${dest}]`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      handlePrompt(ctx, fullPrompt).catch((e) =>
        console.error("handlePrompt error:", e)
      );
    } catch (e) {
      console.error("Document upload error:", e);
      await ctx.reply(
        `File upload failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
  });

  /** Flush a completed media group: save all photos and send as one prompt */
  const flushMediaGroup = async (groupId: string) => {
    const group = mediaGroupBuffers.get(groupId);
    mediaGroupBuffers.delete(groupId);
    if (!group) {
      return;
    }

    const { ctx, photos, caption } = group;
    const state = getState(ctx);

    try {
      const photoParts: string[] = [];
      for (const photo of photos) {
        const dest = await saveUploadedFile(
          deps,
          ctx,
          photo.filename,
          photo.fileId
        );
        photoParts.push(`[Photo saved at ${dest}]`);
      }
      const text = caption || "See the attached photos.";
      const prompt = `${text}\n\n${photoParts.join("\n")}`;

      if (state.composeMessages) {
        for (const part of photoParts) {
          addComposeMessage(state, {
            type: "photo",
            content: `${part}\n${caption}`.trim(),
          });
        }
        await updateComposeStatus(ctx, state);
      } else {
        const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
        handlePrompt(ctx, fullPrompt).catch((e) =>
          console.error("handlePrompt error:", e)
        );
      }
    } catch (e) {
      console.error("Media group upload error:", e);
      await ctx.reply(
        `Photo upload failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
  };

  bot.on("message:photo", async (ctx) => {
    const largest = ctx.message.photo.at(-1);
    if (!largest) {
      return;
    }
    const filename = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId) {
      const existing = mediaGroupBuffers.get(mediaGroupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.photos.push({ fileId: largest.file_id, filename });
        if (ctx.message.caption) {
          existing.caption = ctx.message.caption;
        }
        existing.timer = setTimeout(
          () => flushMediaGroup(mediaGroupId),
          MEDIA_GROUP_DEBOUNCE_MS
        );
      } else {
        const timer = setTimeout(
          () => flushMediaGroup(mediaGroupId),
          MEDIA_GROUP_DEBOUNCE_MS
        );
        mediaGroupBuffers.set(mediaGroupId, {
          photos: [{ fileId: largest.file_id, filename }],
          caption: ctx.message.caption ?? "",
          ctx,
          timer,
        });
      }
      return;
    }

    // Single photo (no media group)
    try {
      const dest = await saveUploadedFile(deps, ctx, filename, largest.file_id);
      if (!dest) {
        return;
      }

      const caption = ctx.message.caption ?? "See the attached photo.";
      const prompt = `${caption}\n\n[Photo saved at ${dest}]`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      handlePrompt(ctx, fullPrompt).catch((e) =>
        console.error("handlePrompt error:", e)
      );
    } catch (e) {
      console.error("Photo upload error:", e);
      await ctx.reply(
        `Photo upload failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
  });
};
