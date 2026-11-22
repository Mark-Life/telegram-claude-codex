import { AppConfig } from "@workspace/env/bot";
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Order,
  Redacted,
  Schema,
} from "effect";

/**
 * The ElevenLabs text-to-speech API as an Effect service: the account's
 * voices for the `/settings` picker, and speech for a voice reply
 * (`scripts/send-voice-to-user.ts`). Two endpoints, so plain `fetch` rather
 * than the official SDK. With no `ELEVENLABS_API_KEY` the service still
 * builds; every call fails with `reason: "no-key"`.
 */

const API = "https://api.elevenlabs.io";

/**
 * The models a voice reply may be spoken with, the default first: v4 for the
 * best narration, v4 Turbo when speed matters, Flash v2.5 when price does.
 * Their names in the menu are copy (`settings.voice.models`).
 */
export const TTS_MODELS = [
  "eleven_v4",
  "eleven_v4_turbo",
  "eleven_flash_v2_5",
] as const;

export type TtsModel = (typeof TTS_MODELS)[number];

/**
 * Whether a model follows audio tags such as `[warmly]`; one that does not
 * would read them aloud, so the script drops them first (`withoutTags`).
 */
export const followsTags = (model: TtsModel) => model !== "eleven_flash_v2_5";

/** A script with its `[audio tags]` taken out, for a model without them. */
export const withoutTags = (text: string) =>
  text.replaceAll(/\[[^\]\n]{1,60}\]\s?/gu, "");

/** A stored model id, or the default for anything else. */
export const ttsModelOf = (raw: string | undefined): TtsModel =>
  TTS_MODELS.find((model) => model === raw) ?? TTS_MODELS[0];

/**
 * The most text one request carries. Below every model's own limit (v4
 * takes 10,000), so a longer reply is split and its parts joined.
 */
const TTS_CHUNK_CHARS = 4000;

/**
 * How many voices one read asks for: the set the picker shows the first of,
 * and the one a stored voice is checked against. One page only.
 */
const VOICES_PAGE = 30;

/** One request, reading a long part's speech included. */
const REQUEST_MINUTES = 2;
const REQUEST_TIMEOUT = Duration.minutes(REQUEST_MINUTES);

const PAYMENT_REQUIRED = 402;

/** How much of an error body is kept for the message. */
const DETAIL_CHARS = 300;

// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class ElevenLabsError extends Schema.TaggedError<ElevenLabsError>()(
  "ElevenLabsError",
  {
    message: Schema.String,
    reason: Schema.Literals(["no-key", "http", "network", "decode"]),
  }
) {}

const Voice = Schema.Struct({
  category: Schema.optional(Schema.NullOr(Schema.String)),
  is_owner: Schema.optional(Schema.NullOr(Schema.Boolean)),
  labels: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.String))
  ),
  name: Schema.String,
  voice_id: Schema.String,
});

const VoicesResponse = Schema.Struct({ voices: Schema.Array(Voice) });

/** One voice of the owner's account, as the picker and the script need it. */
export interface TtsVoice {
  /** `female`, `male` or whatever label the voice carries, if any. */
  readonly gender: string | undefined;
  readonly id: string;
  readonly name: string;
  /**
   * A voice the owner made (cloned, designed, or a professional clone of
   * their own). A voice saved from the library is not: a free plan cannot
   * speak with one through the API.
   */
  readonly own: boolean;
}

/** What one speech request asks for. */
interface SpeechRequest {
  readonly model: TtsModel;
  /** The text of the parts around this one, so the joins sound continuous. */
  readonly nextText?: string;
  readonly previousText?: string;
  readonly text: string;
  readonly voiceId: string;
}

/** The account's own voices first, then by name. */
const VoiceOrder = Order.combine(
  Order.mapInput(Order.Boolean, (voice: TtsVoice) => !voice.own),
  Order.mapInput(Order.String, (voice: TtsVoice) => voice.name)
);

const failure = (reason: ElevenLabsError["reason"], message: string) =>
  new ElevenLabsError({ message, reason });

const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  const key = cfg.elevenLabsApiKey;

  /**
   * One authenticated request with its body read by `read`, both under one
   * timeout, so a stream that stalls mid-body fails too. A non-2xx answer
   * fails with its body.
   */
  const request = <A>(
    pathAndQuery: string,
    read: (response: Response) => Promise<A>,
    init?: RequestInit
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(key)) {
        return yield* failure("no-key", "ELEVENLABS_API_KEY is not set");
      }
      const answer = yield* Effect.tryPromise({
        catch: (cause) =>
          failure("network", `ElevenLabs request failed: ${String(cause)}`),
        try: async (signal) => {
          const response = await fetch(`${API}${pathAndQuery}`, {
            ...init,
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": Redacted.value(key.value),
            },
            signal,
          });
          return response.ok
            ? { body: await read(response), ok: true as const }
            : {
                detail: await response.text().catch(() => ""),
                ok: false as const,
                status: response.status,
              };
        },
      });
      if (!answer.ok) {
        // 402: the plan does not cover this voice, usually one saved from
        // the library on a free plan.
        const hint =
          answer.status === PAYMENT_REQUIRED
            ? " The account's plan does not cover this voice; pick another in /settings → Голосовые ответы."
            : "";
        return yield* failure(
          "http",
          `ElevenLabs answered ${answer.status}: ${answer.detail.slice(0, DETAIL_CHARS)}${hint}`
        );
      }
      return answer.body;
    }).pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(failure("network", "ElevenLabs timed out")),
      })
    );

  /**
   * The account's voices, its own (made or saved) first, then by name. The
   * ElevenLabs defaults come along on the first page while the account
   * still has them.
   */
  const voices = Effect.fn("ElevenLabs.voices")(function* voices() {
    const json = yield* request(
      `/v2/voices?page_size=${VOICES_PAGE}`,
      async (response) => await response.text()
    );
    const decoded = yield* Effect.try({
      catch: () => failure("decode", "ElevenLabs sent no voice list"),
      try: () =>
        Schema.decodeUnknownSync(Schema.fromJsonString(VoicesResponse))(json),
    });
    return Arr.sort(
      decoded.voices.map((voice): TtsVoice => ({
        gender: voice.labels?.gender ?? undefined,
        id: voice.voice_id,
        name: voice.name,
        own:
          voice.is_owner === true ||
          voice.category === "cloned" ||
          voice.category === "generated",
      })),
      VoiceOrder
    );
  });

  /** One part of a reply as MP3 bytes. */
  const speak = Effect.fn("ElevenLabs.speak")(function* speak(
    input: SpeechRequest
  ) {
    return yield* request(
      `/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`,
      async (response) => new Uint8Array(await response.arrayBuffer()),
      {
        body: JSON.stringify({
          model_id: input.model,
          next_text: input.nextText,
          previous_text: input.previousText,
          text: input.text,
        }),
        method: "POST",
      }
    );
  });

  return { configured: Option.isSome(key), speak, voices } as const;
});

/** ElevenLabs: the key from AppConfig, one span per call. */
export class ElevenLabs extends Context.Service<
  ElevenLabs,
  Effect.Success<typeof make>
>()("@workspace/ElevenLabs") {
  static readonly layer = Layer.effect(ElevenLabs, make);
}

/**
 * The voice a reply is spoken with: the stored one while the account still
 * has it, else the first voice whose gender matches the bot's persona (own
 * voices come first in the list), else the first voice at all.
 */
export const pickVoice = (input: {
  gender: "female" | "male";
  stored: string | undefined;
  voices: readonly TtsVoice[];
}) =>
  input.voices.find((voice) => voice.id === input.stored) ??
  input.voices.find((voice) => voice.gender === input.gender) ??
  input.voices[0];

/** After `.!?…` and a space, or after a full-width `。！？；`, which has none. */
const SENTENCE_END = /(?<=[.!?…])\s+|(?<=[。！？；])\s*/u;

/** A piece in slices of at most `limit` characters. */
const sliced = (piece: string, limit: number) =>
  Array.from({ length: Math.ceil(piece.length / limit) || 1 }, (_, index) =>
    piece.slice(index * limit, (index + 1) * limit)
  );

/**
 * Split a script into parts of at most `limit` characters: at paragraph
 * breaks, then at sentence ends (Chinese and Japanese ones too), then at
 * spaces, so no word is cut; only a run with no break at all, longer than
 * `limit`, is cut in slices. A paragraph break inside a part stays, since it
 * is a pause when spoken.
 */
export const splitForSpeech = (text: string, limit = TTS_CHUNK_CHARS) => {
  const parts: string[] = [];
  let current = "";
  const add = (piece: string, separator: string) => {
    if (
      current.length > 0 &&
      current.length + separator.length + piece.length > limit
    ) {
      parts.push(current);
      current = "";
    }
    current = current.length === 0 ? piece : `${current}${separator}${piece}`;
  };
  for (const paragraph of text.trim().split(/\n\s*\n/u)) {
    let separator = "\n\n";
    for (const sentence of paragraph.trim().split(SENTENCE_END)) {
      const words = (
        sentence.length <= limit ? [sentence] : sentence.split(/\s+/u)
      ).flatMap((word) => sliced(word, limit));
      for (const word of words) {
        add(word, separator);
        separator = " ";
      }
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
};
