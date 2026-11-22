import type {
  Query,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";

import { isPluginSkill } from "./bot-skills";
import type { ClaudeAgents } from "./claude-agents";
import { claudeLog } from "./claude-log";
import { ProviderCrashed } from "./errors";
import { summarizeTool } from "./tool-summary";
import type { AgentEvent, CompactEvent } from "./types";

/**
 * Claude Code's stream as `AgentEvent`s. Only the main agent's frames are
 * mapped: a subagent's (`parent_tool_use_id` set) belong to its `Task` call,
 * whose own state comes from the task frames (`claude-agents.ts`).
 * A failure of any kind ends the run as `ProviderCrashed`, its English kept
 * for the log; the chat reads the ordinary error sentence.
 */

/**
 * The skills a CLI still lists with bundled skills off, per CLI version. A
 * known version listing anything else means the isolation did not hold.
 */
const ALLOWED_SKILLS = new Map<string, readonly string[]>([
  ["2.1.293", ["design", "doctor", "plugin-authoring"]],
  ["2.1.299", ["design", "doctor", "plugin-authoring"]],
  ["2.1.308", ["design", "doctor", "plugin-authoring"]],
  ["2.1.330", ["design", "doctor", "plugin-authoring"]],
]);

/** CLI versions already warned about, so the warning shows once each. */
const uncheckedVersions = new Set<string>();

/** What one run carries from frame to frame. */
export interface ClaudeRunState {
  /** The sub-agents and workflows the run started, from its task frames. */
  agents: ClaudeAgents;
  /** The error the last assistant frame was marked with, for the log. */
  assistantError?: SDKAssistantMessageError;
  initialized: boolean;
  /** The last assistant text: the answer when the result has none. */
  lastText: string;
  /** The last main-thread request whose usage was sent as a `context` event. */
  lastUsageId?: string;
  sessionId: string;
}

/**
 * Check the first init frame against what the options asked for: no
 * claude.ai connector, and no skill beyond the allowlist of a known CLI and
 * the bot's own plugins.
 */
const checkInit = (init: SDKSystemMessage) => {
  const leaked = init.mcp_servers.filter(
    (server) => server.source === "claudeai"
  );
  if (leaked.length > 0) {
    throw new ProviderCrashed({
      message: `Claude loaded account connectors: ${leaked.map((server) => server.name).join(", ")}`,
    });
  }
  const allowed = ALLOWED_SKILLS.get(init.claude_code_version);
  if (
    allowed === undefined &&
    !uncheckedVersions.has(init.claude_code_version)
  ) {
    uncheckedVersions.add(init.claude_code_version);
    claudeLog(
      Effect.logWarning("claude skills check skipped: unknown CLI version", {
        version: init.claude_code_version,
      })
    );
  }
  const extra =
    allowed === undefined
      ? []
      : init.skills.filter(
          (skill) => !(allowed.includes(skill) || isPluginSkill(skill))
        );
  if (extra.length > 0) {
    throw new ProviderCrashed({
      message: `Claude listed skills it should not have: ${extra.join(", ")}`,
    });
  }
  claudeLog(
    Effect.logDebug("claude.init", {
      apiKeySource: init.apiKeySource,
      mcpServers: init.mcp_servers.map(
        (server) => `${server.name}:${server.status}`
      ),
      model: init.model,
      skills: init.skills,
      skillsChecked: allowed !== undefined,
      tools: init.tools,
      version: init.claude_code_version,
    })
  );
};

/**
 * What one request's prompt carried, from the first assistant frame of its
 * response (the CLI sends one frame per content block, each with the same
 * usage): the input, cached or not. A frame with no usage of its own, the
 * CLI's synthetic ones, says nothing about the window. Claude Code's status
 * line counts it the same way.
 */
const requestContext = (
  message: SDKAssistantMessage,
  state: ClaudeRunState
): AgentEvent | undefined => {
  const { id, model, usage } = message.message;
  const used =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  if (id === state.lastUsageId || used === 0) {
    return undefined;
  }
  state.lastUsageId = id;
  return {
    kind: "context",
    model,
    sessionId: message.session_id,
    usedTokens: used,
  };
};

/**
 * One assistant frame's content blocks as events.
 *
 * @yields {AgentEvent} text, thinking and tool events, in block order, after
 * the request's context figure.
 */
const mapAssistant = function* mapAssistant(
  message: SDKAssistantMessage,
  state: ClaudeRunState
): Generator<AgentEvent> {
  if (message.error !== undefined) {
    state.assistantError = message.error;
    claudeLog(
      Effect.logWarning("claude.assistant_error", { error: message.error })
    );
    return;
  }
  const context = requestContext(message, state);
  if (context !== undefined) {
    yield context;
  }
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.length > 0) {
      state.lastText = block.text;
      yield { kind: "text_message", text: block.text };
    } else if (block.type === "thinking" && block.thinking.length > 0) {
      yield { kind: "thinking_start" };
      yield { kind: "thinking_delta", text: block.thinking };
      yield { durationMs: 0, kind: "thinking_done" };
    } else if (block.type === "tool_use") {
      yield { kind: "tool_use", ...summarizeTool(block) };
    }
  }
};

/** Every model's tokens, the CLI's own side calls included. */
const totalTokens = (result: SDKResultMessage) => {
  const usage = Object.values(result.modelUsage);
  return usage.length === 0
    ? undefined
    : usage.reduce(
        (sum, model) =>
          sum +
          model.inputTokens +
          model.outputTokens +
          model.cacheReadInputTokens +
          model.cacheCreationInputTokens,
        0
      );
};

/** How long a settled turn waits for the CLI's own context figure. */
const EXACT_CONTEXT_MS = 500;

/**
 * The CLI's summary read, null when it fails. It settles even after the
 * wait gave up, so a late failure never rejects unhandled.
 */
const readContext = async (session: Query) => {
  try {
    return await session.getContextUsage({ detail: "summary" });
  } catch (error) {
    claudeLog(Effect.logWarning("claude.context_unread", { error }));
    return null;
  }
};

/**
 * The CLI's own `/context` figure at a settled turn: the last request plus
 * the messages after it, against the window it compacts in (200K on some
 * 1M models), with the point it compacts at. A summary read costs about
 * 35 ms and no model call. Undefined when the CLI does not answer in time;
 * the per-request figure already sent stands.
 */
export const exactContext = async (
  session: Query | undefined,
  result: SDKResultMessage
): Promise<AgentEvent | undefined> => {
  if (session === undefined) {
    return undefined;
  }
  const usage = await Promise.race([
    readContext(session),
    Bun.sleep(EXACT_CONTEXT_MS),
  ]);
  if (usage === undefined) {
    claudeLog(Effect.logWarning("claude.context_timeout"));
  }
  if (usage === undefined || usage === null) {
    return undefined;
  }
  const modelWindow = result.modelUsage[usage.model]?.contextWindow;
  return {
    compactAt: usage.isAutoCompactEnabled
      ? usage.autoCompactThreshold
      : undefined,
    kind: "context",
    model: usage.model,
    modelWindowTokens:
      modelWindow !== undefined && modelWindow > usage.rawMaxTokens
        ? modelWindow
        : undefined,
    sessionId: result.session_id,
    usedTokens: usage.totalTokens,
    windowTokens: usage.rawMaxTokens,
  };
};

/** The run's answer, or the failure it ended in. */
const mapResult = (
  result: SDKResultMessage,
  state: ClaudeRunState
): AgentEvent => {
  claudeLog(
    Effect.log("claude.result", {
      "provider.cost_estimate_usd": result.total_cost_usd,
      subtype: result.subtype,
      turns: result.num_turns,
    })
  );
  if (result.subtype !== "success" || result.is_error) {
    const detail =
      result.subtype === "success" ? result.result : result.errors.join("; ");
    throw new ProviderCrashed({
      message: `Claude run failed (${result.subtype}${state.assistantError === undefined ? "" : `, ${state.assistantError}`}): ${detail}`,
    });
  }
  return {
    durationMs: result.duration_ms,
    kind: "result",
    sessionId: result.session_id,
    text: result.result.length > 0 ? result.result : state.lastText,
    totalTokens: totalTokens(result),
    turns: result.num_turns,
  };
};

/**
 * Map one SDK frame. The first init names the session; every later init (one
 * per turn) is the same session.
 *
 * @yields {AgentEvent} the events the frame maps to, if any.
 */
export const mapClaudeMessage = function* mapClaudeMessage(
  message: SDKMessage,
  state: ClaudeRunState
): Generator<AgentEvent> {
  // Tool results, status and rate-limit frames carry nothing the chat shows;
  // task frames are the sub-agents'.
  if (message.type === "system") {
    yield* state.agents(message);
    if (message.subtype === "init" && !state.initialized) {
      state.initialized = true;
      checkInit(message);
      state.sessionId = message.session_id;
      yield { kind: "session_init", sessionId: message.session_id };
    }
  } else if (message.type === "assistant") {
    if (message.parent_tool_use_id === null) {
      yield* mapAssistant(message, state);
    }
  } else if (message.type === "result") {
    yield mapResult(message, state);
  }
};

/** What a compaction turn carries from frame to frame. */
export interface ClaudeCompactState {
  /** The boundary the CLI wrote: the session was compacted. */
  boundary?: SDKCompactBoundaryMessage["compact_metadata"];
  /** Why the CLI said compaction failed, when it did. */
  failure?: string;
  initialized: boolean;
}

/**
 * Map one frame of a `/compact` turn. The CLI compacts the session in place,
 * so the session id stays; the turn has compacted only when a boundary was
 * written before its result. Answers the terminal event at the result.
 */
export const mapCompactMessage = (
  message: SDKMessage,
  state: ClaudeCompactState
): CompactEvent | undefined => {
  if (message.type === "system") {
    if (message.subtype === "init" && !state.initialized) {
      state.initialized = true;
      checkInit(message);
    } else if (message.subtype === "compact_boundary") {
      state.boundary = message.compact_metadata;
    } else if (
      message.subtype === "status" &&
      message.compact_result === "failed"
    ) {
      state.failure = message.compact_error ?? "Claude could not compact.";
    }
    return undefined;
  }
  if (message.type !== "result") {
    return undefined;
  }
  claudeLog(
    Effect.log("claude.compact", {
      postTokens: state.boundary?.post_tokens,
      preTokens: state.boundary?.pre_tokens,
      subtype: message.subtype,
    })
  );
  if (message.subtype !== "success" || message.is_error) {
    const detail =
      message.subtype === "success"
        ? message.result
        : message.errors.join("; ");
    return {
      kind: "compact_failed",
      reason: `Claude compaction failed (${message.subtype}): ${detail}`,
    };
  }
  if (state.boundary === undefined) {
    return {
      kind: "compact_failed",
      reason: state.failure ?? "Claude ended the turn without compacting.",
    };
  }
  return {
    kind: "compact_done",
    postTokens: state.boundary.post_tokens,
    preTokens: state.boundary.pre_tokens,
    sessionId: message.session_id,
  };
};
