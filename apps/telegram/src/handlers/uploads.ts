import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getProvider, narrowAccess } from "@workspace/agent";
import { runsInView } from "@workspace/agent/sandbox";
import { RUN_IMAGE_TYPES } from "@workspace/agent/types";
import type { RunImage } from "@workspace/agent/types";
import type { Context } from "grammy";

import { accessOf } from "../access/context";
import { runAccessFor } from "../access/run-access";
import { scratchDirOf } from "../access/scratch";
import { t } from "../i18n";
import { logError, logInfo } from "../log";
import { tg } from "../telegram/bridge";
import type { HandlerDeps, PromptRouting, RunPipeline } from "./deps";
import { buildPromptWithReplyContext, logRejection } from "./helpers";
import { isPdf, pdfTextLine, startPdfText } from "./pdf-text";
import { routeProvider } from "./route-provider";
import { setRouteProject } from "./session-routing";
import { updateComposeStatus } from "./status";
import { titleImplicitTopic } from "./topic-titles";
import { addComposeMessage, getState, isComposing } from "./user-state";

const RANDOM_SUFFIX_RADIX = 36;
const RANDOM_SUFFIX_START = 2;
const RANDOM_SUFFIX_END = 6;

const MEDIA_GROUP_DEBOUNCE_MS = 500;

/** What a run reads in place of the caption an upload came without. */
const ATTACHED_FILE = "See the attached file.";
const ATTACHED_PHOTO = "See the attached photo.";
const ATTACHED_PHOTOS = "See the attached photos.";

const BYTES_PER_KB = 1024;
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * BYTES_PER_KB * BYTES_PER_KB;

/** What the user is told when an upload is over the cap. */
export const uploadTooLargeText = () => t().uploads.tooLarge(MAX_UPLOAD_MB);

/** An upload the size cap refuses; every caller answers with the text above. */
export class UploadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Upload of ${bytes} bytes exceeds the ${MAX_UPLOAD_BYTES} byte cap`);
    this.name = "UploadTooLargeError";
  }
}

/** The Bot API's own limit: `getFile` refuses anything larger. */
const TELEGRAM_DOWNLOAD_MAX_MB = 20;
const TELEGRAM_DOWNLOAD_MAX_BYTES =
  TELEGRAM_DOWNLOAD_MAX_MB * BYTES_PER_KB * BYTES_PER_KB;

/**
 * Whether a file of `bytes` (unknown counts as fitting) can be fetched at
 * all: under both the bot's upload cap and Telegram's download limit.
 */
export const withinDownloadCap = (bytes: number | undefined) =>
  bytes === undefined ||
  bytes <= Math.min(MAX_UPLOAD_BYTES, TELEGRAM_DOWNLOAD_MAX_BYTES);

/** Refuse an oversized upload before it is downloaded, transcribed or stored. */
export const assertWithinUploadCap = (bytes: number | undefined) => {
  if (bytes !== undefined && bytes > MAX_UPLOAD_BYTES) {
    throw new UploadTooLargeError(bytes);
  }
};

/** What a sender reads when their runs here have no tool to open a file. */
const filesUnreadableText = () => t().uploads.unreadable;

/**
 * Whether this sender's runs here can open a saved file. A provider that
 * cannot enforce a read-only view runs it with no local tools, so a file
 * path in the prompt would only lead to a refusal or a guess. A group run
 * opens files only inside the bwrap view: there it sees its own group's
 * directory alone, while a provider's own read-only sandbox reads the disk.
 */
export const canOpenFiles = async (ctx: Context) => {
  const state = await getState(ctx);
  const { provider } = await routeProvider({ access: accessOf(ctx), state });
  const { agent } = runAccessFor(accessOf(ctx));
  const { sandbox } = narrowAccess(agent, getProvider(provider).capabilities);
  if (sandbox === "none") {
    return false;
  }
  return accessOf(ctx).surface !== "group" || runsInView(sandbox);
};

/** How long an album's refusal is remembered; its photos arrive together. */
const REFUSED_ALBUM_TTL_MS = 60_000;

/** Albums already refused, so a ten-photo album gets one refusal. */
const refusedAlbums = new Set<string>();

/** True for a single photo and for the first photo of an album. */
const firstOfAlbum = (mediaGroupId: string | undefined) => {
  if (mediaGroupId === undefined) {
    return true;
  }
  if (refusedAlbums.has(mediaGroupId)) {
    return false;
  }
  refusedAlbums.add(mediaGroupId);
  setTimeout(() => {
    refusedAlbums.delete(mediaGroupId);
  }, REFUSED_ALBUM_TTL_MS);
  return true;
};

interface MediaGroupEntry {
  caption: string;
  ctx: Context;
  photos: { fileId: string; filename: string }[];
  /** Ends the pending-work entry that holds a shutdown until the flush ran. */
  settle: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Pending media groups keyed by media_group_id. */
const mediaGroupBuffers = new Map<string, MediaGroupEntry>();

type UploadKind = "document" | "photo";

export interface SavedUpload {
  absolutePath: string;
  chatId: number;
  kind: UploadKind;
  messageId: number;
  originalFilename: string;
  /**
   * Where the text of a PDF is being written, beside it; absent for any other
   * file. A run reads it once `settlePdfTexts` says it is there.
   */
  textPath?: string;
  threadId: number | null;
  userId: number;
}

interface SaveUploadInput {
  ctx: Context;
  fileId?: string;
  filename: string;
  kind: UploadKind;
  messageId?: number;
}

/**
 * The bytes of a Telegram file: the one `fileId` names, else the message's
 * own. Refused over the upload cap, before and after the download.
 */
const downloadAttachment = async (
  token: string,
  input: { ctx: Context; fileId?: string }
) => {
  const { fileId } = input;
  // No retry: the update waits on this call.
  const file =
    fileId === undefined
      ? await input.ctx.getFile()
      : await tg("getFile", async (api) => await api.getFile(fileId), {
          retry: false,
        });
  assertWithinUploadCap(file.file_size);
  if (file.file_path === undefined) {
    throw new Error("Telegram returned an attachment without file_path");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram attachment download failed with ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  assertWithinUploadCap(buffer.byteLength);
  return buffer;
};

/**
 * Larger than this once in base64, an image is not handed over inline: the
 * providers' cap (Anthropic's 5 MB counts the base64 text).
 */
const INLINE_IMAGE_MAX_MB = 5;
const INLINE_IMAGE_MAX_BASE64 =
  INLINE_IMAGE_MAX_MB * BYTES_PER_KB * BYTES_PER_KB;

/** How long `bytes` grow once in base64. */
const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARS = 4;
const base64Length = (bytes: number) =>
  Math.ceil(bytes / BASE64_GROUP_BYTES) * BASE64_GROUP_CHARS;

/**
 * The inline image type of a file Telegram names `mimeType`, if every
 * provider takes it: a photo is always JPEG (Telegram re-encodes it), a
 * document only when it is an image the providers read.
 */
export const inlineTypeOf = (file: {
  kind: "document" | "photo";
  mimeType?: string;
}) =>
  file.kind === "photo"
    ? "image/jpeg"
    : RUN_IMAGE_TYPES.find((type) => type === file.mimeType);

/**
 * A Telegram image as a run sees it inline: its bytes, never its URL, which
 * holds the bot token. Undefined for one over the providers' cap.
 */
export const inlineImage = async (
  { token }: Pick<HandlerDeps, "token">,
  input: {
    ctx: Context;
    fileId: string;
    /** What Telegram says it weighs: one plainly over the cap is not fetched. */
    fileSize?: number;
    mimeType: RunImage["mimeType"];
  }
): Promise<RunImage | undefined> => {
  if (base64Length(input.fileSize ?? 0) > INLINE_IMAGE_MAX_BASE64) {
    return undefined;
  }
  const buffer = await downloadAttachment(token, input);
  const data = buffer.toString("base64");
  return data.length > INLINE_IMAGE_MAX_BASE64
    ? undefined
    : { data, mimeType: input.mimeType };
};

/**
 * Download a Telegram file into the `user-sent-files` directory of the place
 * the sender's own runs work in: their scratch directory when access says
 * sandboxed (the group's in a group), the conversation's project otherwise.
 * A sandboxed sender's files never land in the owner's working directory,
 * which every owner run reads.
 */
export const saveUploadedFile = async (
  { projectsDir, token }: Pick<HandlerDeps, "projectsDir" | "token">,
  input: SaveUploadInput
): Promise<SavedUpload> => {
  const state = await getState(input.ctx);
  const decision = runAccessFor(accessOf(input.ctx));
  if (!(decision.scratch !== false || state.activeProject)) {
    const { provider } = await routeProvider({
      access: accessOf(input.ctx),
      state,
    });
    await setRouteProject(state, projectsDir, provider);
  }

  const buffer = await downloadAttachment(token, input);

  const base =
    decision.scratch === false
      ? state.activeProject
      : scratchDirOf(decision.scratch, state);
  const messageId = input.messageId ?? input.ctx.message?.message_id;
  if (messageId === undefined) {
    throw new Error("No Telegram message id for uploaded file");
  }
  const dir = path.join(
    base,
    "user-sent-files",
    String(state.chatId),
    String(state.userId),
    state.threadId === null ? "main" : String(state.threadId),
    String(messageId)
  );
  mkdirSync(dir, { recursive: true });
  const originalFilename = path.basename(input.filename);
  const dest = path.join(dir, originalFilename);
  writeFileSync(dest, buffer);
  const textPath =
    input.kind === "document" && isPdf(buffer) ? startPdfText(dest) : undefined;
  const saved = {
    absolutePath: dest,
    chatId: state.chatId,
    kind: input.kind,
    messageId,
    originalFilename,
    textPath,
    threadId: state.threadId,
    userId: state.userId,
  } satisfies SavedUpload;
  logInfo(
    `[upload] saved absolute_path=${saved.absolutePath} chat_id=${saved.chatId} user_id=${saved.userId} thread_id=${saved.threadId ?? "main"} message_id=${saved.messageId}`
  );
  return saved;
};

/** The markers around a `describeSavedUpload` block. */
const UPLOAD_OPEN = "[Incoming Telegram attachment]";
const UPLOAD_CLOSE = "[/Incoming Telegram attachment]";
const UPLOAD_BLOCK_RE = new RegExp(
  `${RegExp.escape(UPLOAD_OPEN)}[\\s\\S]*?${RegExp.escape(UPLOAD_CLOSE)}`,
  "gu"
);

/** Machine-readable provenance included verbatim in the agent's prompt. */
export const describeSavedUpload = (saved: SavedUpload) =>
  [
    UPLOAD_OPEN,
    `kind=${saved.kind}`,
    `original_filename=${JSON.stringify(saved.originalFilename)}`,
    `absolute_path=${JSON.stringify(saved.absolutePath)}`,
    ...(saved.textPath === undefined ? [] : [pdfTextLine(saved.textPath)]),
    `telegram_chat_id=${saved.chatId}`,
    `telegram_user_id=${saved.userId}`,
    `telegram_thread_id=${saved.threadId ?? "main"}`,
    `telegram_message_id=${saved.messageId}`,
    UPLOAD_CLOSE,
  ].join("\n");

/** Whether `text` carries a `describeSavedUpload` block of a document. */
export const carriesDocument = (text: string) =>
  (text.match(UPLOAD_BLOCK_RE) ?? []).some((block) =>
    block.includes("\nkind=document\n")
  );

/** The text with every `describeSavedUpload` block taken out. */
export const withoutSavedUploads = (text: string) =>
  text.replaceAll(UPLOAD_BLOCK_RE, "").trim();

/** Save the photo/document a text or voice message explicitly replies to. */
export const saveRepliedAttachment = async (
  deps: Pick<HandlerDeps, "projectsDir" | "token">,
  ctx: Context
): Promise<SavedUpload | undefined> => {
  const replied = ctx.message?.reply_to_message;
  // Without file tools the reply goes on as plain text.
  if (replied === undefined || !(await canOpenFiles(ctx))) {
    return undefined;
  }
  if (replied.document !== undefined) {
    const filename = replied.document.file_name ?? `file_${replied.message_id}`;
    return await saveUploadedFile(deps, {
      ctx,
      fileId: replied.document.file_id,
      filename,
      kind: "document",
      messageId: replied.message_id,
    });
  }
  const photo = replied.photo?.at(-1);
  if (photo === undefined) {
    return undefined;
  }
  return await saveUploadedFile(deps, {
    ctx,
    fileId: photo.file_id,
    filename: `photo_${replied.message_id}.jpg`,
    kind: "photo",
    messageId: replied.message_id,
  });
};

export const registerUploadHandlers = (
  deps: HandlerDeps,
  pipeline: RunPipeline
) => {
  const { bot, botId, pendingWork } = deps;

  /**
   * Send an upload's prompt, detached from its update and so tracked from the
   * first await: a shutdown must see it before `runAndDrain` registers. One
   * with no caption (`caption` undefined) is
   * routed on `fallback` but keeps no pick, so the words that follow it
   * decide what the conversation runs on.
   */
  const sendPrompt = (
    ctx: Parameters<RunPipeline["handlePrompt"]>[0],
    prompt: string,
    { caption, fallback }: { caption: string | undefined; fallback: string }
  ) => {
    const words = caption?.trim() ?? "";
    const routing: PromptRouting = {
      kind: "attachment",
      message: words.length === 0 ? fallback : words,
      provisional: words.length === 0,
    };
    pendingWork
      .track(pipeline.handlePrompt(ctx, prompt, routing))
      .catch(logRejection("handlePrompt"));
  };

  /**
   * Name a new topic from an upload's caption, before the file is fetched so a
   * message sent after it cannot name the topic first. With no caption the
   * topic waits for the next words.
   */
  const nameTopic = (
    ctx: Parameters<typeof titleImplicitTopic>[0]["ctx"],
    caption: string | undefined
  ) => {
    pendingWork
      .track(titleImplicitTopic({ content: caption ?? "", ctx }))
      .catch(logRejection("topic title"));
  };

  /**
   * An album's caption names the topic while its photo's update is handled,
   * not at the flush, which waits for the debounce and every download. A draft
   * keeps the caption for its own batch.
   */
  const nameTopicFromAlbum = async (
    ctx: Parameters<typeof nameTopic>[0],
    caption: string | undefined
  ) => {
    if (!isComposing(await getState(ctx))) {
      nameTopic(ctx, caption);
    }
  };

  /** Save every photo of one media group and send them as one prompt. */
  const flushGroup = async (group: MediaGroupEntry) => {
    const { ctx, photos, caption } = group;
    const state = await getState(ctx);

    try {
      const photoParts: string[] = [];
      for (const photo of photos) {
        // oxlint-disable-next-line no-await-in-loop -- downloads stay sequential to bound memory
        const saved = await saveUploadedFile(deps, {
          ctx,
          fileId: photo.fileId,
          filename: photo.filename,
          kind: "photo",
        });
        photoParts.push(describeSavedUpload(saved));
      }

      if (isComposing(state)) {
        // /send or /cancel may close the buffer between two photos; the rest of
        // the album must not reopen it.
        let buffered = 0;
        for (const part of photoParts) {
          if (!isComposing(state)) {
            break;
          }
          // oxlint-disable-next-line no-await-in-loop -- photos are buffered in order
          const added = await addComposeMessage(state, {
            content: `${part}\n${caption}`.trim(),
            type: "photo",
          });
          if (added) {
            buffered += 1;
          }
        }
        if (isComposing(state)) {
          await updateComposeStatus(ctx, state);
        } else if (buffered < photoParts.length) {
          await ctx.reply(t().uploads.albumClosed);
        }
        return;
      }

      // A no-op once the photos' own updates named the topic; this covers a
      // draft closed after them.
      nameTopic(ctx, caption);
      const text = caption || ATTACHED_PHOTOS;
      const prompt = `${text}\n\n${photoParts.join("\n")}`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      sendPrompt(ctx, fullPrompt, { caption, fallback: ATTACHED_PHOTOS });
    } catch (error) {
      logError("Media group upload error", error);
      await ctx.reply(
        error instanceof UploadTooLargeError
          ? uploadTooLargeText()
          : t().uploads.photosFailed
      );
    }
  };

  /** Flush a completed media group once its debounce ran out. */
  const flushMediaGroup = async (groupId: string) => {
    const group = mediaGroupBuffers.get(groupId);
    mediaGroupBuffers.delete(groupId);
    if (!group) {
      return;
    }
    try {
      await flushGroup(group);
    } finally {
      group.settle();
    }
  };

  bot.on("message:document", async (ctx) => {
    if (accessOf(ctx).surface === "group") {
      return;
    }
    if (!(await canOpenFiles(ctx))) {
      await ctx.reply(filesUnreadableText());
      return;
    }
    const filename = ctx.message.document.file_name ?? `file_${Date.now()}`;
    nameTopic(ctx, ctx.message.caption);
    try {
      const saved = await saveUploadedFile(deps, {
        ctx,
        filename,
        kind: "document",
      });
      const { caption } = ctx.message;
      const prompt = `${caption ?? ATTACHED_FILE}\n\n${describeSavedUpload(saved)}`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      sendPrompt(ctx, fullPrompt, { caption, fallback: ATTACHED_FILE });
    } catch (error) {
      logError("Document upload error", error);
      await ctx.reply(
        error instanceof UploadTooLargeError
          ? uploadTooLargeText()
          : t().uploads.fileFailed
      );
    }
  });

  bot.on("message:photo", async (ctx) => {
    // A file dropped in a group is not a request; only written words address
    // the bot there.
    if (accessOf(ctx).surface === "group") {
      return;
    }
    const largest = ctx.message.photo.at(-1);
    if (!largest) {
      return;
    }
    if (!(await canOpenFiles(ctx))) {
      if (firstOfAlbum(ctx.message.media_group_id)) {
        await ctx.reply(filesUnreadableText());
      }
      return;
    }
    const filename = `photo_${Date.now()}_${Math.random()
      .toString(RANDOM_SUFFIX_RADIX)
      .slice(RANDOM_SUFFIX_START, RANDOM_SUFFIX_END)}.jpg`;
    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId !== undefined) {
      // The debounce fires outside the update loop, so its rejection has no
      // caller to reach; log it here instead.
      const scheduleFlush = () =>
        setTimeout(() => {
          flushMediaGroup(mediaGroupId).catch(
            logRejection("media group flush")
          );
        }, MEDIA_GROUP_DEBOUNCE_MS);
      const existing = mediaGroupBuffers.get(mediaGroupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.photos.push({ fileId: largest.file_id, filename });
        const caption = ctx.message.caption ?? "";
        if (caption.length > 0) {
          existing.caption = caption;
        }
        existing.timer = scheduleFlush();
        await nameTopicFromAlbum(ctx, ctx.message.caption);
        return;
      }
      // Tracked from the first photo, so a shutdown that stops polling
      // mid-album still waits for the debounce and the flush.
      const settled = Promise.withResolvers<undefined>();
      void pendingWork.track(settled.promise);
      mediaGroupBuffers.set(mediaGroupId, {
        caption: ctx.message.caption ?? "",
        ctx,
        photos: [{ fileId: largest.file_id, filename }],
        settle: () => {
          settled.resolve();
        },
        timer: scheduleFlush(),
      });
      await nameTopicFromAlbum(ctx, ctx.message.caption);
      return;
    }

    nameTopic(ctx, ctx.message.caption);
    try {
      const saved = await saveUploadedFile(deps, {
        ctx,
        fileId: largest.file_id,
        filename,
        kind: "photo",
      });
      const { caption } = ctx.message;
      const prompt = `${caption ?? ATTACHED_PHOTO}\n\n${describeSavedUpload(saved)}`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      sendPrompt(ctx, fullPrompt, { caption, fallback: ATTACHED_PHOTO });
    } catch (error) {
      logError("Photo upload error", error);
      await ctx.reply(
        error instanceof UploadTooLargeError
          ? uploadTooLargeText()
          : t().uploads.photoFailed
      );
    }
  });
};
