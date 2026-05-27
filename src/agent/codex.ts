import {
  clearSessionCache,
  getSessionProject,
  listAllSessions,
} from "./codex-history";
import type { AgentEvent, AgentProvider, RunOptions } from "./types";

interface CommandExecutionItem {
  aggregated_output: string;
  command: string;
  exit_code: number | null;
  id: string;
  status: string;
  type: "command_execution";
}

interface FileChange {
  kind: "add" | "update" | "delete";
  path: string;
}

interface FileChangeItem {
  changes: FileChange[];
  id: string;
  status: string;
  type: "file_change";
}

interface AgentMessageItem {
  id: string;
  text: string;
  type: "agent_message";
}

interface ReasoningItem {
  id: string;
  text: string;
  type: "reasoning";
}

type CodexItem =
  | CommandExecutionItem
  | FileChangeItem
  | AgentMessageItem
  | ReasoningItem
  | { type: string; id?: string };

type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | {
      type: "turn.completed";
      usage?: {
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
        reasoning_output_tokens: number;
      };
    }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "item.started"; item: CodexItem }
  | { type: "item.completed"; item: CodexItem }
  | { type: "error"; message?: string }
  | { type: string };

const ZSH_WRAPPER = /^\/bin\/\w+ -lc /;

/** Strip the `/bin/zsh -lc` wrapper Codex puts around shell commands */
const stripZshWrapper = (command: string) => {
  const unwrapped = command.replace(ZSH_WRAPPER, "");
  return unwrapped.length > 80 ? `${unwrapped.slice(0, 77)}...` : unwrapped;
};

/** Codex error messages are sometimes a JSON-encoded string; surface the inner message */
const parseErrorMessage = (raw: string) => {
  try {
    const obj = JSON.parse(raw);
    if (obj?.error?.message && typeof obj.error.message === "string") {
      return obj.error.message;
    }
    if (obj?.message && typeof obj.message === "string") {
      return obj.message;
    }
  } catch {
    // not JSON — fall through to raw
  }
  return raw;
};

/**
 * Create a stateful parser for the `codex exec --json` stdout stream.
 * The closure captures wall-clock start time (run duration), the thread id
 * (Codex session id), and the last assistant message (result text).
 */
const createCodexParser = () => {
  const start = Date.now();
  let sessionId = "";
  let lastAgentMessage = "";
  let lastError = "";
  let planEmitted = false;

  return function* parseCodexLines(lines: string[]): Generator<AgentEvent> {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: CodexEvent;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (parsed.type === "thread.started" && "thread_id" in parsed) {
        sessionId = parsed.thread_id;
        yield { kind: "session_init", sessionId };
      } else if (
        (parsed.type === "item.started" || parsed.type === "item.completed") &&
        "item" in parsed
      ) {
        const isCompleted = parsed.type === "item.completed";
        const item = parsed.item;

        if (item.type === "agent_message" && isCompleted) {
          const text = (item as AgentMessageItem).text;
          lastAgentMessage = text;
          yield { kind: "text_delta", text };
        } else if (item.type === "command_execution" && isCompleted) {
          // Emit once on completion (status/exit known) to avoid dup tool lines
          const cmd = (item as CommandExecutionItem).command;
          yield { kind: "tool_use", name: "Bash", input: stripZshWrapper(cmd) };
        } else if (item.type === "file_change" && isCompleted) {
          for (const change of (item as FileChangeItem).changes) {
            // A write to .codex/plans/ is the plan-ready signal (mirrors
            // claude.ts's .claude/plans/ check). Emit plan_ready at most once
            // per run and skip the noisy tool_use line for the plan file.
            if (change.path.includes(".codex/plans/")) {
              if (!planEmitted) {
                planEmitted = true;
                yield { kind: "plan_ready", planPath: change.path };
              }
              continue;
            }
            yield {
              kind: "tool_use",
              name: change.kind === "add" ? "Write" : "Edit",
              input: change.path,
            };
          }
        } else if (item.type === "reasoning" && isCompleted) {
          const text = (item as ReasoningItem).text;
          if (text) {
            yield { kind: "thinking_start" };
            yield { kind: "thinking_delta", text };
            yield { kind: "thinking_done", durationMs: 0 };
          }
        }
      } else if (parsed.type === "turn.completed") {
        yield {
          kind: "result",
          text: lastAgentMessage,
          sessionId,
          cost: 0,
          durationMs: Date.now() - start,
          turns: 0,
        };
      } else if (parsed.type === "turn.failed" && "error" in parsed) {
        // `error` and `turn.failed` carry the same message — emit once
        const msg = parseErrorMessage(parsed.error?.message ?? "Turn failed");
        if (msg !== lastError) {
          lastError = msg;
          yield { kind: "error", message: msg };
        }
      } else if (parsed.type === "error" && "message" in parsed) {
        const msg = parseErrorMessage(parsed.message ?? "Error");
        if (msg !== lastError) {
          lastError = msg;
          yield { kind: "error", message: msg };
        }
      }
      // turn.started, item.started (non-command/file), and unknown types: ignored
    }
  };
};

const SCRIPT_DIR = new URL("../../scripts", import.meta.url).pathname;

/**
 * Build instruction text telling Codex how to send files to the user's chat.
 * Mirrors claude.ts's buildFileSystemPrompt; Codex has no
 * `--append-system-prompt`, so this is prepended to the prompt instead.
 */
const buildFileSystemPrompt = () => {
  const scriptPath = `${SCRIPT_DIR}/send-file-to-user.ts`;
  return [
    "You can send files to the user's Telegram chat.",
    `To send a file, run: bun ${scriptPath} <absolute-file-path>`,
    "Only use this when the user explicitly asks you to send/share/download a file.",
    "The script blocks .env and other sensitive files automatically.",
  ].join(" ");
};

/**
 * Build the plan-mode convention instruction. Codex has no native
 * plan-mode/ExitPlanMode signal, so it is taught the `.codex/plans/`
 * convention: when asked to plan only, write the plan to a known path. The
 * bot detects the resulting `file_change` and emits `plan_ready` (mirrors
 * Claude's `.claude/plans/` flow). Conditional so normal runs are unaffected.
 */
const buildPlanModePrompt = () =>
  [
    "When the user asks you to PLAN or DESIGN something WITHOUT implementing it,",
    "do not modify any source files. Instead, write the plan as markdown to",
    "./.codex/plans/PLAN.md (create the directory if needed), then stop.",
    "For all other requests, work normally.",
  ].join(" ");

/**
 * Compose the Codex prompt. On the first turn (no sessionId) the file-send
 * and plan-mode convention instructions are prepended; on resume the session
 * already carries them via conversation context (accepted trade-off).
 */
const buildCodexPrompt = (opts: RunOptions) => {
  if (opts.sessionId) {
    return opts.prompt;
  }
  const prefix = `${buildFileSystemPrompt()}\n\n${buildPlanModePrompt()}`;
  return `${prefix}\n\n${opts.prompt}`;
};

/**
 * Build codex CLI args. Resume rejects `-C/--cd`, so the working dir is set
 * via the runner's `cwd: opts.projectDir` on both paths instead.
 * `--dangerously-bypass-approvals-and-sandbox` matches the bot's Claude
 * `--dangerously-skip-permissions` (safer alt: `--sandbox workspace-write`).
 */
const buildArgs = (opts: RunOptions) => {
  const safety = [
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];
  const prompt = buildCodexPrompt(opts);
  if (opts.sessionId) {
    return ["exec", "resume", opts.sessionId, "--json", ...safety, prompt];
  }
  return ["exec", "--json", ...safety, prompt];
};

/** Build the codex CLI environment: strip CLAUDECODE, inject TELEGRAM_CHAT_ID */
const buildEnv = (
  opts: RunOptions,
  base: Record<string, string | undefined>
) => {
  const { CLAUDECODE: _, ...restEnv } = base;
  return { ...restEnv, TELEGRAM_CHAT_ID: String(opts.chatId) } as Record<
    string,
    string
  >;
};

/** Codex provider definition */
export const codexProvider: AgentProvider = {
  id: "codex",
  command: "codex",
  displayName: "Codex",
  capabilities: {
    planMode: true,
    thinking: true,
    cost: false,
    subagents: false,
  },
  buildArgs,
  buildEnv,
  createParser: createCodexParser,
  listAllSessions,
  getSessionProject,
  clearSessionCache,
};
