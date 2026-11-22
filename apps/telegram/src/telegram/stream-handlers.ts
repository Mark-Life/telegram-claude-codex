import { isReplaced, isRestartCut } from "@workspace/agent";
import type { AgentEvent } from "@workspace/agent/types";
import { Effect } from "effect";

import { t } from "../i18n";
import { errorDetailMarkdown, errorSentence } from "./errors";
import { renderThinking } from "./format";
import type { EventOf } from "./format";
import { dropTelegramFailure, sendRichSafe } from "./send";
import {
  flushText,
  flushThinking,
  flushTools,
  sendThinkingPlaceholder,
  startDraft,
  switchMode,
} from "./stream-state";
import type { StreamCtx } from "./stream-state";

/** Persist the previous assistant message and begin a distinct Telegram message. */
const handleTextMessage = (s: StreamCtx, event: EventOf<"text_message">) =>
  Effect.gen(function* () {
    yield* switchMode(s, "text");
    startDraft(s);
    s.accumulated = event.text;
    s.result.text =
      s.result.text === undefined
        ? event.text
        : `${s.result.text}\n\n${event.text}`;
    yield* dropTelegramFailure(flushText(s));
  });

/** Append a tool-use line, switching into tools mode when needed */
const handleToolUse = (s: StreamCtx, event: EventOf<"tool_use">) =>
  Effect.gen(function* () {
    if (!s.policy.technicalPhases) {
      return;
    }
    if (s.mode !== "tools") {
      yield* switchMode(s, "tools");
      startDraft(s);
    }
    const label = event.input ? `${event.name}: ${event.input}` : event.name;
    s.toolLines.push(label);
    yield* flushTools(s);
  });

/** Whether this run shows thinking at all: policy and provider both allow it. */
const showsThinking = (s: StreamCtx) =>
  s.policy.technicalPhases && s.capabilities.thinking;

/** Begin a thinking phase (gated on the provider's thinking capability) */
const handleThinkingStart = (s: StreamCtx) =>
  Effect.gen(function* () {
    if (!showsThinking(s)) {
      return;
    }
    yield* switchMode(s, "thinking");
    startDraft(s);
    yield* sendThinkingPlaceholder(s);
  });

/** Append a thinking delta, opening a thinking phase if one is not active */
const handleThinkingDelta = (s: StreamCtx, event: EventOf<"thinking_delta">) =>
  Effect.gen(function* () {
    if (!showsThinking(s)) {
      return;
    }
    if (s.mode !== "thinking") {
      yield* switchMode(s, "thinking");
      startDraft(s);
      yield* sendThinkingPlaceholder(s);
    }
    s.thinkingText += event.text;
    yield* flushThinking(s);
  });

/** Finalize the current thinking phase as a permanent message */
const handleThinkingDone = (s: StreamCtx) =>
  Effect.gen(function* () {
    if (!showsThinking(s)) {
      return;
    }
    if (s.mode === "thinking" && s.thinkingText) {
      const { html, plain } = renderThinking(s.thinkingText);
      yield* sendRichSafe({ input: { html }, plain, route: s.route });
    }
    s.thinkingText = "";
    s.mode = "none";
  });

/** Record final run metadata and seed text output when no text reached the chat */
const handleResult = (s: StreamCtx, event: EventOf<"result">) =>
  Effect.gen(function* () {
    s.result.sessionId = event.sessionId;
    s.footerDue = true;
    s.result.cost = event.cost;
    s.result.durationMs = event.durationMs;
    s.result.turns = event.turns;
    s.result.totalTokens = event.totalTokens;
    if (!(s.accumulated || s.textPersisted) && event.text) {
      if (s.mode !== "text") {
        yield* switchMode(s, "text");
      }
      s.accumulated = event.text;
      s.result.text = event.text;
    }
  });

/**
 * Append the friendly sentence a failed run turns into, and the provider's
 * own message under it. The full message goes to the log.
 */
const handleError = (s: StreamCtx, event: EventOf<"error">) =>
  Effect.gen(function* () {
    if (s.mode !== "text") {
      yield* switchMode(s, "text");
    }
    if (event.class) {
      s.result.errorClass = event.class;
    }
    yield* Effect.logError("run error").pipe(
      Effect.annotateLogs({ message: event.message })
    );
    // The user moved the conversation on; the run has nothing to say.
    if (isReplaced(event.class)) {
      return;
    }
    // A parked run the restart cut is resumed once the bot is back.
    const restartCut = isRestartCut(event.class);
    const copy = restartCut
      ? t().status.restartCut
      : errorSentence(event.class);
    s.accumulated += s.accumulated ? `\n\n_${copy}_` : copy;
    if (!restartCut) {
      s.accumulated += errorDetailMarkdown(event.class, event.message);
    }
  });

/** Route one normalized event to its handler; succeeds true when streaming should stop. */
export const dispatchEvent = (s: StreamCtx, event: AgentEvent) =>
  Effect.gen(function* () {
    switch (event.kind) {
      case "text_message": {
        yield* handleTextMessage(s, event);
        break;
      }
      case "tool_use": {
        yield* handleToolUse(s, event);
        break;
      }
      case "thinking_start": {
        yield* handleThinkingStart(s);
        break;
      }
      case "thinking_delta": {
        yield* handleThinkingDelta(s, event);
        break;
      }
      case "thinking_done": {
        yield* handleThinkingDone(s);
        break;
      }
      case "session_init": {
        s.result.sessionId = event.sessionId;
        break;
      }
      case "plan_ready": {
        s.result.planPath = event.planPath;
        return true;
      }
      case "result": {
        yield* handleResult(s, event);
        break;
      }
      case "error": {
        yield* handleError(s, event);
        break;
      }
      // Background work needs the footer, so `streamToTelegram` handles it.
      case "background": {
        break;
      }
      // The live sub-agent status, which `streamToTelegram` keeps.
      case "agent_started":
      case "agent_progress":
      case "agent_finished": {
        break;
      }
      // Recorded for `/context` by the run's start (`startPromptRun`).
      case "context": {
        break;
      }
      // Compaction is one-shot and reported by /compact, never inside a run stream.
      case "compact_done":
      case "compact_failed": {
        break;
      }
      default: {
        break;
      }
    }
    return false;
  });
