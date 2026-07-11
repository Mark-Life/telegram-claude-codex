import {
  type Options,
  query,
  type SDKMessage,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { AppConfig } from "../config";
import { runtime } from "../runtime";
import {
  clearSessionCache,
  getSessionProject,
  listAllSessions,
} from "./claude-history";
import { readExecutorMcpServers } from "./executor-mcp";
import type { AgentEvent, AgentProvider, RunOptions } from "./types";

/** The raw Anthropic stream event carried by an SDK partial-assistant message. */
type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];
type ContentBlockStart = Extract<
  StreamEvent,
  { type: "content_block_start" }
>["content_block"];
type ContentBlockDelta = Extract<
  StreamEvent,
  { type: "content_block_delta" }
>["delta"];
/** One content block of a complete (non-partial) assistant message. */
type AssistantBlock = Extract<
  SDKMessage,
  { type: "assistant" }
>["message"]["content"][number];
type SystemMessage = Extract<SDKMessage, { type: "system" }>;
type ResultMessage = Extract<SDKMessage, { type: "result" }>;

/** Field on a tool's input that holds its short human-readable summary */
const TOOL_INPUT_FIELD: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
};

/** Truncate a string to `max` chars, appending an ellipsis when clipped */
const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 3)}...` : value;

/** Format a tool's (already-parsed) input object into a short description */
const formatToolInput = (name: string, input: Record<string, unknown>) => {
  if (name === "Bash") {
    return truncate(input.command ? String(input.command) : "", 80);
  }
  const field = TOOL_INPUT_FIELD[name];
  return field && input[field] ? String(input[field]) : "";
};

/** Sum the token counts on a result usage object; undefined when none present. */
const totalTokensFrom = (usage: ResultMessage["usage"]) => {
  const counts = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : undefined;
};

/**
 * Mutable state threaded through the partial-message parser: which block type is
 * currently open (to route deltas), the thinking block's wall-clock start (the
 * SDK reports no thinking duration), and the last `.claude/plans/` write seen
 * (the planPath surfaced when ExitPlanMode fires).
 */
interface ParserState {
  currentBlockType: "text" | "thinking" | null;
  lastPlanPath: string;
  thinkingStartTime: number;
}

/** Open a text/thinking block; other block types reset routing (deltas ignored). */
function* handleContentBlockStart(
  state: ParserState,
  block: ContentBlockStart
): Generator<AgentEvent> {
  if (block.type === "text") {
    state.currentBlockType = "text";
  } else if (block.type === "thinking") {
    state.currentBlockType = "thinking";
    state.thinkingStartTime = Date.now();
    yield { kind: "thinking_start" };
  } else {
    state.currentBlockType = null;
  }
}

/** Route a content_block_delta to the open block's stream. */
function* handleContentBlockDelta(
  state: ParserState,
  delta: ContentBlockDelta
): Generator<AgentEvent> {
  if (delta.type === "text_delta" && state.currentBlockType === "text") {
    yield { kind: "text_delta", text: delta.text };
  } else if (
    delta.type === "thinking_delta" &&
    state.currentBlockType === "thinking" &&
    delta.thinking
  ) {
    yield { kind: "thinking_delta", text: delta.thinking };
  }
  // input_json_delta / signature_delta: ignored (tool input comes from the
  // complete assistant message, which already carries a parsed input object).
}

/** Close the open block, emitting thinking_done with the measured duration. */
function* handleContentBlockStop(state: ParserState): Generator<AgentEvent> {
  if (state.currentBlockType === "thinking") {
    yield {
      kind: "thinking_done",
      durationMs: Date.now() - state.thinkingStartTime,
    };
  }
  state.currentBlockType = null;
}

/** Dispatch a partial-message stream event to the matching block handler. */
function* handlePartialEvent(
  state: ParserState,
  event: StreamEvent
): Generator<AgentEvent> {
  if (event.type === "content_block_start") {
    yield* handleContentBlockStart(state, event.content_block);
  } else if (event.type === "content_block_delta") {
    yield* handleContentBlockDelta(state, event.delta);
  } else if (event.type === "content_block_stop") {
    yield* handleContentBlockStop(state);
  }
}

/** Emit tool_use for a completed tool block and track the plan-ready convention. */
function* handleToolUseBlock(
  state: ParserState,
  block: Extract<AssistantBlock, { type: "tool_use" }>
): Generator<AgentEvent> {
  const input = (block.input ?? {}) as Record<string, unknown>;
  yield {
    kind: "tool_use",
    name: block.name,
    input: formatToolInput(block.name, input),
  };
  if (
    block.name === "Write" &&
    typeof input.file_path === "string" &&
    input.file_path.includes(".claude/plans/")
  ) {
    state.lastPlanPath = input.file_path;
  }
  if (block.name === "ExitPlanMode" && state.lastPlanPath) {
    yield { kind: "plan_ready", planPath: state.lastPlanPath };
    state.lastPlanPath = "";
  }
}

/**
 * Map a complete assistant message's content blocks. tool_use (and plan_ready)
 * always emit here; text/thinking are only emitted as a fallback when no partial
 * stream was seen, since the streamed deltas already carried them.
 */
function* handleAssistantBlocks(
  state: ParserState,
  content: AssistantBlock[],
  sawStreamEvents: boolean
): Generator<AgentEvent> {
  for (const block of content) {
    if (block.type === "tool_use") {
      yield* handleToolUseBlock(state, block);
    } else if (!sawStreamEvents && block.type === "text" && block.text) {
      yield { kind: "text_delta", text: block.text };
    } else if (!sawStreamEvents && block.type === "thinking") {
      yield { kind: "thinking_start" };
      if (block.thinking) {
        yield { kind: "thinking_delta", text: block.thinking };
      }
      yield { kind: "thinking_done", durationMs: 0 };
    }
  }
}

/** Translate a system message (init + subagent task lifecycle) into events. */
function* handleSystemMessage(msg: SystemMessage): Generator<AgentEvent> {
  if (msg.subtype === "init") {
    yield { kind: "session_init", sessionId: msg.session_id };
  } else if (msg.subtype === "task_started" && !msg.skip_transcript) {
    yield {
      kind: "agent_started",
      taskId: msg.task_id,
      description: msg.description,
    };
  } else if (msg.subtype === "task_notification") {
    yield {
      kind: "agent_done",
      taskId: msg.task_id,
      description: msg.summary,
      status: msg.status,
      durationMs: msg.usage?.duration_ms,
      totalTokens: msg.usage?.total_tokens,
      toolUses: msg.usage?.tool_uses,
    };
  }
}

/**
 * Map a terminal result message. The success variant carries the result text;
 * error variants carry no text and additionally surface an `error` event. Cost
 * degrades to undefined (never a fabricated 0) when the SDK omits it.
 */
function* handleResultMessage(msg: ResultMessage): Generator<AgentEvent> {
  yield {
    kind: "result",
    text: msg.subtype === "success" ? msg.result : "",
    sessionId: msg.session_id,
    cost: Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : undefined,
    durationMs: msg.duration_ms,
    turns: msg.num_turns,
    totalTokens: totalTokensFrom(msg.usage),
  };
  if (msg.subtype !== "success") {
    yield { kind: "error", message: msg.errors.join("; ") || msg.subtype };
  }
}

const SCRIPT_DIR = new URL("../../scripts", import.meta.url).pathname;

/** Build the system-prompt snippet telling Claude how to send files to `chatId`. */
const buildFileSystemPrompt = (chatId: number) => {
  const scriptPath = `${SCRIPT_DIR}/send-file-to-user.ts`;
  return [
    "You can send files to the user's Telegram chat.",
    `To send a file, run: bun ${scriptPath} --path <absolute-file-path> --chat ${chatId}`,
    "Only use this when the user explicitly asks you to send/share/download a file.",
    "The script blocks .env and other sensitive files automatically.",
  ].join(" ");
};

/**
 * Build the pure `query()` params for a run. Keeps Claude Code's default system
 * prompt (preset) with the file-send instructions appended, streams partial
 * messages for token-level text/thinking, and wires a fresh AbortController to
 * the caller's signal so the runner's scope-close tears the SDK subprocess down.
 * No apiKey is set: subscription/local auth stays the default. `settings` is the
 * boot-resolved hardening layer (AppConfig.claudeSettings) and wins over any
 * ambient ~/.claude/settings.json. `mcpServers` carries the Executor MCP server
 * when configured (undefined otherwise, so the key is simply omitted).
 */
const buildQuery = (
  opts: RunOptions,
  signal: AbortSignal,
  settings: Settings,
  mcpServers: Options["mcpServers"]
) => {
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), {
    once: true,
  });
  const options: Options = {
    cwd: opts.projectDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController,
    includePartialMessages: true,
    settings,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildFileSystemPrompt(opts.chatId),
    },
  };
  if (mcpServers) {
    options.mcpServers = mcpServers;
  }
  if (opts.sessionId) {
    options.resume = opts.sessionId;
  }
  return { prompt: opts.prompt, options };
};

/** Boot-resolved per-run inputs (hardening settings + Executor MCP wiring). */
const readRunConfig = Effect.all({
  settings: Effect.map(AppConfig, (c) => c.claudeSettings),
  mcpServers: readExecutorMcpServers,
});

/**
 * Drive the Claude Agent SDK for one run, normalizing its message stream into
 * AgentEvents. Text/thinking are sourced from streamed partial messages;
 * tool_use and plan_ready from the complete assistant messages; subagent
 * lifecycle from task_started/task_notification system messages.
 */
async function* run(
  opts: RunOptions,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  const state: ParserState = {
    currentBlockType: null,
    lastPlanPath: "",
    thinkingStartTime: 0,
  };
  let sawStreamEvents = false;

  const { settings, mcpServers } = runtime.runSync(readRunConfig);
  for await (const msg of query(
    buildQuery(opts, signal, settings, mcpServers)
  )) {
    if (msg.type === "stream_event") {
      sawStreamEvents = true;
      yield* handlePartialEvent(state, msg.event);
    } else if (msg.type === "assistant") {
      yield* handleAssistantBlocks(state, msg.message.content, sawStreamEvents);
    } else if (msg.type === "result") {
      yield* handleResultMessage(msg);
    } else if (msg.type === "system") {
      yield* handleSystemMessage(msg);
    }
  }
}

/** Claude Code provider definition (Agent SDK) */
export const claudeProvider: AgentProvider = {
  id: "claude",
  kind: "sdk",
  displayName: "Claude Code",
  capabilities: {
    planMode: true,
    thinking: true,
    cost: true,
    subagents: true,
  },
  run,
  listAllSessions,
  getSessionProject,
  clearSessionCache,
};
