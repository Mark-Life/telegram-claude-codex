import { statSync } from "node:fs";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type FileChangeItem,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import {
  clearSessionCache,
  getSessionProject,
  listAllSessions,
} from "./codex-history";
import type { AgentEvent, AgentProvider, RunOptions } from "./types";

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
 * Sum the explicit usage keys the SDK reports on `turn.completed`. Returns
 * undefined (never 0) when no numeric field is present, so a subscription run
 * without usage degrades to NULL in the wide event instead of a fabricated 0.
 */
const sumUsage = (usage: Usage | null | undefined) => {
  if (!usage) {
    return;
  }
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ] as const;
  let total = 0;
  let saw = false;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      saw = true;
    }
  }
  return saw ? total : undefined;
};

/**
 * Mutable state carried across one Codex run: wall-clock start (run duration),
 * thread id (Codex session id), last assistant message (result text), last
 * surfaced error (dedupe), and whether plan_ready was emitted.
 */
interface CodexRunState {
  lastAgentMessage: string;
  lastError: string;
  planEmitted: boolean;
  sessionId: string;
  start: number;
}

/** Yield an `error` event only if the message differs from the last one seen */
function* emitErrorOnce(
  msg: string,
  state: CodexRunState
): Generator<AgentEvent> {
  if (msg !== state.lastError) {
    state.lastError = msg;
    yield { kind: "error", message: msg };
  }
}

/**
 * Translate a completed `file_change` item's changes into events. A write to
 * `.codex/plans/` is the plan-ready signal (mirrors claude.ts's `.claude/plans/`
 * check): emit plan_ready at most once per run and skip the noisy tool_use line.
 */
function* handleFileChanges(
  changes: FileChangeItem["changes"],
  state: CodexRunState
): Generator<AgentEvent> {
  for (const change of changes) {
    if (change.path.includes(".codex/plans/")) {
      if (!state.planEmitted) {
        state.planEmitted = true;
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
}

/** Translate a completed `reasoning` item into a thinking event triple */
function* handleReasoning(text: string): Generator<AgentEvent> {
  if (!text) {
    return;
  }
  yield { kind: "thinking_start" };
  yield { kind: "thinking_delta", text };
  yield { kind: "thinking_done", durationMs: 0 };
}

/**
 * Translate a Codex item into normalized events. Only completed items produce
 * output — command/file lines emit once on completion (status/exit known) to
 * avoid duplicate tool lines. `item.updated` is ignored for the same reason.
 */
function* handleItem(
  item: ThreadItem,
  isCompleted: boolean,
  state: CodexRunState
): Generator<AgentEvent> {
  if (!isCompleted) {
    return;
  }
  switch (item.type) {
    case "agent_message":
      state.lastAgentMessage = item.text;
      yield { kind: "text_delta", text: item.text };
      return;
    case "command_execution":
      yield {
        kind: "tool_use",
        name: "Bash",
        input: stripZshWrapper(item.command),
      };
      return;
    case "file_change":
      yield* handleFileChanges(item.changes, state);
      return;
    case "reasoning":
      yield* handleReasoning(item.text);
      return;
    case "mcp_tool_call":
      yield { kind: "tool_use", name: item.tool, input: item.server };
      return;
    case "web_search":
      yield { kind: "tool_use", name: "WebSearch", input: item.query };
      return;
    case "error":
      yield* emitErrorOnce(item.message, state);
      return;
    default:
      // todo_list and any future item types carry no normalized event.
      return;
  }
}

/**
 * Map one typed SDK `ThreadEvent` to normalized AgentEvents, preserving the
 * former JSONL parser's semantics: thread id → session, completion-only item
 * emit, plan detection, real token totals on turn.completed, deduped errors.
 * Codex reports no dollar cost under the ChatGPT plan, so `cost` is left
 * undefined (degrades to NULL) rather than a fabricated 0; a run is exactly
 * one turn.
 */
function* mapThreadEvent(
  ev: ThreadEvent,
  state: CodexRunState
): Generator<AgentEvent> {
  switch (ev.type) {
    case "thread.started":
      state.sessionId = ev.thread_id;
      yield { kind: "session_init", sessionId: ev.thread_id };
      return;
    case "item.started":
    case "item.completed":
      yield* handleItem(ev.item, ev.type === "item.completed", state);
      return;
    case "turn.completed":
      yield {
        kind: "result",
        text: state.lastAgentMessage,
        sessionId: state.sessionId,
        durationMs: Date.now() - state.start,
        turns: 1,
        totalTokens: sumUsage(ev.usage),
      };
      return;
    case "turn.failed":
      yield* emitErrorOnce(parseErrorMessage(ev.error.message), state);
      return;
    case "error":
      yield* emitErrorOnce(parseErrorMessage(ev.message), state);
      return;
    default:
      // turn.started, item.updated: no normalized event.
      return;
  }
}

const SCRIPT_DIR = new URL("../../scripts", import.meta.url).pathname;

/**
 * Build instruction text telling Codex how to send files to the user's chat.
 * Mirrors claude.ts's buildFileSystemPrompt; Codex has no system-prompt hook,
 * so this is prepended to the prompt instead. The chatId rides the `--chat`
 * arg so no `TELEGRAM_CHAT_ID` env injection is needed.
 */
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
 * Build the plan-mode convention instruction. Codex has no native
 * plan-mode/ExitPlanMode signal, so it is taught the `.codex/plans/`
 * convention: when asked to plan only, write the plan to a known path. The
 * bot detects the resulting `file_change` (or a post-turn stat) and emits
 * `plan_ready` (mirrors Claude's `.claude/plans/` flow).
 */
const buildPlanModePrompt = () =>
  [
    "When the user asks you to PLAN or DESIGN something WITHOUT implementing it,",
    "do not modify any source files. Instead, write the plan as markdown to",
    "./.codex/plans/PLAN.md (create the directory if needed), then stop.",
    "For all other requests, work normally.",
  ].join(" ");

/**
 * Compose the Codex prompt. On the first turn (no sessionId) the file-send and
 * plan-mode convention instructions are prepended; on resume the session
 * already carries them via replayed conversation context (accepted trade-off —
 * the SDK exposes no developer-instructions/system-prompt hook).
 */
const buildCodexPrompt = (opts: RunOptions) => {
  if (opts.sessionId) {
    return opts.prompt;
  }
  const prefix = `${buildFileSystemPrompt(opts.chatId)}\n\n${buildPlanModePrompt()}`;
  return `${prefix}\n\n${opts.prompt}`;
};

/**
 * Per-thread options: working dir + the bypass-approvals/sandbox posture that
 * matches the bot's Claude `bypassPermissions`. `skipGitRepoCheck` mirrors the
 * old `--skip-git-repo-check` flag.
 */
const threadOptions = (opts: RunOptions): ThreadOptions => ({
  workingDirectory: opts.projectDir,
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
});

/**
 * Build the Codex process options. The env is the bot's own env minus
 * `CLAUDECODE` (its presence confuses Codex); passing `env` means the SDK does
 * not additionally inherit `process.env`. Codex's default shell-environment
 * policy strips `*TOKEN*` names, which would hide `BOT_TOKEN` from the
 * send-file script, so it is force-set for the shell tool via config.
 */
const codexOptions = (): CodexOptions => {
  const { CLAUDECODE: _drop, ...rest } = process.env;
  const env = Object.fromEntries(
    Object.entries(rest).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
  const botToken = process.env.BOT_TOKEN;
  const config = botToken
    ? {
        shell_environment_policy: {
          inherit: "all",
          set: { BOT_TOKEN: botToken },
        },
      }
    : undefined;
  return config ? { env, config } : { env };
};

/** True when PLAN.md exists and was (re)written during this run. */
const planWrittenSince = (planPath: string, since: number) => {
  try {
    return statSync(planPath).mtimeMs >= since;
  } catch {
    return false;
  }
};

/**
 * Drive the Codex SDK for one run, normalizing its typed `ThreadEvent` stream
 * into AgentEvents. Starts or resumes a thread by sessionId, streams the turn
 * with the caller's abort signal (so /stop tears it down), and — as a safety
 * net for a PLAN.md written via shell redirection (which surfaces as a
 * command_execution, not a file_change) — stats the plan file after the turn.
 */
async function* run(
  opts: RunOptions,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  const codex = new Codex(codexOptions());
  const thread = opts.sessionId
    ? codex.resumeThread(opts.sessionId, threadOptions(opts))
    : codex.startThread(threadOptions(opts));

  const state: CodexRunState = {
    start: Date.now(),
    sessionId: opts.sessionId ?? "",
    lastAgentMessage: "",
    lastError: "",
    planEmitted: false,
  };

  const { events } = await thread.runStreamed(buildCodexPrompt(opts), {
    signal,
  });
  for await (const ev of events) {
    yield* mapThreadEvent(ev, state);
  }

  if (!state.planEmitted) {
    const planPath = join(opts.projectDir, ".codex/plans/PLAN.md");
    if (planWrittenSince(planPath, state.start)) {
      yield { kind: "plan_ready", planPath };
    }
  }
}

/** Codex provider definition (Codex SDK) */
export const codexProvider: AgentProvider = {
  id: "codex",
  kind: "sdk",
  displayName: "Codex",
  capabilities: {
    planMode: true,
    thinking: true,
    cost: false,
    subagents: false,
  },
  run,
  listAllSessions,
  getSessionProject,
  clearSessionCache,
};
