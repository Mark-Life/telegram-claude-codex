import type { Context } from "grammy";
import { Marked } from "marked";
import type { AgentEvent, ProviderCapabilities } from "./agent/types";

const MAX_MSG_LENGTH = 4000;
const EDIT_INTERVAL_MS = 1500;

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

const DRAFT_INTERVAL_MS = 300;
const TYPING_INTERVAL_MS = 5000;

/** Escape HTML special characters */
function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Marked instance with Telegram-compatible HTML renderer */
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const escaped = escapeHtml(text);
      return lang
        ? `\n<pre><code class="language-${lang}">${escaped}</code></pre>\n`
        : `\n<pre>${escaped}</pre>\n`;
    },
    blockquote({ tokens }) {
      return `<blockquote>${this.parser.parse(tokens).trim()}</blockquote>\n`;
    },
    heading({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>\n`;
    },
    hr() {
      return "\n";
    },
    list({ items, ordered }) {
      return `${items
        .map((item, i) => {
          const bullet = ordered ? `${i + 1}. ` : "- ";
          const content = this.parser.parse(item.tokens).trim();
          return `${bullet}${content}`;
        })
        .join("\n")}\n`;
    },
    listitem(item) {
      return this.parser.parse(item.tokens).trim();
    },
    paragraph({ tokens }) {
      return `${this.parser.parseInline(tokens)}\n`;
    },
    table({ header, rows }) {
      const headerText = header
        .map((cell) => this.parser.parseInline(cell.tokens))
        .join(" | ");
      const rowTexts = rows.map((row) =>
        row.map((cell) => this.parser.parseInline(cell.tokens)).join(" | ")
      );
      return `<pre>${escapeHtml(headerText)}\n${escapeHtml(rowTexts.join("\n"))}</pre>\n`;
    },
    tablerow({ text }) {
      return text;
    },
    tablecell(token) {
      return this.parser.parseInline(token.tokens);
    },
    strong({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>`;
    },
    em({ tokens }) {
      return `<i>${this.parser.parseInline(tokens)}</i>`;
    },
    codespan({ text }) {
      return `<code>${escapeHtml(text)}</code>`;
    },
    br() {
      return "\n";
    },
    del({ tokens }) {
      return `<s>${this.parser.parseInline(tokens)}</s>`;
    },
    link({ href, tokens }) {
      return `<a href="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ text }) {
      return text;
    },
    space() {
      return "";
    },
    html({ text }) {
      return escapeHtml(text);
    },
    def() {
      return "";
    },
    checkbox({ checked }) {
      return checked ? "[x] " : "[ ] ";
    },
    text(token) {
      if ("tokens" in token && token.tokens) {
        return this.parser.parseInline(token.tokens);
      }
      return escapeHtml(token.text);
    },
  },
});

/** Convert Markdown to Telegram-compatible HTML using a proper parser */
function markdownToTelegramHtml(md: string) {
  return (marked.parse(md) as string).trim();
}

/** Try editing with HTML, fall back to plain text. Returns true if HTML succeeded. */
async function safeEditMessage(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  rawText?: string
) {
  const displayText = text || "...";
  try {
    await ctx.api.editMessageText(chatId, messageId, displayText, {
      parse_mode: "HTML",
    });
    return true;
  } catch (err: any) {
    if (
      err?.description?.includes("message is not modified") ||
      err?.description?.includes("message can't be edited")
    ) {
      return true;
    }
    try {
      await ctx.api.editMessageText(chatId, messageId, rawText ?? displayText);
      return false;
    } catch (err2: any) {
      if (
        !(
          err2?.description?.includes("message is not modified") ||
          err2?.description?.includes("message can't be edited")
        )
      ) {
        throw err2;
      }
      return false;
    }
  }
}

/** Send a draft update. Falls back to plain text on HTML parse failure. Swallows "not modified" errors. */
async function safeSendDraft(
  ctx: Context,
  chatId: number,
  draftId: number,
  html: string,
  rawText?: string
) {
  const displayText = html || "...";
  try {
    await ctx.api.sendMessageDraft(chatId, draftId, displayText, {
      parse_mode: "HTML",
    });
  } catch (err: any) {
    if (err?.description?.includes("not modified")) {
      return;
    }
    try {
      await ctx.api.sendMessageDraft(chatId, draftId, rawText ?? displayText);
    } catch (err2: any) {
      if (!err2?.description?.includes("not modified")) {
        throw err2;
      }
    }
  }
}

/** Send a permanent message with HTML fallback. Returns the Message or throws on real errors. */
async function safeSendMessage(
  ctx: Context,
  chatId: number,
  html: string,
  rawText?: string
) {
  const displayText = html || "...";
  try {
    return await ctx.api.sendMessage(chatId, displayText, {
      parse_mode: "HTML",
    });
  } catch {
    return await ctx.api.sendMessage(chatId, rawText ?? displayText);
  }
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

/** Stream agent events into separate Telegram messages by type, gated by the active provider's capabilities */
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
  let messageId = 0;
  let accumulated = "";
  let lastEditTime = 0;
  let pendingEdit = false;
  let toolLines: string[] = [];
  let thinkingText = "";
  let lastTextMessageId = 0;
  let useDrafts: boolean | null = null;
  const draftId = chatId;

  /** Send a new Telegram message and track its ID */
  const sendNew = async (text: string, parseMode?: "HTML") => {
    const opts: Record<string, unknown> = {};
    if (parseMode) {
      opts.parse_mode = parseMode;
    }
    const sent = await ctx.api.sendMessage(chatId, text, opts);
    messageId = sent.message_id;
    lastEditTime = 0;
    pendingEdit = false;
    return sent;
  };

  /** Finalize the current text message (split-safe edit) */
  const flushText = async (final = false) => {
    if (!accumulated) {
      return;
    }

    const interval = useDrafts ? DRAFT_INTERVAL_MS : EDIT_INTERVAL_MS;
    const now = Date.now();
    if (!final && now - lastEditTime < interval) {
      pendingEdit = true;
      return;
    }
    pendingEdit = false;
    lastEditTime = now;

    let text = accumulated;
    if (text.length > MAX_MSG_LENGTH) {
      const cutPoint = text.lastIndexOf("\n", MAX_MSG_LENGTH);
      const splitAt =
        cutPoint > MAX_MSG_LENGTH * 0.5 ? cutPoint : MAX_MSG_LENGTH;
      const chunk = text.slice(0, splitAt);
      accumulated = text.slice(splitAt);

      if (useDrafts) {
        await safeSendMessage(
          ctx,
          chatId,
          markdownToTelegramHtml(chunk),
          chunk
        );
      } else {
        await safeEditMessage(
          ctx,
          chatId,
          messageId,
          markdownToTelegramHtml(chunk),
          chunk
        );
        await sendNew("...");
      }
      text = accumulated;
    }

    if (useDrafts) {
      await safeSendDraft(
        ctx,
        chatId,
        draftId,
        markdownToTelegramHtml(text),
        text
      );
    } else {
      await safeEditMessage(
        ctx,
        chatId,
        messageId,
        markdownToTelegramHtml(text),
        text
      );
    }
  };

  /** Update the tools message with current tool lines */
  const flushTools = async () => {
    if (toolLines.length === 0) {
      return;
    }
    const lines = toolLines.map((l) => `<i>${escapeHtml(l)}</i>`).join("\n");
    const text =
      toolLines.length >= 4
        ? `<blockquote expandable>${lines}</blockquote>`
        : lines;
    await safeEditMessage(ctx, chatId, messageId, text, toolLines.join("\n"));
  };

  /** Render thinking text as HTML (expandable blockquote if 4+ lines) */
  const renderThinkingHtml = (text: string) => {
    let display = text;
    if (display.length > MAX_MSG_LENGTH - 200) {
      display = `...${display.slice(display.length - (MAX_MSG_LENGTH - 200))}`;
    }
    const escaped = escapeHtml(display);
    const html =
      escaped.split("\n").length >= 4
        ? `<blockquote expandable><i>${escaped}</i></blockquote>`
        : `<i>${escaped}</i>`;
    return { html, plainText: display };
  };

  /** Update the thinking message with accumulated thinking text */
  const flushThinking = async (final = false) => {
    if (!thinkingText) {
      return;
    }

    const interval = useDrafts ? DRAFT_INTERVAL_MS : EDIT_INTERVAL_MS;
    const now = Date.now();
    if (!final && now - lastEditTime < interval) {
      pendingEdit = true;
      return;
    }
    pendingEdit = false;
    lastEditTime = now;

    const { html, plainText } = renderThinkingHtml(thinkingText);
    if (useDrafts) {
      await safeSendDraft(ctx, chatId, draftId, html, plainText);
    } else {
      await safeEditMessage(ctx, chatId, messageId, html, plainText);
    }
  };

  /** Switch to a new mode, finalizing the previous one */
  const switchMode = async (newMode: MessageMode) => {
    if (mode === "text" && accumulated) {
      if (useDrafts) {
        const sent = await safeSendMessage(
          ctx,
          chatId,
          markdownToTelegramHtml(accumulated),
          accumulated
        );
        lastTextMessageId = sent?.message_id ?? 0;
      } else {
        await flushText(true);
        lastTextMessageId = messageId;
      }
    }
    if (mode === "tools") {
      await flushTools();
    }
    if (mode === "thinking" && thinkingText) {
      if (useDrafts) {
        const { html, plainText } = renderThinkingHtml(thinkingText);
        await safeSendMessage(ctx, chatId, html, plainText);
      } else {
        await flushThinking(true);
      }
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
          if (useDrafts === null) {
            try {
              await ctx.api.sendMessageDraft(chatId, draftId, "...", {
                parse_mode: "HTML",
              });
              useDrafts = true;
            } catch {
              useDrafts = false;
              await sendNew("...");
            }
          } else if (!useDrafts) {
            await sendNew("...");
          }
        }
        accumulated += event.text;
        await flushText().catch(() => {});
      } else if (event.kind === "tool_use") {
        if (mode !== "tools") {
          mode = await switchMode("tools");
          await sendNew("...");
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
        if (useDrafts) {
          await safeSendDraft(
            ctx,
            chatId,
            draftId,
            "<i>Thinking...</i>",
            "Thinking..."
          );
        } else {
          await sendNew("<i>Thinking...</i>", "HTML");
        }
      } else if (event.kind === "thinking_delta") {
        if (!capabilities.thinking) {
          continue;
        }
        if (mode !== "thinking") {
          mode = await switchMode("thinking");
          if (useDrafts) {
            await safeSendDraft(
              ctx,
              chatId,
              draftId,
              "<i>Thinking...</i>",
              "Thinking..."
            );
          } else {
            await sendNew("<i>Thinking...</i>", "HTML");
          }
        }
        thinkingText += event.text;
        await flushThinking().catch(() => {});
      } else if (event.kind === "thinking_done") {
        if (!capabilities.thinking) {
          continue;
        }
        if (mode === "thinking" && thinkingText) {
          if (useDrafts) {
            const { html, plainText } = renderThinkingHtml(thinkingText);
            await safeSendMessage(ctx, chatId, html, plainText);
          } else {
            await flushThinking(true);
          }
        }
        thinkingText = "";
        mode = "none";
      } else if (event.kind === "agent_started") {
        if (!capabilities.subagents) {
          continue;
        }
        if (mode !== "tools") {
          mode = await switchMode("tools");
          await sendNew("...");
        }
        toolLines.push(`\u23F3 Agent: ${event.description}`);
        await flushTools().catch(() => {});
      } else if (event.kind === "agent_done") {
        if (!capabilities.subagents) {
          continue;
        }
        const icon = event.status === "completed" ? "\u2705" : "\u274C";
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
        await safeSendMessage(ctx, chatId, `<i>${escapeHtml(line)}</i>`, line);
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
            if (!useDrafts) {
              await sendNew("...");
            }
          }
          accumulated = event.text;
        }
      } else if (event.kind === "error") {
        if (mode !== "text") {
          mode = await switchMode("text");
          if (!useDrafts) {
            await sendNew("...");
          }
        }
        accumulated += `\n\n[Error: ${event.message}]`;
      }
    }
  } finally {
    clearInterval(editTimer);
    clearInterval(typingTimer);
  }

  // Final edit on the last text message with footer
  if (mode === "text" && accumulated && !useDrafts) {
    lastTextMessageId = messageId;
  }

  const footer = formatFooter(projectName, result, capabilities, branchName);

  if (accumulated && (useDrafts || lastTextMessageId)) {
    const html = markdownToTelegramHtml(accumulated);
    const display = footer ? `${html}\n\n${footer}` : html;

    if (useDrafts) {
      const sent = await safeSendMessage(
        ctx,
        chatId,
        display || "...",
        accumulated
      );
      lastTextMessageId = sent?.message_id ?? 0;
    } else {
      const ok = await safeEditMessage(
        ctx,
        chatId,
        lastTextMessageId,
        display || "..."
      ).catch(() => false);
      if (!ok && footer) {
        await ctx.api
          .sendMessage(chatId, footer, { parse_mode: "HTML" })
          .catch(() => {});
      }
    }
  } else if (!lastTextMessageId && footer) {
    await ctx.api
      .sendMessage(chatId, footer, { parse_mode: "HTML" })
      .catch(() => {});
  }

  result.messageId = lastTextMessageId || undefined;

  return result;
}

/** Format metadata footer as HTML, gating cost/turns by provider capabilities */
function formatFooter(
  projectName: string,
  result: StreamResult,
  capabilities: ProviderCapabilities,
  branchName?: string | null
) {
  const meta: string[] = [];
  if (projectName) {
    meta.push(
      `Project: ${branchName ? `${escapeHtml(projectName)} [${escapeHtml(branchName)}]` : escapeHtml(projectName)}`
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
  return meta.length > 0 ? `<i>${meta.join(" | ")}</i>` : "";
}
