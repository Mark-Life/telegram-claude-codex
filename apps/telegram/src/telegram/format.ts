import type { AgentError } from "@workspace/agent";
import type { AgentEvent, ProviderCapabilities } from "@workspace/agent/types";

export const MAX_MSG_LENGTH = 4000;
export const EDIT_INTERVAL_MS = 1500;
export const DRAFT_INTERVAL_MS = 300;
export const TYPING_INTERVAL_MS = 5000;

/** Accept a newline break only when it keeps at least this share of a full chunk. */
export const MIN_CHUNK_FILL_RATIO = 0.5;
/** Collapse a tool list or thinking block into an expandable quote at this many lines. */
const BLOCKQUOTE_MIN_LINES = 4;
/** Headroom left below the message limit when tail-truncating thinking text. */
const THINKING_RESERVED_CHARS = 200;
const MS_PER_SECOND = 1000;
const TOKENS_PER_K = 1000;

/** A token count as the chat shows it: `23.9k`. */
export const kiloTokens = (count: number) =>
  `${(count / TOKENS_PER_K).toFixed(1)}k`;

const TOKENS_PER_M = 1_000_000;

/** A window-sized count, short: `840`, `124k`, `1M`, `1.5M`. */
export const shortTokens = (count: number) => {
  const thousands = Math.round(count / TOKENS_PER_K);
  if (thousands >= TOKENS_PER_K) {
    return `${Number((count / TOKENS_PER_M).toFixed(1))}M`;
  }
  return count >= TOKENS_PER_K ? `${thousands}k` : String(count);
};

const FULL = 100;
const BAR_CELLS = 10;

/** A percentage held to 0–100. */
export const clampPercent = (value: number) =>
  Math.min(FULL, Math.max(0, value));

/** A percentage as ten cells, `▰▰▰▱▱▱▱▱▱▱`; a cell fills only once reached. */
export const bar = (percent: number) => {
  const filled = Math.floor((clampPercent(percent) * BAR_CELLS) / FULL);
  return `${"▰".repeat(filled)}${"▱".repeat(BAR_CELLS - filled)}`;
};
/** Decimal places shown for a run cost in dollars. */
const COST_DECIMALS = 4;

/** A single variant of the normalized event union, selected by its `kind` tag. */
export type EventOf<K extends AgentEvent["kind"]> = Extract<
  AgentEvent,
  { kind: K }
>;

export interface StreamResult {
  cost?: number;
  durationMs?: number;
  errorClass?: AgentError;
  messageId?: number;
  planPath?: string;
  sessionId?: string;
  /** Complete assistant text, retained so group memory includes bot replies. */
  text?: string;
  totalTokens?: number;
  turns?: number;
}

/** Split text into chunks that fit within Telegram's message length limit, breaking at newline boundaries when possible */
export const splitText = (text: string, maxLen = MAX_MSG_LENGTH) => {
  if (text.length <= maxLen) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cutPoint = remaining.lastIndexOf("\n", maxLen);
    const splitAt =
      cutPoint > maxLen * MIN_CHUNK_FILL_RATIO ? cutPoint : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
};

const graphemes = new Intl.Segmenter("ru", { granularity: "grapheme" });

/**
 * Text as one line of at most `max` characters, cut between graphemes, so
 * it never splits an emoji nor, in HTML, runs a tag over a line break.
 */
export const truncate = (text: string, max: number) => {
  const chars = Array.from(
    graphemes.segment(text.trim().replaceAll(/\s+/gu, " ")),
    (part) => part.segment
  );
  return chars.length <= max
    ? chars.join("")
    : `${chars.slice(0, max - 1).join("")}…`;
};

/** Escape HTML special characters */
export const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Render the given tool lines as Telegram HTML, wrapping long lists in an expandable blockquote */
export const renderToolsHtml = (toolLines: string[]) => {
  const lines = toolLines.map((l) => `<i>${escapeHtml(l)}</i>`).join("\n");
  return toolLines.length >= BLOCKQUOTE_MIN_LINES
    ? `<blockquote expandable>${lines}</blockquote>`
    : lines;
};

/** Render thinking text as HTML (expandable blockquote if 4+ lines), tail-truncated to fit */
export const renderThinking = (text: string) => {
  let display = text;
  const maxThinkingChars = MAX_MSG_LENGTH - THINKING_RESERVED_CHARS;
  if (display.length > maxThinkingChars) {
    display = `...${display.slice(display.length - maxThinkingChars)}`;
  }
  const escaped = escapeHtml(display);
  const html =
    escaped.split("\n").length >= BLOCKQUOTE_MIN_LINES
      ? `<blockquote expandable><i>${escaped}</i></blockquote>`
      : `<i>${escaped}</i>`;
  return { html, plain: display };
};

/** Format metadata footer as italic markdown, gating cost/turns by provider capabilities */
export const formatFooter = (
  projectName: string,
  result: StreamResult,
  capabilities: ProviderCapabilities,
  branchName?: string | null
) => {
  const meta: string[] = [];
  if (projectName.length > 0) {
    const branch =
      branchName === undefined || branchName === null || branchName.length === 0
        ? ""
        : ` [${branchName}]`;
    meta.push(`Project: ${projectName}${branch}`);
  }
  if (capabilities.cost && result.cost !== undefined) {
    meta.push(`Cost: $${result.cost.toFixed(COST_DECIMALS)}`);
  }
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / MS_PER_SECOND).toFixed(1);
    meta.push(`Time: ${secs}s`);
  }
  if (result.totalTokens !== undefined) {
    meta.push(`${kiloTokens(result.totalTokens)} tokens`);
  }
  const turnsMeaningful =
    result.turns !== undefined &&
    result.turns > 1 &&
    (capabilities.cost || result.turns > 0);
  if (turnsMeaningful) {
    meta.push(`Turns: ${result.turns}`);
  }
  if (meta.length === 0) {
    return "";
  }
  return `_${meta.join(" | ")}_`;
};
