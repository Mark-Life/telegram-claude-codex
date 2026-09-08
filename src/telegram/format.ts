import type { AgentError } from "../agent/errors";
import type { AgentEvent, ProviderCapabilities } from "../agent/types";

export const MAX_MSG_LENGTH = 4000;
export const EDIT_INTERVAL_MS = 1500;
export const DRAFT_INTERVAL_MS = 300;
export const TYPING_INTERVAL_MS = 5000;
/** A newline is only worth cutting at when it fills at least this much of a chunk. */
export const MIN_CHUNK_FILL_RATIO = 0.5;

/** What one streamed run reports back to the caller. */
export interface StreamResult {
  cost?: number;
  durationMs?: number;
  errorClass?: AgentError;
  messageId?: number;
  planPath?: string;
  sessionId?: string;
  totalTokens?: number;
  turns?: number;
}

/** A single variant of the normalized event union, selected by its `kind` tag. */
export type EventOf<K extends AgentEvent["kind"]> = Extract<
  AgentEvent,
  { kind: K }
>;

/** Split text into chunks that fit Telegram's length limit, breaking at newlines when possible */
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

/** Escape HTML special characters */
export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render tool lines as Telegram HTML, wrapping long lists in an expandable blockquote */
export const renderToolsHtml = (toolLines: string[]) => {
  const lines = toolLines.map((l) => `<i>${escapeHtml(l)}</i>`).join("\n");
  return toolLines.length >= 4
    ? `<blockquote expandable>${lines}</blockquote>`
    : lines;
};

/** Render thinking text as HTML (expandable blockquote if 4+ lines), tail-truncated to fit */
export const renderThinking = (text: string) => {
  let display = text;
  if (display.length > MAX_MSG_LENGTH - 200) {
    display = `...${display.slice(display.length - (MAX_MSG_LENGTH - 200))}`;
  }
  const escaped = escapeHtml(display);
  const html =
    escaped.split("\n").length >= 4
      ? `<blockquote expandable><i>${escaped}</i></blockquote>`
      : `<i>${escaped}</i>`;
  return { html, plain: display };
};

/** Build the metric suffix parts (duration/tokens/tool calls) for a finished sub-agent */
export const agentDoneParts = (event: EventOf<"agent_done">) => {
  const parts: string[] = [];
  if (event.durationMs !== undefined) {
    parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
  }
  if (event.totalTokens !== undefined) {
    parts.push(`${(event.totalTokens / 1000).toFixed(1)}k tokens`);
  }
  if (event.toolUses !== undefined) {
    parts.push(`${event.toolUses} tool call${event.toolUses !== 1 ? "s" : ""}`);
  }
  return parts;
};

/** Format the metadata footer as italic markdown, gating cost/turns by provider capabilities */
export const formatFooter = (
  projectName: string,
  result: StreamResult,
  capabilities: ProviderCapabilities,
  branchName?: string | null
) => {
  const meta: string[] = [];
  if (projectName) {
    meta.push(
      `Project: ${branchName ? `${projectName} [${branchName}]` : projectName}`
    );
  }
  if (capabilities.cost && result.cost !== undefined) {
    meta.push(`Cost: $${result.cost.toFixed(4)}`);
  }
  if (result.durationMs !== undefined) {
    meta.push(`Time: ${(result.durationMs / 1000).toFixed(1)}s`);
  }
  if (result.totalTokens !== undefined) {
    meta.push(`${(result.totalTokens / 1000).toFixed(1)}k tokens`);
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
