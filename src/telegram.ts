import { Effect } from "effect";
import type { Context } from "grammy";
import type { AgentError } from "./agent/errors";
import { classifyOutcome } from "./agent/errors";
import type { AgentEvent, ProviderCapabilities } from "./agent/types";
import { runtime } from "./runtime";

const MAX_MSG_LENGTH = 4000;
const EDIT_INTERVAL_MS = 1500;
const DRAFT_INTERVAL_MS = 300;
const TYPING_INTERVAL_MS = 5000;

/** Split text into chunks that fit within Telegram's message length limit, breaking at newline boundaries when possible */
export function splitText(text: string, maxLen = MAX_MSG_LENGTH) {
  if (text.length <= maxLen) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cutPoint = remaining.lastIndexOf("\n", maxLen);
    const splitAt = cutPoint > maxLen * 0.5 ? cutPoint : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

/** Escape HTML special characters */
function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A rich message body: model text as raw markdown, or bot chrome as Telegram HTML */
type RichInput = { markdown: string } | { html: string };

/** No-op rejection handler: transient Telegram draft/typing errors are non-fatal and safe to drop. */
const ignoreError = () => {
  /* dropped draft/typing updates are harmless */
};

/**
 * Wrap a fire-and-forget Telegram send/edit so a rejection is swallowed but
 * still surfaces at debug level (annotated with the call-site label + error
 * class). Used only for high-signal sites where a rejection means a real
 * Telegram outage/rate-limit — not the silent UI cleanups (typing/draft flush).
 */
const bestEffort =
  (label: string) =>
  <T>(p: Promise<T>): Promise<T | undefined> =>
    p.catch((e) => {
      runtime
        .runPromise(
          Effect.logDebug(`${label} failed`).pipe(
            Effect.annotateLogs({
              errorClass: (e as Error)?.name ?? "unknown",
              label,
            })
          )
        )
        .catch(ignoreError);
      return undefined;
    });

/** Stream a partial rich message. Swallows transient draft errors (drafts are ephemeral). */
async function safeSendRichDraft(
  ctx: Context,
  chatId: number,
  draftId: number,
  input: RichInput
) {
  await bestEffort("sendRichMessageDraft")(
    ctx.api.sendRichMessageDraft(chatId, draftId, input)
  );
}

/** Persist a rich message. Falls back to plain text on failure. */
async function safeSendRichMessage(
  ctx: Context,
  chatId: number,
  input: RichInput,
  plain?: string
) {
  const sent = await bestEffort("sendRichMessage")(
    ctx.api.sendRichMessage(chatId, input)
  );
  if (sent) {
    return sent;
  }
  const fallback = plain ?? ("markdown" in input ? input.markdown : input.html);
  return await ctx.api.sendMessage(chatId, fallback || "...");
}

/** Send raw markdown as a rich message (used for one-shot content like plans). */
export function sendRichMarkdown(
  ctx: Context,
  chatId: number,
  markdown: string
) {
  return safeSendRichMessage(ctx, chatId, { markdown: markdown || "..." });
}

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

interface StreamOptions {
  branchName?: string | null;
}

type MessageMode = "text" | "tools" | "thinking" | "none";

/** A single variant of the normalized event union, selected by its `kind` tag. */
type EventOf<K extends AgentEvent["kind"]> = Extract<AgentEvent, { kind: K }>;

/** Mutable streaming context shared across the event handlers for one run. */
interface StreamCtx {
  accumulated: string;
  capabilities: ProviderCapabilities;
  chatId: number;
  ctx: Context;
  currentDraftId: number;
  // Each streaming phase gets its own non-zero draft id so the client renders
  // thinking/text/tools as separate previews instead of morphing one slot.
  draftSeq: number;
  lastEditTime: number;
  lastTextMessageId: number;
  mode: MessageMode;
  pendingEdit: boolean;
  result: StreamResult;
  thinkingText: string;
  toolLines: string[];
}

/** Render the given tool lines as Telegram HTML, wrapping long lists in an expandable blockquote */
const renderToolsHtml = (toolLines: string[]) => {
  const lines = toolLines.map((l) => `<i>${escapeHtml(l)}</i>`).join("\n");
  return toolLines.length >= 4
    ? `<blockquote expandable>${lines}</blockquote>`
    : lines;
};

/** Render thinking text as HTML (expandable blockquote if 4+ lines), tail-truncated to fit */
const renderThinking = (text: string) => {
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

/** Advance to a fresh draft slot so the next phase renders as its own preview */
const startDraft = (s: StreamCtx) => {
  s.draftSeq += 1;
  s.currentDraftId = s.draftSeq;
};

/** Send the "Thinking..." placeholder draft for the current draft slot */
const sendThinkingPlaceholder = (s: StreamCtx) =>
  safeSendRichDraft(s.ctx, s.chatId, s.currentDraftId, {
    html: "<i>Thinking...</i>",
  });

/** Stream the accumulated model text, persisting overflow chunks as they exceed the limit */
const flushText = async (s: StreamCtx, final = false) => {
  if (!s.accumulated) {
    return;
  }
  const now = Date.now();
  if (!final && now - s.lastEditTime < DRAFT_INTERVAL_MS) {
    s.pendingEdit = true;
    return;
  }
  s.pendingEdit = false;
  s.lastEditTime = now;

  if (s.accumulated.length > MAX_MSG_LENGTH) {
    const cutPoint = s.accumulated.lastIndexOf("\n", MAX_MSG_LENGTH);
    const splitAt = cutPoint > MAX_MSG_LENGTH * 0.5 ? cutPoint : MAX_MSG_LENGTH;
    const chunk = s.accumulated.slice(0, splitAt);
    s.accumulated = s.accumulated.slice(splitAt);
    await safeSendRichMessage(s.ctx, s.chatId, { markdown: chunk });
  }
  await safeSendRichDraft(s.ctx, s.chatId, s.currentDraftId, {
    markdown: s.accumulated,
  });
};

/** Stream the current tool lines as a draft */
const flushTools = async (s: StreamCtx) => {
  if (s.toolLines.length === 0) {
    return;
  }
  await safeSendRichDraft(s.ctx, s.chatId, s.currentDraftId, {
    html: renderToolsHtml(s.toolLines),
  });
};

/** Stream the accumulated thinking text as a draft */
const flushThinking = async (s: StreamCtx, final = false) => {
  if (!s.thinkingText) {
    return;
  }
  const now = Date.now();
  if (!final && now - s.lastEditTime < DRAFT_INTERVAL_MS) {
    s.pendingEdit = true;
    return;
  }
  s.pendingEdit = false;
  s.lastEditTime = now;
  await safeSendRichDraft(s.ctx, s.chatId, s.currentDraftId, {
    html: renderThinking(s.thinkingText).html,
  });
};

/** Switch to a new mode, persisting the previous one as a permanent message */
const switchMode = async (s: StreamCtx, newMode: MessageMode) => {
  if (s.mode === "text" && s.accumulated) {
    const sent = await safeSendRichMessage(s.ctx, s.chatId, {
      markdown: s.accumulated,
    });
    s.lastTextMessageId = sent?.message_id ?? 0;
  }
  if (s.mode === "tools" && s.toolLines.length > 0) {
    await safeSendRichMessage(
      s.ctx,
      s.chatId,
      { html: renderToolsHtml(s.toolLines) },
      s.toolLines.join("\n")
    );
  }
  if (s.mode === "thinking" && s.thinkingText) {
    const { html, plain } = renderThinking(s.thinkingText);
    await safeSendRichMessage(s.ctx, s.chatId, { html }, plain);
  }
  s.mode = newMode;
  s.accumulated = "";
  s.toolLines = [];
  s.thinkingText = "";
};

/** Append a model text delta, switching into text mode when needed */
const handleTextDelta = async (s: StreamCtx, event: EventOf<"text_delta">) => {
  if (s.mode !== "text") {
    await switchMode(s, "text");
    startDraft(s);
  }
  s.accumulated += event.text;
  await flushText(s).catch(ignoreError);
};

/** Append a tool-use line, switching into tools mode when needed */
const handleToolUse = async (s: StreamCtx, event: EventOf<"tool_use">) => {
  if (s.mode !== "tools") {
    await switchMode(s, "tools");
    startDraft(s);
  }
  const label = event.input ? `${event.name}: ${event.input}` : event.name;
  s.toolLines.push(label);
  await flushTools(s).catch(ignoreError);
};

/** Begin a thinking phase (gated on the provider's thinking capability) */
const handleThinkingStart = async (s: StreamCtx) => {
  if (!s.capabilities.thinking) {
    return;
  }
  await switchMode(s, "thinking");
  startDraft(s);
  await sendThinkingPlaceholder(s);
};

/** Append a thinking delta, opening a thinking phase if one is not active */
const handleThinkingDelta = async (
  s: StreamCtx,
  event: EventOf<"thinking_delta">
) => {
  if (!s.capabilities.thinking) {
    return;
  }
  if (s.mode !== "thinking") {
    await switchMode(s, "thinking");
    startDraft(s);
    await sendThinkingPlaceholder(s);
  }
  s.thinkingText += event.text;
  await flushThinking(s).catch(ignoreError);
};

/** Finalize the current thinking phase as a permanent message */
const handleThinkingDone = async (s: StreamCtx) => {
  if (!s.capabilities.thinking) {
    return;
  }
  if (s.mode === "thinking" && s.thinkingText) {
    const { html, plain } = renderThinking(s.thinkingText);
    await safeSendRichMessage(s.ctx, s.chatId, { html }, plain);
  }
  s.thinkingText = "";
  s.mode = "none";
};

/** Record a started sub-agent as a tool line (gated on the subagents capability) */
const handleAgentStarted = async (
  s: StreamCtx,
  event: EventOf<"agent_started">
) => {
  if (!s.capabilities.subagents) {
    return;
  }
  if (s.mode !== "tools") {
    await switchMode(s, "tools");
    startDraft(s);
  }
  s.toolLines.push(`⏳ Agent: ${event.description}`);
  await flushTools(s).catch(ignoreError);
};

/** Build the metric suffix parts (duration/tokens/tool calls) for a finished sub-agent */
const agentDoneParts = (event: EventOf<"agent_done">) => {
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

/** Emit a permanent message summarizing a finished sub-agent */
const handleAgentDone = async (s: StreamCtx, event: EventOf<"agent_done">) => {
  if (!s.capabilities.subagents) {
    return;
  }
  const icon = event.status === "completed" ? "✅" : "❌";
  const parts = agentDoneParts(event);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const line = `${icon} Agent: ${event.description}${suffix}`;
  await safeSendRichMessage(
    s.ctx,
    s.chatId,
    { html: `<i>${escapeHtml(line)}</i>` },
    line
  );
};

/** Record final run metadata and seed text output when nothing streamed yet */
const handleResult = async (s: StreamCtx, event: EventOf<"result">) => {
  s.result.sessionId = event.sessionId;
  s.result.cost = event.cost;
  s.result.durationMs = event.durationMs;
  s.result.turns = event.turns;
  s.result.totalTokens = event.totalTokens;
  if (!s.accumulated && event.text) {
    if (s.mode !== "text") {
      await switchMode(s, "text");
    }
    s.accumulated = event.text;
  }
};

/** Append a human-readable error to the text output, switching into text mode first */
const handleError = async (s: StreamCtx, event: EventOf<"error">) => {
  if (s.mode !== "text") {
    await switchMode(s, "text");
  }
  if (event.class) {
    s.result.errorClass = event.class;
  }
  const copy = event.class ? classifyOutcome(event.class).copy : event.message;
  s.accumulated += s.accumulated ? `\n\n_${copy}_` : copy;
};

/** Route one normalized event to its handler; returns true when streaming should stop. */
const dispatchEvent = async (s: StreamCtx, event: AgentEvent) => {
  switch (event.kind) {
    case "text_delta":
      await handleTextDelta(s, event);
      break;
    case "tool_use":
      await handleToolUse(s, event);
      break;
    case "thinking_start":
      await handleThinkingStart(s);
      break;
    case "thinking_delta":
      await handleThinkingDelta(s, event);
      break;
    case "thinking_done":
      await handleThinkingDone(s);
      break;
    case "agent_started":
      await handleAgentStarted(s, event);
      break;
    case "agent_done":
      await handleAgentDone(s, event);
      break;
    case "session_init":
      s.result.sessionId = event.sessionId;
      break;
    case "plan_ready":
      s.result.planPath = event.planPath;
      return true;
    case "result":
      await handleResult(s, event);
      break;
    case "error":
      await handleError(s, event);
      break;
    default:
      break;
  }
  return false;
};

/** Flush any edit that was deferred by the draft-rate throttle */
const flushPending = async (s: StreamCtx) => {
  if (s.pendingEdit && s.mode === "text") {
    await flushText(s).catch(ignoreError);
  }
  if (s.pendingEdit && s.mode === "thinking") {
    await flushThinking(s).catch(ignoreError);
  }
};

/** Persist any trailing text and metadata footer once the event stream ends */
const finalizeStream = async (
  s: StreamCtx,
  projectName: string,
  branchName?: string | null
) => {
  const footer = formatFooter(
    projectName,
    s.result,
    s.capabilities,
    branchName
  );
  if (s.accumulated) {
    const display = footer ? `${s.accumulated}\n\n${footer}` : s.accumulated;
    const sent = await safeSendRichMessage(s.ctx, s.chatId, {
      markdown: display,
    });
    s.lastTextMessageId = sent?.message_id ?? 0;
  } else if (footer && !s.lastTextMessageId) {
    await safeSendRichMessage(s.ctx, s.chatId, { markdown: footer });
  }
  s.result.messageId = s.lastTextMessageId || undefined;
};

/** Stream agent events into separate Telegram rich messages by type, gated by the active provider's capabilities */
export async function streamToTelegram(
  ctx: Context,
  events: AsyncGenerator<AgentEvent>,
  projectName: string,
  capabilities: ProviderCapabilities,
  options?: StreamOptions
): Promise<StreamResult> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return {};
  }
  const branchName = options?.branchName;
  const s: StreamCtx = {
    ctx,
    chatId,
    capabilities,
    result: {},
    mode: "none",
    accumulated: "",
    lastEditTime: 0,
    pendingEdit: false,
    toolLines: [],
    thinkingText: "",
    lastTextMessageId: 0,
    draftSeq: 0,
    currentDraftId: 0,
  };

  const editTimer = setInterval(() => {
    flushPending(s).catch(ignoreError);
  }, EDIT_INTERVAL_MS);

  const typingTimer = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing").catch(ignoreError);
  }, TYPING_INTERVAL_MS);
  ctx.api.sendChatAction(chatId, "typing").catch(ignoreError);

  try {
    for await (const event of events) {
      const stop = await dispatchEvent(s, event);
      if (stop) {
        break;
      }
    }
  } finally {
    // Cleared on every exit path: normal end, plan-ready break, a thrown
    // error, and interrupts — which arrive as an in-stream `error` event
    // (consumed by handleError, not thrown), so the loop still exits here.
    clearInterval(editTimer);
    clearInterval(typingTimer);
  }

  await finalizeStream(s, projectName, branchName);
  return s.result;
}

/** Format metadata footer as italic markdown, gating cost/turns by provider capabilities */
function formatFooter(
  projectName: string,
  result: StreamResult,
  capabilities: ProviderCapabilities,
  branchName?: string | null
) {
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
    const secs = (result.durationMs / 1000).toFixed(1);
    meta.push(`Time: ${secs}s`);
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
}
