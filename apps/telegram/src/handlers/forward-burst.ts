import type { BotContext } from "../access/context";
import { logError } from "../log";
import { requireRoute, routeKey } from "../telegram/route";
import type { HandlerDeps } from "./deps";
import { forwardSenderName, getUserId, logRejection } from "./helpers";
import {
  canOpenFiles,
  describeSavedUpload,
  saveUploadedFile,
  UploadTooLargeError,
} from "./uploads";
import { MAX_COMPOSE_MESSAGES } from "./user-state";

/**
 * Forwarded messages sent together, as one prompt. Forwarding twenty messages
 * makes twenty updates a second or so apart; each would otherwise start or
 * join a run of its own. Every forward opens or extends its conversation's
 * burst, and the burst goes out once no forward has come for a moment. Words
 * the user types while it is open join it as their own request. Polling is
 * sequential, so the burst keeps the order the messages were sent in.
 *
 * Nothing is downloaded or transcribed before the burst is charged to the
 * day's budget, and then one message at a time, like an album. Bursts of one
 * conversation go out in the order they were opened.
 */

const MS_PER_SECOND = 1000;

/** How long a burst waits for one more forward before it goes out. */
const QUIET_MS = 1500;

type Message = NonNullable<BotContext["message"]>;

type Item =
  | { readonly ctx: BotContext; readonly kind: "forward" }
  | { readonly kind: "words"; readonly text: string };

interface Burst {
  /** The latest message: the prompt is sent from it. */
  ctx: BotContext;
  items: Item[];
  /** Ends the pending-work entry that holds a shutdown until the send. */
  settle: () => void;
  timer: ReturnType<typeof setTimeout>;
}

type Readers = Pick<HandlerDeps, "projectsDir" | "token"> & {
  /** A voice note's text, echoed under the note when that is switched on. */
  transcribe: (ctx: BotContext) => Promise<string>;
};

/** One burst per conversation: the sender, the chat and the topic. */
const keyOf = (ctx: BotContext) =>
  `${getUserId(ctx)}:${routeKey(requireRoute(ctx))}`;

/** Who the message came from, and when it was first sent. */
const headerOf = (origin: NonNullable<Message["forward_origin"]>) => {
  const sentAt = new Date(origin.date * MS_PER_SECOND).toISOString();
  return `[Forwarded from ${forwardSenderName(origin)}, ${sentAt}]`;
};

/** What a forward the bot does not download says in its place. */
const labelOf = (message: Message) => {
  if (message.venue !== undefined) {
    return `[Place: ${message.venue.title}, ${message.venue.address}]`;
  }
  if (message.location !== undefined) {
    return `[Location: ${message.location.latitude}, ${message.location.longitude}]`;
  }
  if (message.contact !== undefined) {
    return `[Contact: ${message.contact.first_name}, ${message.contact.phone_number}]`;
  }
  if (message.poll !== undefined) {
    const options = message.poll.options.map((option) => option.text);
    return `[Poll: ${message.poll.question} (${options.join(" / ")})]`;
  }
  if (message.sticker !== undefined) {
    const { emoji } = message.sticker;
    return emoji === undefined ? "[Sticker]" : `[Sticker ${emoji}]`;
  }
  if (message.video !== undefined || message.video_note !== undefined) {
    return "[A video, not downloaded]";
  }
  if (message.audio !== undefined) {
    return "[An audio file, not downloaded]";
  }
  return "[A message the bot cannot read]";
};

/**
 * Whether a forward carries something a run can work with: words, a file, a
 * voice note, a place, a contact or a poll. A burst of nothing else (a
 * sticker, a video with no caption) is dropped, as such a forward always was.
 */
const isReadable = (message: Message) =>
  [
    message.text ?? message.caption,
    message.photo,
    message.document,
    message.voice,
    message.location,
    message.contact,
    message.poll,
  ].some((part) => part !== undefined);

/** The saved file of a forwarded photo or document, as the run reads it. */
const attachmentOf = async (
  readers: Readers,
  ctx: BotContext,
  message: Message
) => {
  if (message.document !== undefined) {
    const saved = await saveUploadedFile(readers, {
      ctx,
      filename: message.document.file_name ?? `file_${message.message_id}`,
      kind: "document",
    });
    return describeSavedUpload(saved);
  }
  const photo = message.photo?.at(-1);
  if (photo === undefined) {
    return labelOf(message);
  }
  const saved = await saveUploadedFile(readers, {
    ctx,
    fileId: photo.file_id,
    filename: `photo_${message.message_id}.jpg`,
    kind: "photo",
  });
  return describeSavedUpload(saved);
};

/** The body of one forward: its words, its file, its transcript or a label. */
const bodyOf = async (readers: Readers, ctx: BotContext, message: Message) => {
  const words = message.text ?? message.caption;
  const withWords = (part: string) =>
    words === undefined ? part : `${words}\n${part}`;
  if (message.voice !== undefined) {
    return `[Voice message transcript]\n${await readers.transcribe(ctx)}`;
  }
  if (message.document === undefined && message.photo === undefined) {
    return message.text ?? withWords(labelOf(message));
  }
  if (!(await canOpenFiles(ctx))) {
    return withWords("[An attachment this conversation cannot open]");
  }
  return withWords(await attachmentOf(readers, ctx, message));
};

/**
 * One forward as prompt text: its header and its body. Never rejects: a
 * forward that cannot be read says so in its place, so the rest of the burst
 * still goes out.
 */
const forwardedContent = async (readers: Readers, ctx: BotContext) => {
  const { message } = ctx;
  const origin = message?.forward_origin;
  if (message === undefined || origin === undefined) {
    return { body: "", header: "" };
  }
  try {
    return {
      body: await bodyOf(readers, ctx, message),
      header: headerOf(origin),
    };
  } catch (error) {
    logError("Forwarded message read failed", error);
    return {
      body:
        error instanceof UploadTooLargeError
          ? "[The attachment is too large to read]"
          : "[This message could not be read]",
      header: headerOf(origin),
    };
  }
};

export const createForwardBursts = (
  input: Readers & {
    /** Take one run from the sender's budget; false refused the burst. */
    charge: (ctx: BotContext) => Promise<boolean>;
    pendingWork: HandlerDeps["pendingWork"];
    /**
     * Run the burst's prompt as if the latest message had said it.
     * `ownWords` is what the router, reminders and titles read.
     */
    send: (input: {
      ctx: BotContext;
      ownWords: string;
      prompt: string;
    }) => Promise<void>;
  }
) => {
  const bursts = new Map<string, Burst>();
  /** A burst closed to forwards and still being read: words still join it. */
  const reading = new Map<string, Burst>();
  /** Each conversation's latest burst still being read, to send after it. */
  const tails = new Map<string, Promise<void>>();

  /**
   * Charge, read one message at a time, then hand the prompt over. Words
   * typed while it reads join the end; once it hands over they go their
   * usual way. A burst is charged like a voice note, before the provider
   * check, because reading it costs money of its own.
   */
  const deliver = async (key: string, burst: Burst) => {
    const forwards = burst.items.flatMap((item) =>
      item.kind === "forward" && item.ctx.message !== undefined
        ? [item.ctx.message]
        : []
    );
    const typed = () => burst.items.some((item) => item.kind === "words");
    // Every way out lets go of `reading` in the same step as its check, so
    // no words can join a burst that is past reading them. A later burst of
    // the conversation may hold the entry by then; it keeps it.
    const release = () => {
      if (reading.get(key) === burst) {
        reading.delete(key);
      }
    };
    if (!(typed() || forwards.some(isReadable))) {
      release();
      return;
    }
    if (!(await input.charge(burst.ctx))) {
      release();
      return;
    }
    const parts: string[] = [];
    const bodies: string[] = [];
    // The array iterator also yields words pushed while a read is awaited.
    for (const item of burst.items) {
      if (item.kind === "words") {
        parts.push(item.text);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- reads stay sequential to bound memory and transcription calls
      const { body, header } = await forwardedContent(input, item.ctx);
      parts.push(`${header}\n${body}`);
      bodies.push(body);
    }
    release();
    const ownWords = typed()
      ? burst.items.flatMap((item) =>
          item.kind === "words" ? [item.text] : []
        )
      : bodies;
    const prompt =
      forwards.length > 1
        ? [`[${forwards.length} forwarded messages]`, ...parts].join("\n\n")
        : parts.join("\n\n");
    input.pendingWork
      .track(
        input.send({ ctx: burst.ctx, ownWords: ownWords.join("\n\n"), prompt })
      )
      .catch(logRejection("forward burst send"));
  };

  const flush = (key: string) => {
    const burst = bursts.get(key);
    if (burst === undefined) {
      return;
    }
    bursts.delete(key);
    reading.set(key, burst);
    clearTimeout(burst.timer);
    const turn: Promise<void> = (tails.get(key) ?? Promise.resolve())
      .then(async () => {
        await deliver(key, burst);
      })
      .catch(logRejection("forward burst flush"))
      .finally(() => {
        if (reading.get(key) === burst) {
          reading.delete(key);
        }
        burst.settle();
        if (tails.get(key) === turn) {
          tails.delete(key);
        }
      });
    tails.set(key, turn);
  };

  const scheduleFlush = (key: string) =>
    setTimeout(() => {
      flush(key);
    }, QUIET_MS);

  /** Take one forwarded message into its conversation's burst. */
  const add = (ctx: BotContext) => {
    const key = keyOf(ctx);
    const item: Item = { ctx, kind: "forward" };
    const burst = bursts.get(key);
    if (burst !== undefined) {
      clearTimeout(burst.timer);
      burst.items.push(item);
      burst.ctx = ctx;
      if (burst.items.length >= MAX_COMPOSE_MESSAGES) {
        flush(key);
        return;
      }
      burst.timer = scheduleFlush(key);
      return;
    }
    // Tracked from the first forward, so a shutdown that stops polling
    // mid-burst still waits for the send.
    const settled = Promise.withResolvers<undefined>();
    void input.pendingWork.track(settled.promise);
    bursts.set(key, {
      ctx,
      items: [item],
      settle: () => {
        settled.resolve();
      },
      timer: scheduleFlush(key),
    });
  };

  /**
   * Words typed while a burst is open or still being read: the request about
   * what was just forwarded. They join the burst, and an open one goes out at
   * once. False when there is none, and the words go their usual way.
   */
  const addWords = (ctx: BotContext, text: string) => {
    const key = keyOf(ctx);
    const open = bursts.get(key);
    if (open !== undefined) {
      open.items.push({ kind: "words", text });
      open.ctx = ctx;
      flush(key);
      return true;
    }
    const read = reading.get(key);
    if (read === undefined) {
      return false;
    }
    read.items.push({ kind: "words", text });
    return true;
  };

  return { add, addWords };
};
