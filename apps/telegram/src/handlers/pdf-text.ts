import { existsSync } from "node:fs";
import path from "node:path";

import { spawn } from "bun";
import { Option, Schema } from "effect";

import { logError } from "../log";

/** How long one PDF may take to read before the file goes on without text. */
const PDF_TEXT_TIMEOUT_MS = 30_000;

const PDF_MAGIC = "%PDF-";

/** How much of the child's stderr a failure logs. */
const STDERR_TAIL = 500;

const CHILD = path.join(import.meta.dir, "pdf-text-child.ts");

/**
 * Every PDF text this process started, by the path it writes: `written`
 * settles when the child exits. Kept after that, one short entry per PDF.
 */
const started = new Map<string, { done: boolean; written: Promise<void> }>();

/** Whether `buffer` holds a PDF, by its first bytes rather than its name. */
export const isPdf = (buffer: Buffer) =>
  buffer.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;

const runChild = async (pdfPath: string, textPath: string) => {
  const proc = spawn({
    cmd: [process.execPath, CHILD, pdfPath, textPath],
    stderr: "pipe",
    stdout: "ignore",
    timeout: PDF_TEXT_TIMEOUT_MS,
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    logError(
      `[upload] PDF text extraction failed (exit ${code}) path=${pdfPath}`,
      stderr.slice(-STDERR_TAIL)
    );
  }
};

/**
 * Read the PDF in its own Bun process; the child writes the text or nothing.
 * Never rejects: a run that waits on it goes on with the file alone.
 */
const extract = async (pdfPath: string, textPath: string) => {
  try {
    await runChild(pdfPath, textPath);
  } catch (error) {
    logError(`[upload] PDF text extraction failed path=${pdfPath}`, error);
  }
};

/**
 * Start writing the text layer of the PDF at `pdfPath` beside it, as
 * `<pdfPath>.txt`, and answer that path at once: grammY handles one update at
 * a time, so the update that saved the file must not wait for the parse. A
 * run waits for it in `settlePdfTexts`. A text already on disk, from an
 * earlier save of the same message, is reused. pdf.js parses on the thread
 * that calls it, so the parse runs in its own process.
 */
export const startPdfText = (pdfPath: string) => {
  const textPath = `${pdfPath}.txt`;
  if (!(existsSync(textPath) || started.has(textPath))) {
    const entry = { done: false, written: extract(pdfPath, textPath) };
    started.set(textPath, entry);
    void entry.written.finally(() => {
      entry.done = true;
    });
  }
  return textPath;
};

/** The block line that names a PDF's text. */
export const pdfTextLine = (textPath: string) =>
  `extracted_text_path=${JSON.stringify(textPath)}`;

/** Every `pdfTextLine` in a prompt, newline included. */
// `[^\n]`, not `.`: JSON leaves U+2028 and U+2029 raw, and `.` stops there.
const TEXT_LINE_RE = /^extracted_text_path=(?<quoted>"[^\n]*")\n/gmu;

const decodeQuoted = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.String)
);

/** Every PDF text path `prompt` names, started here or before a restart. */
const textPathsIn = (prompt: string) =>
  [...prompt.matchAll(TEXT_LINE_RE)].flatMap(({ groups }) =>
    Option.toArray(decodeQuoted(groups?.quoted))
  );

/** Whether `prompt` names a PDF text still being written. */
export const hasPendingPdfText = (prompt: string) =>
  textPathsIn(prompt).some((textPath) => started.get(textPath)?.done === false);

/**
 * `prompt` without the line of any PDF text that is not on disk: the PDF
 * gave none (a scan, a parse error, the timeout), so the run reads the file
 * alone. Call it once nothing the prompt names is still being written.
 */
export const withoutMissingPdfTexts = (prompt: string) =>
  prompt.replaceAll(TEXT_LINE_RE, (line, quoted: string) =>
    Option.match(decodeQuoted(quoted), {
      onNone: () => "",
      onSome: (textPath) => (existsSync(textPath) ? line : ""),
    })
  );

/** `prompt` once every PDF text it names is written; see above. */
export const settlePdfTexts = async (prompt: string) => {
  await Promise.all(
    textPathsIn(prompt).map(
      async (textPath) => await started.get(textPath)?.written
    )
  );
  return withoutMissingPdfTexts(prompt);
};
