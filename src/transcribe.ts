import Groq from "groq-sdk";

const groq = new Groq();
const TRANSCRIBE_TIMEOUT = 60_000;

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
    groq.audio.transcriptions.create({ file, model: "whisper-large-v3-turbo" }),
    TRANSCRIBE_TIMEOUT,
    "Groq transcription"
  );
  return response.text;
}
