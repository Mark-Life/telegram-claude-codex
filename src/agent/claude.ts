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

/** Format tool input into a short description */
function formatToolInput(name: string, input: Record<string, unknown>) {
  switch (name) {
    case "Read":
      return input.file_path ? String(input.file_path) : "";
    case "Write":
      return input.file_path ? String(input.file_path) : "";
    case "Edit":
      return input.file_path ? String(input.file_path) : "";
    case "Bash": {
      const cmd = input.command ? String(input.command) : "";
      return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
    }
    case "Glob":
      return input.pattern ? String(input.pattern) : "";
    case "Grep":
      return input.pattern ? String(input.pattern) : "";
    case "WebFetch":
      return input.url ? String(input.url) : "";
    case "WebSearch":
      return input.query ? String(input.query) : "";
    case "Task":
      return input.description ? String(input.description) : "";
    default:
      return "";
  }
}

/** Create a stateful stream-json parser */
function createStreamParser() {
  let _hasEmittedContent = false;
  let currentBlockType: "text" | "tool_use" | "thinking" | null = null;
  let currentToolName = "";
  let toolInputJson = "";
  let thinkingStartTime = 0;
  let lastPlanPath = "";

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

      if (
        parsed.type === "stream_event" &&
        parsed.event.type === "content_block_start" &&
        "content_block" in parsed.event
      ) {
        const block = parsed.event.content_block;
        if (block.type === "text") {
          currentBlockType = "text";
        } else if (block.type === "tool_use") {
          currentBlockType = "tool_use";
          currentToolName = block.name;
          toolInputJson = "";
        } else if (block.type === "thinking") {
          currentBlockType = "thinking";
          thinkingStartTime = Date.now();
          _hasEmittedContent = true;
          yield { kind: "thinking_start" };
        }
      } else if (
        parsed.type === "stream_event" &&
        parsed.event.type === "content_block_delta" &&
        "delta" in parsed.event
      ) {
        const delta = parsed.event.delta;
        if (delta.type === "text_delta" && currentBlockType === "text") {
          _hasEmittedContent = true;
          yield { kind: "text_delta", text: delta.text };
        } else if (
          delta.type === "input_json_delta" &&
          currentBlockType === "tool_use"
        ) {
          toolInputJson += delta.partial_json;
        } else if (
          delta.type === "thinking_delta" &&
          currentBlockType === "thinking" &&
          delta.thinking
        ) {
          yield { kind: "thinking_delta", text: delta.thinking };
        }
        // signature_delta: ignored
      } else if (
        parsed.type === "stream_event" &&
        parsed.event.type === "content_block_stop"
      ) {
        if (currentBlockType === "tool_use") {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(toolInputJson);
          } catch {}
          const shortInput = formatToolInput(currentToolName, input);
          _hasEmittedContent = true;
          yield { kind: "tool_use", name: currentToolName, input: shortInput };
          if (
            currentToolName === "Write" &&
            typeof input.file_path === "string" &&
            input.file_path.includes(".claude/plans/")
          ) {
            lastPlanPath = input.file_path;
          }
          if (currentToolName === "ExitPlanMode" && lastPlanPath) {
            yield { kind: "plan_ready", planPath: lastPlanPath };
            lastPlanPath = "";
          }
        } else if (currentBlockType === "thinking") {
          const elapsed = Date.now() - thinkingStartTime;
          yield { kind: "thinking_done", durationMs: elapsed };
        }
        currentBlockType = null;
      } else if (parsed.type === "system" && parsed.subtype === "init") {
        yield { kind: "session_init", sessionId: parsed.session_id };
      } else if (
        parsed.type === "system" &&
        parsed.subtype === "task_started"
      ) {
        yield {
          kind: "agent_started",
          taskId: parsed.task_id,
          description: parsed.description,
        };
      } else if (
        parsed.type === "system" &&
        parsed.subtype === "task_notification"
      ) {
        yield {
          kind: "agent_done",
          taskId: parsed.task_id,
          description: parsed.summary,
          status: parsed.status,
          durationMs: parsed.usage?.duration_ms,
          totalTokens: parsed.usage?.total_tokens,
          toolUses: parsed.usage?.tool_uses,
        };
      } else if (parsed.type === "result") {
        yield {
          kind: "result",
          text: parsed.result,
          sessionId: parsed.session_id,
          cost: parsed.total_cost_usd,
          durationMs: parsed.duration_ms,
          turns: parsed.num_turns,
        };
      }
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
