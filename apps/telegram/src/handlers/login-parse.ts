/**
 * Reading what a device login (`codex login --device-auth`) prints. The CLI's
 * wording is not a contract, so nothing here insists on a shape: the link and
 * the code are found wherever they appear, and output that cannot be read at
 * all is forwarded to the owner verbatim instead of swallowed.
 */

import { t } from "../i18n";

/**
 * A terminal control sequence. The CLI colours its output even when stdout is a
 * pipe, so the link and the code both arrive wrapped: `ESC[94m…ESC[0m`. Left in
 * place, `\S+` swallows the trailing escape into the URL and the owner is sent
 * a link with `[0m` stuck to it.
 */
// oxlint-disable-next-line no-control-regex -- terminal escapes are the subject
const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

/** The output as it would have looked on a plain terminal. */
const stripAnsi = (output: string) => output.replaceAll(ANSI_RE, "");

/** A verification URL: the first http(s) link in the output. */
const URL_RE = /https?:\/\/\S+/u;

/** Punctuation a sentence leaves stuck to the end of a link. */
const TRAILING_PUNCTUATION_RE = /[.,)\]]+$/u;

/**
 * A device code as the CLI prints it: short, upper-case, usually hyphenated
 * (`ABCD-EFGH`). Anchored to word boundaries so an ordinary word, a URL
 * fragment or a long hash does not pass for one.
 */
const CODE_RE = /\b[A-Z\d]{3,8}(?:-[A-Z\d]{3,8})+\b|\b[A-Z\d]{6,8}\b/u;

/** Lines of output forwarded when the link cannot be found. */
const RAW_LINE_LIMIT = 12;

export interface DeviceAuthPrompt {
  code?: string;
  url?: string;
}

/** The verification link and user code, as far as the output reveals them. */
export const parseDeviceAuth = (output: string): DeviceAuthPrompt => {
  const clean = stripAnsi(output);
  const url = URL_RE.exec(clean)?.[0]?.replace(TRAILING_PUNCTUATION_RE, "");
  // A code never lives inside the link, so the link is taken out of the way
  // before looking for one.
  const rest = url === undefined ? clean : clean.replace(url, " ");
  const code = CODE_RE.exec(rest)?.[0];
  return { code, url };
};

/** Non-empty lines of output, capped so a chatty CLI cannot flood the chat. */
export const meaningfulLines = (output: string, limit = RAW_LINE_LIMIT) =>
  stripAnsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);

/**
 * Whether the output already carries both things the owner needs. The CLI
 * prints the code several lines after the link, so a reader that stops at the
 * link stops too early.
 */
export const isCompleteDeviceAuth = (output: string) => {
  const { code, url } = parseDeviceAuth(output);
  return code !== undefined && url !== undefined;
};

/**
 * What the owner is told to do. With a link it is two plain steps; without one
 * the CLI's own output goes through, because a login that cannot be explained
 * is still better than silence.
 */
export const deviceAuthMessage = (output: string) => {
  const { code, url } = parseDeviceAuth(output);
  if (url === undefined) {
    const lines = meaningfulLines(output);
    return lines.length === 0
      ? t().login.startedNoHint
      : [t().login.startedServerSays, "", ...lines].join("\n");
  }
  const steps = [t().login.confirmTitle, "", `1. ${t().login.open(url)}`];
  if (code !== undefined) {
    steps.push(`2. ${t().login.enterCode(code)}`);
  }
  steps.push("", t().login.willWait);
  return steps.join("\n");
};
