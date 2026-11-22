import type { ProviderCapabilities } from "@workspace/agent/types";
import { Effect } from "effect";

import {
  DRAFT_INTERVAL_MS,
  formatFooter,
  MAX_MSG_LENGTH,
  MIN_CHUNK_FILL_RATIO,
  renderThinking,
  renderToolsHtml,
} from "./format";
import type { StreamResult } from "./format";
import type { RenderPolicy } from "./render-policy";
import type { Route } from "./route";
import { dropTelegramFailure, sendRichSafe } from "./send";
import { TelegramBot } from "./telegram-bot";
import type { RichDraft } from "./telegram-bot";

export type MessageMode = "text" | "tools" | "thinking" | "none";

/** Mutable streaming context shared across the event handlers for one run. */
export interface StreamCtx {
  accumulated: string;
  capabilities: ProviderCapabilities;
  currentDraftId: number;
  // Each streaming phase gets its own non-zero draft id so the client renders
  // thinking/text/tools as separate previews instead of morphing one slot.
  draftSeq: number;
  lastEditTime: number;
  lastTextMessageId: number;
  mode: MessageMode;
  pendingEdit: boolean;
  policy: RenderPolicy;
  result: StreamResult;
  /** Chat and forum topic every message of this run goes to. */
  route: Route;
  /**
   * Model text already sent as a permanent message. The final `result` event
   * repeats the last agent message, so once this is set that text must neither
   * be sent again nor replace the text collected across the whole run.
   */
  textPersisted: boolean;
  thinkingText: string;
  toolLines: string[];
  /** The run answered and waits on background work: no typing meanwhile. */
  waiting: boolean;
  /**
   * A result came since the last answer went out with its footer: false
   * after a park, so a note that ends the wait does not repeat that footer.
   */
  footerDue: boolean;
  /** A footer went out on its own, with no text: one per run is enough. */
  footerSent: boolean;
}

/** Fresh streaming context for one run. */
export const initialStreamCtx = ({
  capabilities,
  policy,
  route,
}: Pick<StreamCtx, "capabilities" | "policy" | "route">): StreamCtx => ({
  accumulated: "",
  capabilities,
  currentDraftId: 0,
  draftSeq: 0,
  footerDue: true,
  footerSent: false,
  lastEditTime: 0,
  lastTextMessageId: 0,
  mode: "none",
  pendingEdit: false,
  policy,
  result: {},
  route,
  textPersisted: false,
  thinkingText: "",
  toolLines: [],
  waiting: false,
});

/** Advance to a fresh draft slot so the next phase renders as its own preview */
export const startDraft = (s: StreamCtx) => {
  s.draftSeq += 1;
  s.currentDraftId = s.draftSeq;
};

/**
 * Stream a draft into the current draft slot. A draft is superseded by the next
 * one, so a failure (logged at debug by TelegramBot) is dropped.
 */
const sendDraft = (s: StreamCtx, input: RichDraft) =>
  Effect.gen(function* () {
    const bot = yield* TelegramBot;
    yield* bot
      .sendRichDraftTo(s.route, s.currentDraftId, input)
      .pipe(Effect.orElseSucceed(() => false));
  });

/** Send the "Thinking..." placeholder draft for the current draft slot */
export const sendThinkingPlaceholder = (s: StreamCtx) =>
  sendDraft(s, { html: "<i>Thinking...</i>" });

/**
 * Stream the accumulated model text, persisting overflow chunks as they exceed
 * the limit. Without text drafts the overflow split still runs, so a long
 * answer never grows past what one message can carry.
 */
export const flushText = (s: StreamCtx, final = false) =>
  Effect.gen(function* () {
    if (!s.accumulated) {
      return;
    }
    if (s.policy.textDrafts) {
      const now = Date.now();
      if (!final && now - s.lastEditTime < DRAFT_INTERVAL_MS) {
        s.pendingEdit = true;
        return;
      }
      s.pendingEdit = false;
      s.lastEditTime = now;
    }

    if (s.accumulated.length > MAX_MSG_LENGTH) {
      const cutPoint = s.accumulated.lastIndexOf("\n", MAX_MSG_LENGTH);
      const splitAt =
        cutPoint > MAX_MSG_LENGTH * MIN_CHUNK_FILL_RATIO
          ? cutPoint
          : MAX_MSG_LENGTH;
      const chunk = s.accumulated.slice(0, splitAt);
      s.accumulated = s.accumulated.slice(splitAt);
      yield* sendRichSafe({ input: { markdown: chunk }, route: s.route });
      s.textPersisted = true;
    }
    if (!s.policy.textDrafts) {
      return;
    }
    yield* sendDraft(s, { markdown: s.accumulated });
  });

/** Stream the current tool lines as a draft */
export const flushTools = (s: StreamCtx) =>
  s.toolLines.length === 0
    ? Effect.void
    : sendDraft(s, { html: renderToolsHtml(s.toolLines) });

/** Stream the accumulated thinking text as a draft */
export const flushThinking = (s: StreamCtx, final = false) =>
  Effect.gen(function* () {
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
    yield* sendDraft(s, { html: renderThinking(s.thinkingText).html });
  });

/** Switch to a new mode, persisting the previous one as a permanent message */
export const switchMode = (s: StreamCtx, newMode: MessageMode) =>
  Effect.gen(function* () {
    if (s.mode === "text" && s.accumulated) {
      const sent = yield* sendRichSafe({
        input: { markdown: s.accumulated },
        route: s.route,
      });
      s.lastTextMessageId = sent.message_id;
      s.textPersisted = true;
    }
    if (
      s.policy.technicalPhases &&
      s.mode === "tools" &&
      s.toolLines.length > 0
    ) {
      yield* sendRichSafe({
        input: { html: renderToolsHtml(s.toolLines) },
        plain: s.toolLines.join("\n"),
        route: s.route,
      });
    }
    if (s.policy.technicalPhases && s.mode === "thinking" && s.thinkingText) {
      const { html, plain } = renderThinking(s.thinkingText);
      yield* sendRichSafe({ input: { html }, plain, route: s.route });
    }
    s.mode = newMode;
    s.accumulated = "";
    s.toolLines = [];
    s.thinkingText = "";
  });

/** Flush any edit that was deferred by the draft-rate throttle */
export const flushPending = (s: StreamCtx) =>
  Effect.gen(function* () {
    if (s.pendingEdit && s.mode === "text") {
      yield* dropTelegramFailure(flushText(s));
    }
    if (s.pendingEdit && s.mode === "thinking") {
      yield* flushThinking(s);
    }
  });

/**
 * Persist any trailing text and metadata footer once the event stream ends,
 * or once an answer is out and the run waits on background work.
 */
export const finalizeStream = (
  s: StreamCtx,
  projectName: string,
  branchName?: string | null
) =>
  Effect.gen(function* () {
    const footer =
      s.policy.footer && s.footerDue
        ? formatFooter(projectName, s.result, s.capabilities, branchName)
        : "";
    if (s.accumulated) {
      const display = footer ? `${s.accumulated}\n\n${footer}` : s.accumulated;
      const sent = yield* sendRichSafe({
        input: { markdown: display },
        route: s.route,
      });
      s.lastTextMessageId = sent.message_id;
    } else if (footer && !s.lastTextMessageId && !s.footerSent) {
      yield* sendRichSafe({ input: { markdown: footer }, route: s.route });
      s.footerSent = true;
    }
    // A run that waits on background work finalizes each answer: what was
    // sent must not go out again.
    s.accumulated = "";
    s.result.messageId = s.lastTextMessageId || undefined;
  });
