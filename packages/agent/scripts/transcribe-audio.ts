#!/usr/bin/env bun
// Transcribe the sound of an audio or video file with Groq Whisper, for a run
// that has to know what a clip says without being able to listen to it.
//
//   bun transcribe-audio.ts --path <absolute file path>
//
// stdout is the transcript alone. A file with no audio track prints nothing
// and exits 0; stderr says so. ffmpeg first cuts the track down to mono 16 kHz
// 32 kbit/s MP3, which keeps about 100 minutes under Groq's 25 MB upload limit.

import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunRuntime } from "@effect/platform-bun";
import { AppConfig } from "@workspace/env/bot";
import { spawn } from "bun";
import { Console, Effect, Redacted, Schema } from "effect";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";
const BYTES_PER_MB = 1_048_576;
const GROQ_MAX_MB = 25;
const GROQ_MAX_BYTES = GROQ_MAX_MB * BYTES_PER_MB;
/** How much of a failing tool's stderr or Groq's error body to show. */
const DETAIL_CHARS = 400;
const TIMEOUT = "3 minutes";

/** The command refused its input or a step failed; the message goes to stderr. */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
class TranscribeFailure extends Schema.TaggedError<TranscribeFailure>()(
  "TranscribeFailure",
  { message: Schema.String }
) {}

const fail = (message: string) => new TranscribeFailure({ message });

/** Read a `--flag value` pair from argv; undefined when absent. */
const readFlag = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
};

/** Run a binary to completion; its stdout on exit 0, a failure otherwise. */
const run = (cmd: string[]) =>
  Effect.tryPromise({
    catch: () => fail(`${cmd[0]} could not be started; is it installed?`),
    try: async () => {
      const proc = spawn({ cmd, stderr: "pipe", stdout: "pipe" });
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
        : Effect.fail(
            fail(`${cmd[0]} exited ${code}: ${err.trim().slice(-DETAIL_CHARS)}`)
          )
    )
  );

const hasAudio = (file: string) =>
  run([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    file,
  ]).pipe(Effect.map((out) => out.trim().length > 0));

/** The audio track as a small MP3 in a temp file, removed when the scope ends. */
const extractAudio = (file: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      path.join(tmpdir(), `transcribe-${process.pid}-${Date.now()}.mp3`)
    ).pipe(
      Effect.tap((out) =>
        run([
          "ffmpeg",
          "-v",
          "error",
          "-y",
          "-i",
          file,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-b:a",
          "32k",
          out,
        ])
      )
    ),
    (out) =>
      Effect.promise(async () => {
        await rm(out, { force: true });
      })
  );

const GroqResponse = Schema.Struct({ text: Schema.String });

const transcribe = Effect.fn("transcribeAudio.groq")(function* transcribe(
  audio: string,
  apiKey: Redacted.Redacted
) {
  const { size } = yield* Effect.promise(async () => await stat(audio));
  if (size > GROQ_MAX_BYTES) {
    return yield* fail(
      `audio is ${Math.round(size / BYTES_PER_MB)} MB after compression; Groq takes ${GROQ_MAX_MB} MB at most`
    );
  }
  const body = new FormData();
  body.append("file", Bun.file(audio), path.basename(audio));
  body.append("model", MODEL);
  const response = yield* Effect.tryPromise({
    catch: (cause) => fail(`Groq request failed: ${String(cause)}`),
    try: async (signal) =>
      await fetch(GROQ_URL, {
        body,
        headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
        method: "POST",
        signal,
      }),
  });
  if (!response.ok) {
    const detail = yield* Effect.promise(async () => await response.text());
    return yield* fail(
      `Groq answered ${response.status}: ${detail.slice(0, DETAIL_CHARS)}`
    );
  }
  const decoded = yield* Effect.tryPromise({
    catch: () => fail("Groq answered without a transcript"),
    try: async () => {
      const json: unknown = await response.json();
      return Schema.decodeUnknownSync(GroqResponse)(json);
    },
  });
  return decoded.text.trim();
});

const main = Effect.gen(function* main() {
  const file = readFlag("--path");
  if (file === undefined || !path.isAbsolute(file)) {
    return yield* fail(
      "usage: bun transcribe-audio.ts --path <absolute audio or video path>"
    );
  }
  const exists = yield* Effect.promise(
    async () => await Bun.file(file).exists()
  );
  if (!exists) {
    return yield* fail(`no such file: ${file}`);
  }
  if (!(yield* hasAudio(file))) {
    return yield* Console.error("no audio track");
  }
  const cfg = yield* AppConfig;
  const audio = yield* extractAudio(file);
  const text = yield* transcribe(audio, cfg.groqApiKey);
  return yield* Console.log(text);
}).pipe(
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: TIMEOUT,
    orElse: () => Effect.fail(fail(`timed out after ${TIMEOUT}`)),
  }),
  Effect.catchTag("TranscribeFailure", (failure) =>
    Console.error(failure.message).pipe(
      Effect.andThen(Effect.sync(() => process.exit(1)))
    )
  ),
  Effect.provide(AppConfig.layer)
);

BunRuntime.runMain(main);
