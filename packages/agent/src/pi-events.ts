import { Option, Schema } from "effect";

import type { PiRecord } from "./pi-rpc";
import { summarizeTool } from "./tool-summary";
import type { AgentEvent } from "./types";

/**
 * pi's session events as AgentEvents. pi retries a failed request three
 * times and reports each attempt as an assistant message that stopped on an
 * error, so an error is only remembered here; the run decides at
 * `agent_settled` whether it was final.
 */

/** What one run has seen so far. */
export interface PiRunState {
  /** The last assistant message's error, or a retry's final one. */
  error: string | undefined;
  /** The last assistant text: what the run answers. */
  lastText: string;
  /** When the open thinking block started, in epoch ms. */
  thinkingSince: number | undefined;
  totalTokens: number;
  turns: number;
  /** User messages pi took in: the run's own prompt, then its follow-ups. */
  userMessages: number;
}

export const newPiRunState = (): PiRunState => ({
  error: undefined,
  lastText: "",
  thinkingSince: undefined,
  totalTokens: 0,
  turns: 0,
  userMessages: 0,
});

/** An assistant message's blocks; a user message's content is not read. */
const Blocks = Schema.Array(
  Schema.Struct({ text: Schema.optional(Schema.String), type: Schema.String })
);

const decodeBlocks = Schema.decodeUnknownOption(Blocks);

const decodeUpdate = Schema.decodeUnknownOption(
  Schema.Struct({
    assistantMessageEvent: Schema.Struct({
      delta: Schema.optional(Schema.String),
      type: Schema.String,
    }),
  })
);

const MessageEnd = Schema.Struct({
  message: Schema.Struct({
    content: Schema.optional(Schema.Unknown),
    errorMessage: Schema.optional(Schema.String),
    role: Schema.String,
    stopReason: Schema.optional(Schema.String),
    usage: Schema.optional(
      Schema.Struct({ totalTokens: Schema.optional(Schema.Number) })
    ),
  }),
});

const decodeMessageEnd = Schema.decodeUnknownOption(MessageEnd);

/** A `--mode json` line that ends a message. */
const decodeJsonLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ...MessageEnd.fields, type: Schema.Literal("message_end") })
  )
);

const decodeToolStart = Schema.decodeUnknownOption(
  Schema.Struct({
    args: Schema.optional(Schema.Unknown),
    toolName: Schema.String,
  })
);

const decodeTurnEnd = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.Struct({ stopReason: Schema.optional(Schema.String) }),
  })
);

/** How a turn ends when it is a failed attempt pi may retry, not a turn. */
const FAILED_STOPS: ReadonlySet<string | undefined> = new Set([
  "aborted",
  "error",
]);

const decodeRetryEnd = Schema.decodeUnknownOption(
  Schema.Struct({
    finalError: Schema.optional(Schema.String),
    success: Schema.Boolean,
  })
);

/** A message's text blocks, joined. */
const textOf = (content: Schema.Schema.Type<typeof Blocks>) =>
  content
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("")
    .trim();

const thinkingEvents = (
  kind: string,
  delta: string | undefined,
  state: PiRunState
): AgentEvent[] => {
  if (kind === "thinking_start") {
    state.thinkingSince = Date.now();
    return [{ kind: "thinking_start" }];
  }
  if (kind === "thinking_delta" && delta !== undefined && delta.length > 0) {
    return [{ kind: "thinking_delta", text: delta }];
  }
  if (kind === "thinking_end") {
    const since = state.thinkingSince ?? Date.now();
    state.thinkingSince = undefined;
    return [{ durationMs: Date.now() - since, kind: "thinking_done" }];
  }
  return [];
};

/**
 * The assistant message one `--mode json` line ends, with its text and why
 * it stopped; none for any other line.
 */
export const assistantEndOf = (line: string) =>
  Option.flatMap(decodeJsonLine(line), ({ message }) =>
    message.role === "assistant"
      ? Option.some({
          errorMessage: message.errorMessage,
          stopReason: message.stopReason,
          text: textOf(
            Option.getOrElse(decodeBlocks(message.content), () => [])
          ),
        })
      : Option.none()
  );

/** An assistant message is done: its text, its usage, and whether it failed. */
const messageEvents = (
  message: Option.Option.Value<ReturnType<typeof decodeMessageEnd>>["message"],
  state: PiRunState
): AgentEvent[] => {
  if (message.role === "user") {
    state.userMessages += 1;
    return [];
  }
  if (message.role !== "assistant") {
    return [];
  }
  state.totalTokens += message.usage?.totalTokens ?? 0;
  if (message.stopReason === "error") {
    state.error = message.errorMessage ?? "pi request failed";
    return [];
  }
  state.error = undefined;
  const text = textOf(
    Option.getOrElse(decodeBlocks(message.content), () => [])
  );
  if (text.length === 0) {
    return [];
  }
  state.lastText = text;
  return [{ kind: "text_message", text }];
};

/** The AgentEvents one record makes, updating `state`. */
export const mapPiRecord = (
  record: PiRecord,
  state: PiRunState
): AgentEvent[] => {
  switch (record.type) {
    case "agent_start": {
      // A turn with no text of its own must not answer with the last one.
      state.lastText = "";
      state.error = undefined;
      return [];
    }
    case "message_update": {
      return Option.match(decodeUpdate(record.raw), {
        onNone: () => [],
        onSome: ({ assistantMessageEvent: update }) =>
          thinkingEvents(update.type, update.delta, state),
      });
    }
    case "message_end": {
      return Option.match(decodeMessageEnd(record.raw), {
        onNone: () => [],
        onSome: ({ message }) => messageEvents(message, state),
      });
    }
    case "tool_execution_start": {
      return Option.match(decodeToolStart(record.raw), {
        onNone: () => [],
        onSome: (call) => [
          {
            kind: "tool_use",
            ...summarizeTool({ input: call.args, name: call.toolName }),
          },
        ],
      });
    }
    case "turn_end": {
      // Each failed attempt pi retries ends a turn of its own.
      const failed = Option.exists(decodeTurnEnd(record.raw), ({ message }) =>
        FAILED_STOPS.has(message.stopReason)
      );
      if (!failed) {
        state.turns += 1;
      }
      return [];
    }
    case "auto_retry_end": {
      for (const end of Option.toArray(decodeRetryEnd(record.raw))) {
        if (!end.success) {
          state.error = end.finalError ?? state.error ?? "pi retries failed";
        }
      }
      return [];
    }
    default: {
      return [];
    }
  }
};

/** What `get_session_stats` answers; only the context window is read. */
export const SessionStats = Schema.Struct({
  contextUsage: Schema.optional(
    Schema.Struct({
      contextWindow: Schema.optional(Schema.Number),
      tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    })
  ),
});

/**
 * The `context` event of a `get_session_stats` answer: pi's own estimate of
 * the window, the figure its footer shows. None right after a compaction,
 * when pi has no count until the next answer.
 */
export const contextOfStats = (input: {
  model: string;
  sessionId: string;
  stats: Schema.Schema.Type<typeof SessionStats>;
}): AgentEvent | undefined => {
  const usage = input.stats.contextUsage;
  const used = usage?.tokens;
  if (used === undefined || used === null) {
    return undefined;
  }
  const event: Extract<AgentEvent, { kind: "context" }> = {
    kind: "context",
    model: input.model,
    sessionId: input.sessionId,
    usedTokens: used,
  };
  if (usage?.contextWindow !== undefined) {
    event.windowTokens = usage.contextWindow;
  }
  return event;
};

/** What `compact` answers; only the token counts are read. */
export const Compacted = Schema.Struct({
  estimatedTokensAfter: Schema.optional(Schema.Number),
  tokensBefore: Schema.optional(Schema.Number),
});

/** The `compact_done` of a `compact` answer; the session stays the same. */
export const compactDoneOf = (
  result: Schema.Schema.Type<typeof Compacted>,
  sessionId: string
): AgentEvent => {
  const event: Extract<AgentEvent, { kind: "compact_done" }> = {
    kind: "compact_done",
    sessionId,
  };
  if (result.tokensBefore !== undefined) {
    event.preTokens = result.tokensBefore;
  }
  if (result.estimatedTokensAfter !== undefined) {
    event.postTokens = result.estimatedTokensAfter;
  }
  return event;
};
