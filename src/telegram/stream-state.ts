import type { Context } from "grammy";
import type { ProviderCapabilities } from "../agent/types";
import type { StreamResult } from "./format";
import {
  DRAFT_INTERVAL_MS,
  formatFooter,
  MAX_MSG_LENGTH,
  MIN_CHUNK_FILL_RATIO,
  renderThinking,
  renderToolsHtml,
} from "./format";
import type { RenderPolicy } from "./render-policy";
import type { Route } from "./route";
import { ignoreError, safeSendRichDraft, safeSendRichMessage } from "./send";

export type MessageMode = "text" | "tools" | "thinking" | "none";

/** Mutable streaming context shared across the event handlers for one run. */
export interface StreamCtx {
  accumulated: string;
  capabilities: ProviderCapabilities;
  ctx: Context;
  currentDraftId: number;
  // Each streaming phase gets its own non-zero draft id so the client renders
  // thinking/text/tools as separate previews instead of morphing one slot.
  draftSeq: number;
  lastEditTime: number;
  lastTextMessageId: number;
  mode: MessageMode;
  /**
   * The last assistant message ended; the next text delta opens a new chat
   * message instead of extending the current one.
   */
  pendingBreak: boolean;
  pendingEdit: boolean;
  /** How much of the run reaches the chat. */
  policy: RenderPolicy;
  result: StreamResult;
  /** Chat and forum topic every message of this run goes to. */
  route: Route;
  thinkingText: string;
  toolLines: string[];
}

/** Fresh streaming context for one run. */
export const makeStreamCtx = ({
  capabilities,
  ctx,
  policy,
  route,
}: Pick<
  StreamCtx,
  "capabilities" | "ctx" | "policy" | "route"
>): StreamCtx => ({
  accumulated: "",
  capabilities,
  ctx,
  currentDraftId: 0,
  draftSeq: 0,
  lastEditTime: 0,
  lastTextMessageId: 0,
  mode: "none",
  pendingBreak: false,
  pendingEdit: false,
  policy,
  result: {},
  route,
  thinkingText: "",
  toolLines: [],
});

/** Advance to a fresh draft slot so the next phase renders as its own preview */
export const startDraft = (s: StreamCtx) => {
  s.draftSeq += 1;
  s.currentDraftId = s.draftSeq;
};

/** Send the "Thinking..." placeholder draft for the current draft slot */
export const sendThinkingPlaceholder = (s: StreamCtx) =>
  safeSendRichDraft({
    ctx: s.ctx,
    draftId: s.currentDraftId,
    input: { html: "<i>Thinking...</i>" },
    route: s.route,
  });

/**
 * Stream the accumulated model text, persisting overflow chunks as they exceed
 * the limit. Without text drafts the overflow split still runs, so a long answer
 * never grows past what one message can carry.
 */
export const flushText = async (s: StreamCtx, final = false) => {
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
    await safeSendRichMessage({
      ctx: s.ctx,
      input: { markdown: chunk },
      route: s.route,
    });
  }
  if (!s.policy.textDrafts) {
    return;
  }
  await safeSendRichDraft({
    ctx: s.ctx,
    draftId: s.currentDraftId,
    input: { markdown: s.accumulated },
    route: s.route,
  });
};

/** Stream the current tool lines as a draft */
export const flushTools = async (s: StreamCtx) => {
  if (s.toolLines.length === 0) {
    return;
  }
  await safeSendRichDraft({
    ctx: s.ctx,
    draftId: s.currentDraftId,
    input: { html: renderToolsHtml(s.toolLines) },
    route: s.route,
  });
};

/** Stream the accumulated thinking text as a draft */
export const flushThinking = async (s: StreamCtx, final = false) => {
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
  await safeSendRichDraft({
    ctx: s.ctx,
    draftId: s.currentDraftId,
    input: { html: renderThinking(s.thinkingText).html },
    route: s.route,
  });
};

/** Switch to a new mode, persisting the previous one as a permanent message */
export const switchMode = async (s: StreamCtx, newMode: MessageMode) => {
  if (s.mode === "text" && s.accumulated) {
    const sent = await safeSendRichMessage({
      ctx: s.ctx,
      input: { markdown: s.accumulated },
      route: s.route,
    });
    s.lastTextMessageId = sent?.message_id ?? 0;
  }
  if (
    s.policy.technicalPhases &&
    s.mode === "tools" &&
    s.toolLines.length > 0
  ) {
    await safeSendRichMessage({
      ctx: s.ctx,
      input: { html: renderToolsHtml(s.toolLines) },
      plain: s.toolLines.join("\n"),
      route: s.route,
    });
  }
  if (s.policy.technicalPhases && s.mode === "thinking" && s.thinkingText) {
    const { html, plain } = renderThinking(s.thinkingText);
    await safeSendRichMessage({
      ctx: s.ctx,
      input: { html },
      plain,
      route: s.route,
    });
  }
  s.mode = newMode;
  s.pendingBreak = false;
  s.accumulated = "";
  s.toolLines = [];
  s.thinkingText = "";
};

/** Flush any edit that was deferred by the draft-rate throttle */
export const flushPending = async (s: StreamCtx) => {
  if (s.pendingEdit && s.mode === "text") {
    await flushText(s).catch(ignoreError);
  }
  if (s.pendingEdit && s.mode === "thinking") {
    await flushThinking(s).catch(ignoreError);
  }
};

/** Persist any trailing text and the metadata footer once the event stream ends */
export const finalizeStream = async (
  s: StreamCtx,
  projectName: string,
  branchName?: string | null
) => {
  const footer = s.policy.footer
    ? formatFooter(projectName, s.result, s.capabilities, branchName)
    : "";
  if (s.accumulated) {
    const display = footer ? `${s.accumulated}\n\n${footer}` : s.accumulated;
    const sent = await safeSendRichMessage({
      ctx: s.ctx,
      input: { markdown: display },
      route: s.route,
    });
    s.lastTextMessageId = sent?.message_id ?? 0;
  } else if (footer && !s.lastTextMessageId) {
    await safeSendRichMessage({
      ctx: s.ctx,
      input: { markdown: footer },
      route: s.route,
    });
  }
  s.result.messageId = s.lastTextMessageId || undefined;
};
