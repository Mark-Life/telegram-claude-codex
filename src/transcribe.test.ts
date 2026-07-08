import { describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit, Option } from "effect";
import {
  type Transcriber,
  TranscriptionError,
  transcribeWith,
} from "./transcribe";

/** A fake Groq surface whose transcription call is scripted per test. */
const fakeClient = (
  create: (args: unknown) => Promise<{ text: string }>
): Transcriber =>
  ({
    audio: { transcriptions: { create } },
  }) as unknown as Transcriber;

const buffer = Buffer.from("audio-bytes");

/** Extract the tagged failure from an Exit, or null if it succeeded/defected. */
const failureOf = (exit: Exit.Exit<string, TranscriptionError>) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Cause.findErrorOption(exit.cause))
    : null;

describe("transcribeWith", () => {
  test("returns the transcript text on success", async () => {
    const client = fakeClient(() => Promise.resolve({ text: "hello world" }));
    const text = await Effect.runPromise(
      transcribeWith(client, buffer, "voice.ogg")
    );
    expect(text).toBe("hello world");
  });

  test("wraps a client rejection in a tagged TranscriptionError", async () => {
    const client = fakeClient(() =>
      Promise.reject(new Error("429 rate limit"))
    );
    const failure = failureOf(
      await Effect.runPromiseExit(transcribeWith(client, buffer, "voice.ogg"))
    );
    expect(failure).toBeInstanceOf(TranscriptionError);
    expect((failure?.cause as Error)?.message).toContain("429 rate limit");
  });

  test("a stalled request times out as a TranscriptionError", async () => {
    const client = fakeClient(
      () =>
        new Promise<{ text: string }>(() => {
          // never resolves — simulates a stalled request
        })
    );
    const failure = failureOf(
      await Effect.runPromiseExit(
        transcribeWith(client, buffer, "voice.ogg", Duration.millis(20))
      )
    );
    expect(failure).toBeInstanceOf(TranscriptionError);
    expect((failure?.cause as Error)?.message).toContain("timed out");
  });
});
