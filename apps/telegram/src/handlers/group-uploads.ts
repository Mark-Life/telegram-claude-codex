import type { RunImage } from "@workspace/agent/types";
import type { Message } from "grammy/types";

import type { BotContext } from "../access/context";
import { logError } from "../log";
import type { HandlerDeps } from "./deps";
import { logRejection } from "./helpers";
import {
  canOpenFiles,
  describeSavedUpload,
  inlineImage,
  inlineTypeOf,
  saveUploadedFile,
  withinDownloadCap,
} from "./uploads";

/**
 * Photos and documents sent in a group. A file alone is not a request: it is
 * recorded beside the group's text, with a marker in place of its bytes, and
 * downloaded only once the message carrying it is answered. One with no
 * caption is answered only as a reply to the bot, which addresses it as a
 * typed reply would. An album arrives as one update per item with the
 * caption on one of them, so its items are gathered first and the album is
 * judged once, as one message. A video or a GIF is recorded and counted,
 * never downloaded.
 */

/** One photo or document of a group message, as Telegram names it. */
export interface GroupFile {
  fileId: string;
  filename: string;
  /** What Telegram says the file weighs, when it says. */
  fileSize?: number;
  kind: "document" | "photo";
  messageId: number;
  /** A document's type as Telegram names it; an image one is shown inline. */
  mimeType?: string;
}

/** The file a group message carries, if it is a photo or a document. */
export const groupFileOf = (message: Message): GroupFile | undefined => {
  // Telegram sets `document` on a GIF too; it is not a file the run reads.
  if (message.animation !== undefined) {
    return undefined;
  }
  if (message.document !== undefined) {
    return {
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
      filename: message.document.file_name ?? `file_${message.message_id}`,
      kind: "document",
      messageId: message.message_id,
      mimeType: message.document.mime_type,
    };
  }
  const photo = message.photo?.at(-1);
  if (photo === undefined) {
    return undefined;
  }
  return {
    fileId: photo.file_id,
    fileSize: photo.file_size,
    filename: `photo_${message.message_id}.jpg`,
    kind: "photo",
    messageId: message.message_id,
  };
};

/**
 * What the group's memory and the address judge read in place of the files:
 * `[photo]`, `[photo ×6]`, `[document: a.pdf]`, `[video ×2]`, one part per
 * kind.
 */
export const groupFilesMarker = (files: readonly GroupFile[], videos = 0) => {
  const photos = files.filter((file) => file.kind === "photo").length;
  const documents = files.flatMap((file) =>
    file.kind === "document" ? [`[document: ${file.filename}]`] : []
  );
  const photoPart =
    photos === 0 ? [] : [photos === 1 ? "[photo]" : `[photo ×${photos}]`];
  const videoPart =
    videos === 0 ? [] : [videos === 1 ? "[video]" : `[video ×${videos}]`];
  return [...photoPart, ...documents, ...videoPart].join(" ");
};

/** What a run reads for files it is not given: it must not promise to look. */
export const unshownFilesLine = (files: readonly GroupFile[], videos = 0) =>
  `[${groupFilesMarker(files, videos)} attached, which this conversation cannot open: tell the sender you cannot see them]`;

/** What a run reads in place of files, and the images it sees inline. */
export interface FilesPrompt {
  images: readonly RunImage[];
  text: string;
}

/**
 * The base64 one run's images may add up to, so an album of large image
 * documents never makes a request a provider refuses whole.
 */
const INLINE_TOTAL_MAX_MB = 20;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const INLINE_TOTAL_MAX_BASE64 = INLINE_TOTAL_MAX_MB * BYTES_PER_MB;

/**
 * What the run reads where the files would be. When this conversation can
 * open files: a block per saved file. When it cannot: its images inline, read
 * by the bot outside the sandbox, up to the run's total (`spent` already
 * taken, by a replied image). Whatever is left out, a file too large to
 * fetch or one whose download failed included, gets one line saying it
 * cannot be opened: the run never promises to look at a file it cannot see,
 * the answer already charged for still goes, and so do the other files.
 */
export const groupFilesPrompt = async (
  deps: Pick<HandlerDeps, "projectsDir" | "token">,
  ctx: BotContext,
  files: readonly GroupFile[],
  spent = 0
): Promise<FilesPrompt> => {
  const fits = files.filter((file) => withinDownloadCap(file.fileSize));
  const unshown = files.filter((file) => !fits.includes(file));
  const images: RunImage[] = [];
  const blocks: string[] = [];
  const opens = await canOpenFiles(ctx);
  let total = spent;
  for (const file of fits) {
    try {
      if (opens) {
        // oxlint-disable-next-line no-await-in-loop -- downloads stay sequential to bound memory
        const saved = await saveUploadedFile(deps, { ctx, ...file });
        blocks.push(describeSavedUpload(saved));
        continue;
      }
      const mimeType = inlineTypeOf(file);
      const image =
        mimeType === undefined
          ? undefined
          : // oxlint-disable-next-line no-await-in-loop -- one Telegram download at a time
            await inlineImage(deps, { ctx, ...file, mimeType });
      if (
        image === undefined ||
        total + image.data.length > INLINE_TOTAL_MAX_BASE64
      ) {
        unshown.push(file);
      } else {
        total += image.data.length;
        images.push(image);
      }
    } catch (error) {
      logError("Group file download error", error);
      unshown.push(file);
    }
  }
  const lines = [
    ...blocks,
    ...(images.length === 0
      ? []
      : [
          `[${images.length === 1 ? "The image is" : `The ${images.length} images are`} attached to this message]`,
        ]),
    ...(unshown.length === 0 ? [] : [unshownFilesLine(unshown)]),
  ];
  return { images, text: lines.join("\n") };
};

/**
 * How long an album waits for its next item. Longer than the private chat's:
 * a group answers nothing until the album is whole, and an album split by
 * polling lag would be judged without its caption.
 */
const ALBUM_DEBOUNCE_MS = 1200;

/** A group message's photos, documents and words, gathered from its updates. */
export interface GroupUpload {
  /** Every item's caption, in arrival order; a document album has several. */
  caption: string;
  files: readonly GroupFile[];
  /** Videos carry no file the run reads; only their count is recorded. */
  videos: number;
}

/** One album being gathered. */
interface Album {
  captions: string[];
  /** The update the album is answered from: the first captioned, else the first. */
  ctx: BotContext;
  files: GroupFile[];
  settle: () => void;
  timer: ReturnType<typeof setTimeout>;
  videos: number;
}

/**
 * Gathers a group's albums by `media_group_id` and hands each over once no
 * item arrived for a moment, as one message. Added synchronously and tracked
 * as pending work from the first item, so two items never open two albums
 * and a shutdown waits for the album instead of dropping it.
 */
export const createGroupAlbums = (input: {
  flush: (ctx: BotContext, upload: GroupUpload) => Promise<void>;
  pendingWork: HandlerDeps["pendingWork"];
}) => {
  const albums = new Map<string, Album>();

  const flushAlbum = (albumId: string) => {
    const album = albums.get(albumId);
    albums.delete(albumId);
    if (album === undefined) {
      return;
    }
    input
      .flush(album.ctx, {
        caption: album.captions.join("\n\n"),
        files: album.files,
        videos: album.videos,
      })
      .catch(logRejection("group album"))
      .finally(album.settle);
  };

  const schedule = (albumId: string) =>
    setTimeout(() => {
      flushAlbum(albumId);
    }, ALBUM_DEBOUNCE_MS);

  return {
    /** Add one item: a photo or document (`file`), or a video (none). */
    add: (ctx: BotContext, albumId: string, file: GroupFile | undefined) => {
      const caption = ctx.message?.caption?.trim() ?? "";
      const album = albums.get(albumId);
      if (album === undefined) {
        const settled = Promise.withResolvers<undefined>();
        void input.pendingWork.track(settled.promise);
        albums.set(albumId, {
          captions: caption.length > 0 ? [caption] : [],
          ctx,
          files: file === undefined ? [] : [file],
          settle: () => {
            settled.resolve();
          },
          timer: schedule(albumId),
          videos: file === undefined ? 1 : 0,
        });
        return;
      }
      clearTimeout(album.timer);
      if (file === undefined) {
        album.videos += 1;
      } else {
        album.files.push(file);
      }
      if (caption.length > 0) {
        if (album.captions.length === 0) {
          album.ctx = ctx;
        }
        album.captions.push(caption);
      }
      album.timer = schedule(albumId);
    },
  };
};
