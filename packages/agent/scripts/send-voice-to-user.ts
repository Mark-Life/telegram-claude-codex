#!/usr/bin/env bun
// Speak a script with ElevenLabs and send it as a Telegram voice message.
//
//   bun send-voice-to-user.ts --chat <id> [--thread <id>] [--text-file <path>]
//                             [--caption <text>] [--out <path.ogg>]
//
// The script is read from --text-file, or from stdin when there is none. The
// voice and model are the owner's picks in /settings (`tts_voice`,
// `tts_model`); unset, the account's first voice matching the bot's persona
// and Eleven v4. A long script is spoken in parts and joined. ffmpeg turns
// the MP3 into the OGG/Opus Telegram plays as a voice note. With --out the
// note is written there and nothing is sent, so no --chat is needed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SettingsRepo } from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import { spawn } from "bun";
import { Console, Effect, Layer, Option, Redacted } from "effect";

import {
  ElevenLabs,
  followsTags,
  pickVoice,
  splitForSpeech,
  ttsModelOf,
  withoutTags,
} from "../src/elevenlabs";
import { readFlag, refuse, runDbCli } from "./lib/db-cli";
import { checkRecipient } from "./lib/recipient";

/** About fifteen minutes of speech; a longer reply belongs in text. */
const MAX_CHARS = 15_000;
/** How much of the neighbouring parts each request is shown, for flow. */
const CONTEXT_CHARS = 500;
/** Telegram's caption limit. */
const MAX_CAPTION = 1024;
const DETAIL_CHARS = 400;

const { argv } = process;

/** Run a binary to completion: its stdout on exit 0, a refusal otherwise. */
const run = (cmd: readonly string[]) =>
  Effect.tryPromise({
    catch: () => refuse(`${cmd[0]} could not be started; is it installed?`),
    try: async () => {
      const proc = spawn({ cmd: [...cmd], stderr: "pipe", stdout: "pipe" });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, err, out };
    },
  }).pipe(
    Effect.flatMap(({ code, err, out }) =>
      code === 0
        ? Effect.succeed(out)
        : refuse(`${cmd[0]} exited ${code}: ${err.trim().slice(-DETAIL_CHARS)}`)
    )
  );

/** The script to speak: --text-file, else stdin. */
const readScript = Effect.gen(function* () {
  const file = readFlag(argv, "--text-file");
  const text = yield* Effect.tryPromise({
    catch: () => refuse(`cannot read the script from ${file ?? "stdin"}`),
    try: async () =>
      file === undefined ? await Bun.stdin.text() : await Bun.file(file).text(),
  });
  const script = text.trim();
  if (script.length === 0) {
    return yield* refuse(
      "usage: send-voice-to-user.ts --chat <id> [--thread <id>] [--text-file <path>] [--caption <text>]; the script comes from --text-file or stdin and is empty"
    );
  }
  if (script.length > MAX_CHARS) {
    return yield* refuse(
      `the script is ${script.length} characters; a voice message takes ${MAX_CHARS} at most. Shorten it, or send the long version as text.`
    );
  }
  return script;
});

/** A scratch directory, removed when the scope ends. */
const scratchDir = Effect.acquireRelease(
  Effect.promise(async () => await mkdtemp(path.join(tmpdir(), "voice-"))),
  (dir) =>
    Effect.promise(async () => {
      await rm(dir, { force: true, recursive: true });
    })
);

/** Every part spoken in order, then joined into one OGG/Opus voice note. */
const synthesize = Effect.fnUntraced(function* synthesize(input: {
  dir: string;
  model: ReturnType<typeof ttsModelOf>;
  script: string;
  voiceId: string;
}) {
  const elevenLabs = yield* ElevenLabs;
  const parts = splitForSpeech(input.script);
  const files: string[] = [];
  for (const [index, text] of parts.entries()) {
    const audio = yield* elevenLabs.speak({
      model: input.model,
      nextText: parts[index + 1]?.slice(0, CONTEXT_CHARS),
      previousText: parts[index - 1]?.slice(-CONTEXT_CHARS),
      text,
      voiceId: input.voiceId,
    });
    const file = path.join(input.dir, `part-${index}.mp3`);
    yield* Effect.promise(async () => await Bun.write(file, audio));
    files.push(file);
  }
  const ogg = path.join(input.dir, "voice.ogg");
  // The concat protocol joins MP3 frames as they are; libopus mono at 48k
  // is what Telegram's own clients record.
  yield* run([
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-i",
    `concat:${files.join("|")}`,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    "48k",
    "-application",
    "voip",
    ogg,
  ]);
  const seconds = yield* run([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    ogg,
  ]).pipe(
    Effect.map((out) => Math.max(1, Math.round(Number(out.trim()) || 0)))
  );
  return { ogg, parts: parts.length, seconds };
});

/** Post the note with `sendVoice`; Telegram's error comes back as a refusal. */
const sendVoice = Effect.fnUntraced(function* sendVoice(input: {
  caption: string | undefined;
  chatId: number;
  ogg: string;
  seconds: number;
  threadId: number | undefined;
}) {
  const cfg = yield* AppConfig;
  const form = new FormData();
  form.append("chat_id", String(input.chatId));
  if (input.threadId !== undefined) {
    form.append("message_thread_id", String(input.threadId));
  }
  form.append("voice", Bun.file(input.ogg), "voice.ogg");
  form.append("duration", String(input.seconds));
  if (input.caption !== undefined && input.caption.trim().length > 0) {
    form.append("caption", input.caption.trim().slice(0, MAX_CAPTION));
  }
  const answer = yield* Effect.tryPromise({
    catch: (cause) => refuse(`Telegram request failed: ${String(cause)}`),
    try: async () => {
      const response = await fetch(
        `https://api.telegram.org/bot${Redacted.value(cfg.botToken)}/sendVoice`,
        { body: form, method: "POST" }
      );
      return {
        body: await response.text(),
        ok: response.ok,
        status: response.status,
      };
    },
  });
  return yield* answer.ok
    ? Effect.void
    : refuse(
        `Telegram API error ${answer.status}: ${answer.body.slice(0, DETAIL_CHARS)}`
      );
});

const main = Effect.gen(function* () {
  const out = readFlag(argv, "--out");
  if (out !== undefined && !path.isAbsolute(out)) {
    return yield* refuse("--out must be an absolute path");
  }
  // Checked before any speech is paid for.
  const target =
    out === undefined
      ? {
          kind: "chat" as const,
          ...(yield* checkRecipient({
            chat: readFlag(argv, "--chat") ?? process.env.TELEGRAM_CHAT_ID,
            hasThread: argv.includes("--thread"),
            thread: readFlag(argv, "--thread"),
          })),
        }
      : { kind: "file" as const, out };
  const script = yield* readScript;
  const elevenLabs = yield* ElevenLabs;
  if (!elevenLabs.configured) {
    return yield* refuse(
      "Voice messages are not set up: ELEVENLABS_API_KEY is missing from the bot's .env. Tell the user; do not look for another way."
    );
  }
  const settings = yield* SettingsRepo;
  const [storedVoice, storedModel, gender] = yield* Effect.all([
    settings.get("tts_voice"),
    settings.get("tts_model"),
    settings.get("persona_gender"),
  ]);
  const voices = yield* elevenLabs.voices();
  const voice = pickVoice({
    gender: Option.getOrUndefined(gender) === "female" ? "female" : "male",
    stored: Option.getOrUndefined(storedVoice),
    voices,
  });
  if (voice === undefined) {
    return yield* refuse(
      "The ElevenLabs account has no voices. Tell the user to add one at elevenlabs.io (My Voices)."
    );
  }
  const model = ttsModelOf(Option.getOrUndefined(storedModel));
  const dir = yield* scratchDir;
  const note = yield* synthesize({
    dir,
    model,
    script: followsTags(model) ? script : withoutTags(script),
    voiceId: voice.id,
  });
  const spoken = `duration=${note.seconds}s parts=${note.parts} voice=${JSON.stringify(voice.name)} model=${model}`;
  if (target.kind === "file") {
    yield* Effect.promise(
      async () => await Bun.write(target.out, Bun.file(note.ogg))
    );
    return yield* Console.log(
      `Wrote voice: absolute_path=${target.out} ${spoken}`
    );
  }
  yield* sendVoice({
    caption: readFlag(argv, "--caption"),
    chatId: target.chatId,
    ogg: note.ogg,
    seconds: note.seconds,
    threadId: target.threadId,
  });
  return yield* Console.log(
    `Sent voice: chat_id=${target.chatId} thread_id=${target.threadId ?? "main"} ${spoken}`
  );
}).pipe(
  Effect.scoped,
  Effect.catchTag("ElevenLabsError", (failure) => refuse(failure.message)),
  Effect.provide(ElevenLabs.layer.pipe(Layer.provideMerge(AppConfig.layer))),
  Effect.catchTag("ConfigError", (failure) =>
    refuse(`The bot's config is incomplete: ${String(failure)}`)
  )
);

runDbCli(main);
