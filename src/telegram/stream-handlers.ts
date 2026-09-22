import { classifyOutcome } from "../agent/errors";
import type { AgentEvent } from "../agent/types";
import type { EventOf } from "./format";
import { agentDoneParts, escapeHtml, renderThinking } from "./format";
import { ignoreError, safeSendRichMessage } from "./send";
import type { StreamCtx } from "./stream-state";
import {
  flushText,
  flushThinking,
  flushTools,
  sendThinkingPlaceholder,
  startDraft,
  switchMode,
} from "./stream-state";

/**
 * Append a model text delta. Opens a fresh chat message when text mode is not
 * active, or when the previous assistant message already ended — the delta then
 * belongs to a new reply, and `switchMode` persists the old one first.
 */
const handleTextDelta = async (s: StreamCtx, event: EventOf<"text_delta">) => {
  if (s.mode !== "text" || s.pendingBreak) {
    await switchMode(s, "text");
    startDraft(s);
  }
  s.accumulated += event.text;
  await flushText(s).catch(ignoreError);
};

/**
 * Close the current assistant message. The text stays in `accumulated` so a run
 * that ends here still carries the footer; only a following delta turns the
 * boundary into a separate chat message.
 */
const handleTextEnd = (s: StreamCtx) => {
  if (s.mode === "text") {
    s.pendingBreak = true;
  }
};

/** Append a tool-use line, switching into tools mode when needed */
const handleToolUse = async (s: StreamCtx, event: EventOf<"tool_use">) => {
  if (!s.policy.technicalPhases) {
    return;
  }
  if (s.mode !== "tools") {
    await switchMode(s, "tools");
    startDraft(s);
  }
  const label = event.input ? `${event.name}: ${event.input}` : event.name;
  s.toolLines.push(label);
  await flushTools(s).catch(ignoreError);
};

/** Begin a thinking phase (gated on the render policy and the provider capability) */
const handleThinkingStart = async (s: StreamCtx) => {
  if (!(s.policy.technicalPhases && s.capabilities.thinking)) {
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
  if (!(s.policy.technicalPhases && s.capabilities.thinking)) {
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
  if (!(s.policy.technicalPhases && s.capabilities.thinking)) {
    return;
  }
  if (s.mode === "thinking" && s.thinkingText) {
    const { html, plain } = renderThinking(s.thinkingText);
    await safeSendRichMessage({
      ctx: s.ctx,
      input: { html },
      plain,
      route: s.route,
    });
  }
  s.thinkingText = "";
  s.mode = "none";
};

/** Record a started sub-agent as a tool line (gated on the subagents capability) */
const handleAgentStarted = async (
  s: StreamCtx,
  event: EventOf<"agent_started">
) => {
  if (!(s.policy.technicalPhases && s.capabilities.subagents)) {
    return;
  }
  if (s.mode !== "tools") {
    await switchMode(s, "tools");
    startDraft(s);
  }
  s.toolLines.push(`⏳ Agent: ${event.description}`);
  await flushTools(s).catch(ignoreError);
};

/** Emit a permanent message summarizing a finished sub-agent */
const handleAgentDone = async (s: StreamCtx, event: EventOf<"agent_done">) => {
  if (!(s.policy.technicalPhases && s.capabilities.subagents)) {
    return;
  }
  const icon = event.status === "completed" ? "✅" : "❌";
  const parts = agentDoneParts(event);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const line = `${icon} Agent: ${event.description}${suffix}`;
  await safeSendRichMessage({
    ctx: s.ctx,
    input: { html: `<i>${escapeHtml(line)}</i>` },
    plain: line,
    route: s.route,
  });
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

/**
 * Append a human-readable error to the text output, switching into text mode
 * first. Never gated by the render policy: a failed run always says so.
 */
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
export const dispatchEvent = async (s: StreamCtx, event: AgentEvent) => {
  switch (event.kind) {
    case "text_delta":
      await handleTextDelta(s, event);
      break;
    case "text_end":
      handleTextEnd(s);
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
