import { describe, expect, test } from "bun:test";

import { Cause, Duration, Effect, Exit, Option } from "effect";

import { TranscriptionError, transcribeWith } from "./transcribe";
import type { Transcriber } from "./transcribe";

/** The scripted stand-in for `audio.transcriptions.create`. */
type CreateTranscription = (
  body: Parameters<Transcriber["audio"]["transcriptions"]["create"]>[0]
) => Promise<{ text: string }>;

/** A fake Groq surface whose transcription call is scripted per test. */
const fakeClient = (create: CreateTranscription) => {
  const audio = { transcriptions: { create } };
  // SAFETY: transcribeWith only ever calls audio.transcriptions.create; the
  // rest of the Groq surface is unreachable from these tests.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Groq client carries a surface no fake can supply
  return { audio } as Transcriber;
};

const buffer = Buffer.from("audio-bytes");

/** Message carried by a tagged failure's cause, or "" when it is not an Error. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a failure cause is unknown by construction
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "";

/** Extract the tagged failure from an Exit, or null if it succeeded/defected. */
const failureOf = (exit: Exit.Exit<string, TranscriptionError>) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Cause.findErrorOption(exit.cause))
    : null;

describe("transcribeWith", () => {
  test("returns the transcript text on success", async () => {
    const client = fakeClient(
      async () => await Promise.resolve({ text: "hello world" })
    );
    const text = await Effect.runPromise(
      transcribeWith(client, buffer, "voice.ogg")
    );
    expect(text).toBe("hello world");
  });

  test("wraps a client rejection in a tagged TranscriptionError", async () => {
    const client = fakeClient(async () => {
      await Promise.reject(new Error("429 rate limit"));
      return { text: "" };
    });
    const failure = failureOf(
      await Effect.runPromiseExit(transcribeWith(client, buffer, "voice.ogg"))
    );
    expect(failure).toBeInstanceOf(TranscriptionError);
    expect(messageOf(failure?.cause)).toContain("429 rate limit");
  });

  test("a stalled request times out as a TranscriptionError", async () => {
    // never resolves — simulates a stalled request
    const client = fakeClient(async () => {
      await Bun.sleep(60_000);
      return { text: "" };
    });
    const failure = failureOf(
      await Effect.runPromiseExit(
        transcribeWith(client, buffer, "voice.ogg", Duration.millis(20))
      )
    );
    expect(failure).toBeInstanceOf(TranscriptionError);
    expect(messageOf(failure?.cause)).toContain("timed out");
  });
});
