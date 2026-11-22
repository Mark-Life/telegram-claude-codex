// Run by `startPdfText` as its own Bun process: read the PDF in argv and
// write its text to the second path, or nothing when the PDF has no text.
// It imports nothing of the bot, so it starts fast and touches no state. The
// text lands under a temporary name first, so a reader never sees half of it.
import { renameSync, writeFileSync } from "node:fs";

import { extractText, getDocumentProxy } from "unpdf";

/** argv holds the runtime and this script before the two paths. */
const ARGS_START = 2;

const [pdfPath, textPath] = process.argv.slice(ARGS_START);
if (pdfPath === undefined || textPath === undefined) {
  throw new Error("usage: pdf-text-child <pdf> <txt>");
}
const data = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
const { text } = await extractText(await getDocumentProxy(data), {
  mergePages: true,
});
if (text.trim().length > 0) {
  const partial = `${textPath}.partial`;
  writeFileSync(partial, text);
  renameSync(partial, textPath);
}
