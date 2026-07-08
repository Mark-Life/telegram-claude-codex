import Groq from "groq-sdk";

const TRANSCRIBE_TIMEOUT = 60_000;

/**
 * Lazily construct the Groq client on first use. Constructing at module load
 * throws when GROQ_API_KEY is unset (e.g. under `bun test`), so defer it to the
 * first transcription — the bot validates the key at boot regardless.
 */
let client: Groq | undefined;
const groqClient = () => {
  client ??= new Groq();
  return client;
};

/** Race a promise against a timeout, rejecting with a descriptive error */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms
      )
    ),
  ]);
}

/**
 * Transcribe an audio buffer using Groq Whisper.
 *
 * Telegram caps bot file downloads at 20MB, so buffers always fit within
 * Groq's request limit in a single call.
 */
export async function transcribeAudio(buffer: Buffer, filename: string) {
  const file = new File([new Uint8Array(buffer)], filename, {
    type: "audio/ogg",
  });
  const response = await withTimeout(
    groqClient().audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
    }),
    TRANSCRIBE_TIMEOUT,
    "Groq transcription"
  );
  return response.text;
}
