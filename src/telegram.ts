import type { Context } from "grammy";
import type { AgentEvent, ProviderCapabilities } from "./agent/types";

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

/** Stream a partial rich message. Swallows transient draft errors (drafts are ephemeral). */
async function safeSendRichDraft(
  ctx: Context,
  chatId: number,
  draftId: number,
  input: RichInput
) {
  try {
    await ctx.api.sendRichMessageDraft(chatId, draftId, input);
  } catch {
    // dropped draft updates are harmless
  }
}

/** Persist a rich message. Falls back to plain text on failure. */
async function safeSendRichMessage(
  ctx: Context,
  chatId: number,
  input: RichInput,
  plain?: string
) {
  try {
    return await ctx.api.sendRichMessage(chatId, input);
  } catch {
    const fallback =
      plain ?? ("markdown" in input ? input.markdown : input.html);
    return await ctx.api.sendMessage(chatId, fallback || "...");
  }
}

/** Send raw markdown as a rich message (used for one-shot content like plans). */
export function sendRichMarkdown(
  ctx: Context,
  chatId: number,
  markdown: string
) {
  return safeSendRichMessage(ctx, chatId, { markdown: markdown || "..." });
}

interface StreamResult {
  cost?: number;
  durationMs?: number;
  messageId?: number;
  planPath?: string;
  sessionId?: string;
  turns?: number;
}

interface StreamOptions {
  branchName?: string | null;
}

type MessageMode = "text" | "tools" | "thinking" | "none";

/** Stream agent events into separate Telegram rich messages by type, gated by the active provider's capabilities */
export async function streamToTelegram(
  ctx: Context,
  events: AsyncGenerator<AgentEvent>,
  projectName: string,
  capabilities: ProviderCapabilities,
  options?: StreamOptions
): Promise<StreamResult> {
  const chatId = ctx.chat!.id;
  const branchName = options?.branchName;
  const result: StreamResult = {};

  let mode: MessageMode = "none";
  let accumulated = "";
  let lastEditTime = 0;
  let pendingEdit = false;
  let toolLines: string[] = [];
  let thinkingText = "";
  let lastTextMessageId = 0;
  // Each streaming phase gets its own non-zero draft id so the client renders
  // thinking/text/tools as separate previews instead of morphing one slot.
  let draftSeq = 0;
  let currentDraftId = 0;
  const startDraft = () => {
    draftSeq += 1;
    currentDraftId = draftSeq;
  };

  /** Render the current tool lines as Telegram HTML */
  const renderToolsHtml = () => {
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

  /** Stream the accumulated model text, persisting overflow chunks as they exceed the limit */
  const flushText = async (final = false) => {
    if (!accumulated) {
      return;
    }
    const now = Date.now();
    if (!final && now - lastEditTime < DRAFT_INTERVAL_MS) {
      pendingEdit = true;
      return;
    }
    pendingEdit = false;
    lastEditTime = now;

    if (accumulated.length > MAX_MSG_LENGTH) {
      const cutPoint = accumulated.lastIndexOf("\n", MAX_MSG_LENGTH);
      const splitAt =
        cutPoint > MAX_MSG_LENGTH * 0.5 ? cutPoint : MAX_MSG_LENGTH;
      const chunk = accumulated.slice(0, splitAt);
      accumulated = accumulated.slice(splitAt);
      await safeSendRichMessage(ctx, chatId, { markdown: chunk });
    }
    await safeSendRichDraft(ctx, chatId, currentDraftId, {
      markdown: accumulated,
    });
  };

  /** Stream the current tool lines as a draft */
  const flushTools = async () => {
    if (toolLines.length === 0) {
      return;
    }
    await safeSendRichDraft(ctx, chatId, currentDraftId, {
      html: renderToolsHtml(),
    });
  };

  /** Stream the accumulated thinking text as a draft */
  const flushThinking = async (final = false) => {
    if (!thinkingText) {
      return;
    }
    const now = Date.now();
    if (!final && now - lastEditTime < DRAFT_INTERVAL_MS) {
      pendingEdit = true;
      return;
    }
    pendingEdit = false;
    lastEditTime = now;
    await safeSendRichDraft(ctx, chatId, currentDraftId, {
      html: renderThinking(thinkingText).html,
    });
  };

  /** Switch to a new mode, persisting the previous one as a permanent message */
  const switchMode = async (newMode: MessageMode) => {
    if (mode === "text" && accumulated) {
      const sent = await safeSendRichMessage(ctx, chatId, {
        markdown: accumulated,
      });
      lastTextMessageId = sent?.message_id ?? 0;
    }
    if (mode === "tools" && toolLines.length > 0) {
      await safeSendRichMessage(
        ctx,
        chatId,
        { html: renderToolsHtml() },
        toolLines.join("\n")
      );
    }
    if (mode === "thinking" && thinkingText) {
      const { html, plain } = renderThinking(thinkingText);
      await safeSendRichMessage(ctx, chatId, { html }, plain);
    }
    mode = newMode;
    accumulated = "";
    toolLines = [];
    thinkingText = "";
    return newMode;
  };

  const editTimer = setInterval(async () => {
    if (pendingEdit && mode === "text") {
      await flushText().catch(() => {});
    }
    if (pendingEdit && mode === "thinking") {
      await flushThinking().catch(() => {});
    }
  }, EDIT_INTERVAL_MS);

  const typingTimer = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  }, TYPING_INTERVAL_MS);
  ctx.api.sendChatAction(chatId, "typing").catch(() => {});

  try {
    for await (const event of events) {
      if (event.kind === "text_delta") {
        if (mode !== "text") {
          mode = await switchMode("text");
          startDraft();
        }
        accumulated += event.text;
        await flushText().catch(() => {});
      } else if (event.kind === "tool_use") {
        if (mode !== "tools") {
          mode = await switchMode("tools");
          startDraft();
        }
        const label = event.input
          ? `${event.name}: ${event.input}`
          : event.name;
        toolLines.push(label);
        await flushTools().catch(() => {});
      } else if (event.kind === "thinking_start") {
        if (!capabilities.thinking) {
          continue;
        }
        mode = await switchMode("thinking");
        startDraft();
        await safeSendRichDraft(ctx, chatId, currentDraftId, {
          html: "<i>Thinking...</i>",
        });
      } else if (event.kind === "thinking_delta") {
        if (!capabilities.thinking) {
          continue;
        }
        if (mode !== "thinking") {
          mode = await switchMode("thinking");
          startDraft();
          await safeSendRichDraft(ctx, chatId, currentDraftId, {
            html: "<i>Thinking...</i>",
          });
        }
        thinkingText += event.text;
        await flushThinking().catch(() => {});
      } else if (event.kind === "thinking_done") {
        if (!capabilities.thinking) {
          continue;
        }
        if (mode === "thinking" && thinkingText) {
          const { html, plain } = renderThinking(thinkingText);
          await safeSendRichMessage(ctx, chatId, { html }, plain);
        }
        thinkingText = "";
        mode = "none";
      } else if (event.kind === "agent_started") {
        if (!capabilities.subagents) {
          continue;
        }
        if (mode !== "tools") {
          mode = await switchMode("tools");
          startDraft();
        }
        toolLines.push(`⏳ Agent: ${event.description}`);
        await flushTools().catch(() => {});
      } else if (event.kind === "agent_done") {
        if (!capabilities.subagents) {
          continue;
        }
        const icon = event.status === "completed" ? "✅" : "❌";
        let line = `${icon} Agent: ${event.description}`;
        const parts: string[] = [];
        if (event.durationMs !== undefined) {
          parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
        }
        if (event.totalTokens !== undefined) {
          parts.push(`${(event.totalTokens / 1000).toFixed(1)}k tokens`);
        }
        if (event.toolUses !== undefined) {
          parts.push(
            `${event.toolUses} tool call${event.toolUses !== 1 ? "s" : ""}`
          );
        }
        if (parts.length > 0) {
          line += ` (${parts.join(", ")})`;
        }
        await safeSendRichMessage(
          ctx,
          chatId,
          { html: `<i>${escapeHtml(line)}</i>` },
          line
        );
      } else if (event.kind === "session_init") {
        result.sessionId = event.sessionId;
      } else if (event.kind === "plan_ready") {
        result.planPath = event.planPath;
        break;
      } else if (event.kind === "result") {
        result.sessionId = event.sessionId;
        result.cost = event.cost;
        result.durationMs = event.durationMs;
        result.turns = event.turns;
        if (!accumulated && event.text) {
          if (mode !== "text") {
            mode = await switchMode("text");
          }
          accumulated = event.text;
        }
      } else if (event.kind === "error") {
        if (mode !== "text") {
          mode = await switchMode("text");
        }
        accumulated += `\n\n[Error: ${event.message}]`;
      }
    }
  } finally {
    clearInterval(editTimer);
    clearInterval(typingTimer);
  }

  const footer = formatFooter(projectName, result, capabilities, branchName);

  if (accumulated) {
    const display = footer ? `${accumulated}\n\n${footer}` : accumulated;
    const sent = await safeSendRichMessage(ctx, chatId, { markdown: display });
    lastTextMessageId = sent?.message_id ?? 0;
  } else if (footer && !lastTextMessageId) {
    await safeSendRichMessage(ctx, chatId, { markdown: footer });
  }

  result.messageId = lastTextMessageId || undefined;

  return result;
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
