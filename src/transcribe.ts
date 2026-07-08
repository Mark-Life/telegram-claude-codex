import { Context, Data, Duration, Effect, Layer, Redacted } from "effect";
import Groq from "groq-sdk";
import { AppConfig } from "./config";

const TRANSCRIBE_TIMEOUT = Duration.seconds(60);
const MODEL = "whisper-large-v3-turbo";

/** Tagged failure for a Groq Whisper transcription (network, decode, or timeout). */
export class TranscriptionError extends Data.TaggedError("TranscriptionError")<{
  readonly cause: unknown;
}> {}

/** The Groq surface this service actually calls — lets tests inject a fake. */
export type Transcriber = Pick<Groq, "audio">;

/**
 * One timeout-bounded Groq Whisper transcription, errors tagged. Pure over the
 * client so a fake transcriber can drive it in tests with no network.
 *
 * Telegram caps bot file downloads at 20MB, so buffers always fit within Groq's
 * request limit in a single call.
 */
export const transcribeWith = (
  client: Transcriber,
  buffer: Buffer,
  filename: string,
  timeout: Duration.Duration = TRANSCRIBE_TIMEOUT
) =>
  Effect.tryPromise({
    try: () =>
      client.audio.transcriptions.create({
        file: new File([new Uint8Array(buffer)], filename, {
          type: "audio/ogg",
        }),
        model: MODEL,
      }),
    catch: (cause) => new TranscriptionError({ cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new TranscriptionError({
            cause: new Error(
              `Groq transcription timed out after ${Duration.toSeconds(timeout)}s`
            ),
          })
        ),
    }),
    Effect.map((response) => response.text),
    Effect.withSpan("transcribe.audio")
  );

const make = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  // Construct with the key from AppConfig (not ambient env) so the client is
  // decoupled from process.env and built lazily in the layer scope.
  const client = new Groq({ apiKey: Redacted.value(cfg.groqApiKey) });

  const transcribe = (buffer: Buffer, filename: string) =>
    transcribeWith(client, buffer, filename);

  return { transcribe } as const;
});

/**
 * TranscribeService: Groq Whisper wrapped as a first-class Effect resource —
 * key from AppConfig, tagged TranscriptionError, tracing span, and an injectable
 * seam (transcribeWith) for tests.
 */
export class TranscribeService extends Context.Service<
  TranscribeService,
  Effect.Success<typeof make>
>()("@tg/TranscribeService") {
  static readonly layer = Layer.effect(TranscribeService, make);
}
