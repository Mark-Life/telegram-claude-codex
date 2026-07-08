import {
  clearSessionCache,
  getSessionProject,
  listAllSessions,
} from "./claude-history";
import type { AgentEvent, AgentProvider, RunOptions } from "./types";

type ContentBlockStart =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "thinking"; thinking: string };

type ContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string };

type StreamEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | {
      type: "system";
      subtype: "task_started";
      task_id: string;
      description: string;
    }
  | {
      type: "system";
      subtype: "task_notification";
      task_id: string;
      status: string;
      summary: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    }
  | {
      type: "stream_event";
      event: {
        type: "content_block_start";
        index: number;
        content_block: ContentBlockStart;
      };
    }
  | {
      type: "stream_event";
      event: {
        type: "content_block_delta";
        index: number;
        delta: ContentBlockDelta;
      };
    }
  | {
      type: "stream_event";
      event: { type: "content_block_stop"; index: number };
    }
  | { type: "stream_event"; event: { type: string } }
  | {
      type: "assistant";
      message: { content: Array<{ type: string; text?: string }> };
      session_id: string;
    }
  | {
      type: "result";
      subtype: string;
      is_error: boolean;
      result: string;
      session_id: string;
      total_cost_usd: number;
      duration_ms: number;
      num_turns: number;
    };

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

/** Format tool input into a short description */
function formatToolInput(name: string, input: Record<string, unknown>) {
  if (name === "Bash") {
    return truncate(input.command ? String(input.command) : "", 80);
  }
  const field = TOOL_INPUT_FIELD[name];
  return field && input[field] ? String(input[field]) : "";
}

/** Mutable state threaded through the stream-json parser */
interface ParserState {
  currentBlockType: "text" | "tool_use" | "thinking" | null;
  currentToolName: string;
  hasEmittedContent: boolean;
  lastPlanPath: string;
  thinkingStartTime: number;
  toolInputJson: string;
}

type StreamEventInner = Extract<StreamEvent, { type: "stream_event" }>["event"];
type SystemEvent = Extract<StreamEvent, { type: "system" }>;
type ResultEvent = Extract<StreamEvent, { type: "result" }>;

/** Handle a content_block_start event, updating block-tracking state */
function* handleContentBlockStart(
  state: ParserState,
  block: ContentBlockStart
): Generator<AgentEvent> {
  if (block.type === "text") {
    state.currentBlockType = "text";
  } else if (block.type === "tool_use") {
    state.currentBlockType = "tool_use";
    state.currentToolName = block.name;
    state.toolInputJson = "";
  } else if (block.type === "thinking") {
    state.currentBlockType = "thinking";
    state.thinkingStartTime = Date.now();
    state.hasEmittedContent = true;
    yield { kind: "thinking_start" };
  }
}

/** Handle a content_block_delta event for the current block type */
function* handleContentBlockDelta(
  state: ParserState,
  delta: ContentBlockDelta
): Generator<AgentEvent> {
  if (delta.type === "text_delta" && state.currentBlockType === "text") {
    state.hasEmittedContent = true;
    yield { kind: "text_delta", text: delta.text };
  } else if (
    delta.type === "input_json_delta" &&
    state.currentBlockType === "tool_use"
  ) {
    state.toolInputJson += delta.partial_json;
  } else if (
    delta.type === "thinking_delta" &&
    state.currentBlockType === "thinking" &&
    delta.thinking
  ) {
    yield { kind: "thinking_delta", text: delta.thinking };
  }
  // signature_delta: ignored
}

/** Emit tool_use (and any plan_ready) events when a tool block completes */
function* handleToolUseStop(state: ParserState): Generator<AgentEvent> {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(state.toolInputJson);
  } catch {
    // partial/invalid tool JSON; fall back to empty input
  }
  const shortInput = formatToolInput(state.currentToolName, input);
  state.hasEmittedContent = true;
  yield { kind: "tool_use", name: state.currentToolName, input: shortInput };
  if (
    state.currentToolName === "Write" &&
    typeof input.file_path === "string" &&
    input.file_path.includes(".claude/plans/")
  ) {
    state.lastPlanPath = input.file_path;
  }
  if (state.currentToolName === "ExitPlanMode" && state.lastPlanPath) {
    yield { kind: "plan_ready", planPath: state.lastPlanPath };
    state.lastPlanPath = "";
  }
}

/** Handle a content_block_stop event, closing out the current block */
function* handleContentBlockStop(state: ParserState): Generator<AgentEvent> {
  if (state.currentBlockType === "tool_use") {
    yield* handleToolUseStop(state);
  } else if (state.currentBlockType === "thinking") {
    const elapsed = Date.now() - state.thinkingStartTime;
    yield { kind: "thinking_done", durationMs: elapsed };
  }
  state.currentBlockType = null;
}

/** Dispatch a stream_event's inner event to the matching block handler */
function* handleStreamEvent(
  state: ParserState,
  event: StreamEventInner
): Generator<AgentEvent> {
  if (event.type === "content_block_start" && "content_block" in event) {
    yield* handleContentBlockStart(state, event.content_block);
  } else if (event.type === "content_block_delta" && "delta" in event) {
    yield* handleContentBlockDelta(state, event.delta);
  } else if (event.type === "content_block_stop") {
    yield* handleContentBlockStop(state);
  }
}

/** Translate a system event (init/task lifecycle) into AgentEvents */
function* handleSystemEvent(parsed: SystemEvent): Generator<AgentEvent> {
  if (parsed.subtype === "init") {
    yield { kind: "session_init", sessionId: parsed.session_id };
  } else if (parsed.subtype === "task_started") {
    yield {
      kind: "agent_started",
      taskId: parsed.task_id,
      description: parsed.description,
    };
  } else if (parsed.subtype === "task_notification") {
    yield {
      kind: "agent_done",
      taskId: parsed.task_id,
      description: parsed.summary,
      status: parsed.status,
      durationMs: parsed.usage?.duration_ms,
      totalTokens: parsed.usage?.total_tokens,
      toolUses: parsed.usage?.tool_uses,
    };
  }
}

/** Map a final result event into a normalized result AgentEvent */
const toResultEvent = (parsed: ResultEvent): AgentEvent => ({
  kind: "result",
  text: parsed.result,
  sessionId: parsed.session_id,
  cost: parsed.total_cost_usd,
  durationMs: parsed.duration_ms,
  turns: parsed.num_turns,
});

/** Route a single parsed stream event to its handler */
function* dispatchEvent(
  state: ParserState,
  parsed: StreamEvent
): Generator<AgentEvent> {
  if (parsed.type === "stream_event") {
    yield* handleStreamEvent(state, parsed.event);
  } else if (parsed.type === "system") {
    yield* handleSystemEvent(parsed);
  } else if (parsed.type === "result") {
    yield toResultEvent(parsed);
  }
}

/** Create a stateful stream-json parser */
function createStreamParser() {
  const state: ParserState = {
    hasEmittedContent: false,
    currentBlockType: null,
    currentToolName: "",
    toolInputJson: "",
    thinkingStartTime: 0,
    lastPlanPath: "",
  };

  return function* parseStreamLines(lines: string[]): Generator<AgentEvent> {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      yield* dispatchEvent(state, parsed);
    }
  };
}

const SCRIPT_DIR = new URL("../../scripts", import.meta.url).pathname;

/** Build system prompt snippet telling Claude how to send files to the user */
function buildFileSystemPrompt() {
  const scriptPath = `${SCRIPT_DIR}/send-file-to-user.ts`;
  return [
    "You can send files to the user's Telegram chat.",
    `To send a file, run: bun ${scriptPath} <absolute-file-path>`,
    "Only use this when the user explicitly asks you to send/share/download a file.",
    "The script blocks .env and other sensitive files automatically.",
  ].join(" ");
}

/** Build the claude CLI arguments for a run */
function buildArgs(opts: RunOptions) {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    buildFileSystemPrompt(),
  ];
  if (opts.sessionId) {
    args.push("-r", opts.sessionId);
  }
  return args;
}

/** Build the claude CLI environment: strip CLAUDECODE, inject TELEGRAM_CHAT_ID */
function buildEnv(opts: RunOptions, base: Record<string, string | undefined>) {
  const { CLAUDECODE: _, ...restEnv } = base;
  return { ...restEnv, TELEGRAM_CHAT_ID: String(opts.chatId) } as Record<
    string,
    string
  >;
}

/** Claude Code provider definition */
export const claudeProvider: AgentProvider = {
  id: "claude",
  command: "claude",
  displayName: "Claude Code",
  capabilities: {
    planMode: true,
    thinking: true,
    cost: true,
    subagents: true,
  },
  buildArgs,
  buildEnv,
  createParser: createStreamParser,
  listAllSessions,
  getSessionProject,
  clearSessionCache,
};
