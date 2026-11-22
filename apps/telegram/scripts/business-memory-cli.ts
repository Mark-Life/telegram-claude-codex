#!/usr/bin/env bun

import { AppConfig } from "@workspace/env/bot";
import { Effect, Option, Redacted, Schema } from "effect";

import {
  getBusinessMessage,
  recordBusinessMessage,
  setBusinessTranscript,
} from "../src/db/bridge";
import { runtime } from "../src/runtime";
import { TranscribeService } from "../src/transcribe";

interface Target {
  businessConnectionId: string;
  chatId: number;
  messageId: number;
}

const COMMAND_INDEX = 2;
const TelegramFileResponse = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ file_path: Schema.String }),
});
const decodeTelegramFileResponse =
  Schema.decodeUnknownOption(TelegramFileResponse);

const readOption = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const required = (name: string) => {
  const value = readOption(name)?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
};

const integerOption = (name: string) => {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
};

const target: Target = {
  businessConnectionId: required("--connection"),
  chatId: integerOption("--chat"),
  messageId: integerOption("--message"),
};

if (process.argv[COMMAND_INDEX] !== "transcribe") {
  throw new Error(
    "Usage: business-memory-cli.ts transcribe --connection <id> --chat <id> --message <id>"
  );
}

const message = await getBusinessMessage(target);
if (message === undefined || message.voiceFileId === undefined) {
  throw new Error("Archived voice message not found");
}

/** The stored voice bytes, or the file fetched back from Telegram. */
const resolveAudio = async () => {
  if (message.voiceData !== undefined) {
    return { audio: message.voiceData, fetched: false };
  }
  const audio = await runtime.runPromise(
    Effect.gen(function* restoreVoice() {
      const cfg = yield* AppConfig;
      const token = Redacted.value(cfg.botToken);
      const metadataResponse = yield* Effect.promise(
        async () =>
          await fetch(
            `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(message.voiceFileId ?? "")}`
          )
      );
      const metadataText = yield* Effect.promise(
        async () => await metadataResponse.text()
      );
      const metadata: unknown = JSON.parse(metadataText);
      const decoded = decodeTelegramFileResponse(metadata);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          new Error("Telegram could not restore voice")
        );
      }
      const filePath = decoded.value.result.file_path;
      const audioResponse = yield* Effect.promise(
        async () =>
          await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
      );
      if (!audioResponse.ok) {
        return yield* Effect.fail(new Error("Telegram voice download failed"));
      }
      return new Uint8Array(
        yield* Effect.promise(async () => await audioResponse.arrayBuffer())
      );
    })
  );
  return { audio, fetched: true };
};

// The restored bytes are archived before transcription, as before, so a
// failed transcription still leaves the voice on record.
const { audio, fetched } = await resolveAudio();
if (fetched) {
  await recordBusinessMessage({ ...message, voiceData: audio });
}
const result = await runtime.runPromise(
  Effect.flatMap(TranscribeService, (transcriber) =>
    transcriber.transcribe(Buffer.from(audio), "archived-business-voice.ogg")
  )
);
await setBusinessTranscript({ ...target, status: "ready", transcript: result });
// Ending the runtime closes the db connection, which checkpoints the WAL.
await runtime.dispose();

console.log(
  JSON.stringify({
    business_connection_id: target.businessConnectionId,
    chat_id: target.chatId,
    message_id: target.messageId,
    transcript: result,
  })
);
