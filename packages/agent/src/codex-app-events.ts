import { Effect, Option, Predicate, Schema } from "effect";

import { codexAgents } from "./codex-agents";
import type { AppServerNotification } from "./codex-app-server";
import { logOutside } from "./log-sink";
import type { AgentEvent } from "./types";

/**
 * A turn's `codex app-server` notifications as AgentEvents, read the way
 * `codex exec` read them (`exec/src/event_processor_with_jsonl_output.rs`
 * in the Codex repo): items once completed, warnings as errors (config
 * warnings go to the log, as `codex exec` wrote them to stderr), every
 * `error` notification the turn goes on after, and, at the end of the
 * turn, the tokens its own requests used: how far the thread's total moved.
 */

const ZSH_WRAPPER = /^\/bin\/\w+ -lc /u;

const COMMAND_PREVIEW_MAX_CHARS = 80;
const ELLIPSIS = "...";
const COMMAND_PREVIEW_KEEP_CHARS = COMMAND_PREVIEW_MAX_CHARS - ELLIPSIS.length;

/** Strip the `/bin/zsh -lc` wrapper Codex puts around shell commands */
const stripZshWrapper = (command: string) => {
  const unwrapped = command.replace(ZSH_WRAPPER, "");
  return unwrapped.length > COMMAND_PREVIEW_MAX_CHARS
    ? `${unwrapped.slice(0, COMMAND_PREVIEW_KEEP_CHARS)}${ELLIPSIS}`
    : unwrapped;
};

/** The two JSON error shapes Codex wraps a message in. */
const decodeNestedError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
);
const decodeFlatError = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.String })
);
const nonEmpty = (message: string) => message.length > 0;

/** Codex error messages are sometimes a JSON-encoded string; surface the inner message */
const parseErrorMessage = (raw: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const nested = Option.filter(
    Option.map(decodeNestedError(parsed), (o) => o.error.message),
    nonEmpty
  );
  const flat = Option.filter(
    Option.map(decodeFlatError(parsed), (o) => o.message),
    nonEmpty
  );
  return Option.getOrElse(
    Option.orElse(nested, () => flat),
    () => raw
  );
};

/** A field the server sends as null or leaves out when it has no value. */
const Maybe = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

/** The items a run shows, in the server's shape; any other type is skipped. */
const ServerItem = Schema.Union([
  Schema.Struct({
    // `async` on a message a tool sent to the user mid-turn (the async
    // ask-the-user tools), which the model did not write as its answer.
    delivery: Maybe(Schema.String),
    // `commentary` before a tool call; `final_answer`, or none, otherwise.
    phase: Maybe(Schema.String),
    text: Schema.String,
    type: Schema.Literal("agentMessage"),
  }),
  Schema.Struct({
    summary: Schema.Array(Schema.String),
    type: Schema.Literal("reasoning"),
  }),
  Schema.Struct({
    command: Schema.String,
    type: Schema.Literal("commandExecution"),
  }),
  Schema.Struct({
    changes: Schema.Array(
      Schema.Struct({
        kind: Schema.Struct({ type: Schema.String }),
        path: Schema.String,
      })
    ),
    type: Schema.Literal("fileChange"),
  }),
  Schema.Struct({
    server: Schema.String,
    tool: Schema.String,
    type: Schema.Literal("mcpToolCall"),
  }),
  Schema.Struct({ query: Schema.String, type: Schema.Literal("webSearch") }),
  Schema.Struct({
    clientId: Maybe(Schema.String),
    type: Schema.Literal("userMessage"),
  }),
]);

const decodeItem = Schema.decodeUnknownOption(
  Schema.Struct({ item: ServerItem })
);

/** Any item's type, the ones the run skips (a compaction, say) included. */
const decodeItemType = Schema.decodeUnknownOption(
  Schema.Struct({ item: Schema.Struct({ type: Schema.String }) })
);

/**
 * Items that are not the model's output: input the turn recorded, and the
 * setup the server does before a sampling (a mid-turn compaction for a
 * steer, say).
 */
const INPUT_ITEMS: ReadonlySet<string> = new Set([
  "contextCompaction",
  "hookPrompt",
  "userMessage",
]);

/**
 * Notifications of tool work that leaves no item: `update_plan` and the goal
 * tools. `get_goal` leaves nothing at all.
 */
const ITEMLESS_WORK: ReadonlySet<string> = new Set([
  "thread/goal/updated",
  "turn/plan/updated",
]);

/** `message (details)`, as `codex exec` joins an error and its details. */
const ServerError = Schema.Struct({
  additionalDetails: Maybe(Schema.String),
  message: Schema.String,
});

/** `summary (details)`, or the summary alone when there are no details. */
const joinDetails = (summary: string, details: string | null | undefined) =>
  Predicate.isNotNullish(details) && details.length > 0
    ? `${summary} (${details})`
    : summary;

const withDetails = (error: typeof ServerError.Type) =>
  joinDetails(parseErrorMessage(error.message), error.additionalDetails);

const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: ServerError,
    willRetry: Schema.optional(Schema.Boolean),
  })
);
const decodeWarning = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.String })
);
const decodeNotice = Schema.decodeUnknownOption(
  Schema.Struct({ details: Maybe(Schema.String), summary: Schema.String })
);
const decodeRerouted = Schema.decodeUnknownOption(
  Schema.Struct({
    fromModel: Schema.String,
    reason: Schema.Unknown,
    toModel: Schema.String,
  })
);

/** One request's tokens, or the thread's running sum of them. */
const TokenBreakdown = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
});

/**
 * A `thread/tokenUsage/updated`: `total` is the thread's running sum over
 * every turn, `last` the newest request's, and `modelContextWindow` the
 * part of the model's window Codex lets a thread fill.
 */
const TokenUsageUpdate = Schema.Struct({
  threadId: Schema.String,
  tokenUsage: Schema.Struct({
    last: TokenBreakdown,
    modelContextWindow: Maybe(Schema.Number),
    total: TokenBreakdown,
  }),
});
const decodeTokenUsage = Schema.decodeUnknownOption(TokenUsageUpdate);

/** Prompt tokens, cached ones among them, plus output, reasoning among it. */
const tokensOf = (usage: typeof TokenBreakdown.Type) =>
  usage.inputTokens + usage.outputTokens;

/**
 * How many tokens each of a thread's usage updates adds. Codex sends one per
 * request and resends an unchanged one (a stream cut after its headers, a
 * compaction's start, a request that reported no usage), so an update adds
 * how far the thread's total moved since the last one read, whichever turn
 * that was. It starts from `known`, the total a resumed legacy thread's
 * rollout last recorded (`resumeThread` in `codex.ts`), and a resumed
 * paginated thread's starts from the update the server replays for its last
 * turn. With none (a new thread, a rollout with no total), or a total Codex
 * reset lower, an update adds its newest request.
 */
const tokenMeter = (threadId: string, known: number | undefined) => {
  let threadTotal = known;
  return (update: typeof TokenUsageUpdate.Type): number => {
    if (update.threadId !== threadId) {
      return 0;
    }
    const total = tokensOf(update.tokenUsage.total);
    const added =
      threadTotal === undefined || total < threadTotal
        ? tokensOf(update.tokenUsage.last)
        : total - threadTotal;
    threadTotal = total;
    return added;
  };
};

/**
 * What Codex counts as fixed in every request (its prompts, tools and room
 * to compact), left out of both sides of its "% context" so a new thread
 * starts at 0%.
 */
const CONTEXT_BASELINE_TOKENS = 12_000;

/**
 * The thread's context as Codex's own status line counts it: the newest
 * request, input and output, against the usable window, the baseline left
 * out of the percentage. A request with no count (a compaction's resend)
 * says nothing.
 */
const contextOf = (
  update: typeof TokenUsageUpdate.Type
): AgentEvent | undefined => {
  const used = tokensOf(update.tokenUsage.last);
  if (used <= 0) {
    return undefined;
  }
  return {
    baselineTokens: CONTEXT_BASELINE_TOKENS,
    kind: "context",
    sessionId: update.threadId,
    usedTokens: used,
    windowTokens: update.tokenUsage.modelContextWindow ?? undefined,
  };
};

const decodeTurnCompleted = Schema.decodeUnknownOption(
  Schema.Struct({
    turn: Schema.Struct({
      error: Maybe(ServerError),
      status: Schema.String,
    }),
  })
);

type TurnEnd = Option.Option.Value<
  ReturnType<typeof decodeTurnCompleted>
>["turn"];

/**
 * A completed item's events. A write under `.codex/plans/` is the
 * plan-ready signal, emitted once per turn in place of its tool line.
 */
const itemEvents = (
  item: typeof ServerItem.Type,
  state: { planEmitted: boolean }
): AgentEvent[] => {
  switch (item.type) {
    case "agentMessage": {
      return [{ kind: "text_message", text: item.text }];
    }
    case "reasoning": {
      const text = item.summary.join("\n");
      return text.trim().length === 0
        ? []
        : [
            { kind: "thinking_start" },
            { kind: "thinking_delta", text },
            { durationMs: 0, kind: "thinking_done" },
          ];
    }
    case "commandExecution": {
      return [
        {
          input: stripZshWrapper(item.command),
          kind: "tool_use",
          name: "Bash",
        },
      ];
    }
    case "fileChange": {
      return item.changes.flatMap((change): AgentEvent[] => {
        if (!change.path.includes(".codex/plans/")) {
          const name = change.kind.type === "add" ? "Write" : "Edit";
          return [{ input: change.path, kind: "tool_use", name }];
        }
        if (state.planEmitted) {
          return [];
        }
        state.planEmitted = true;
        return [{ kind: "plan_ready", planPath: change.path }];
      });
    }
    case "mcpToolCall": {
      return [{ input: item.server, kind: "tool_use", name: item.tool }];
    }
    case "webSearch": {
      return [{ input: item.query, kind: "tool_use", name: "WebSearch" }];
    }
    case "userMessage": {
      return [];
    }
    default: {
      return [];
    }
  }
};

/**
 * The tool an item is, named as the run's own tool lines name it; undefined
 * for an item that is no tool call (a message, a plan write).
 */
const itemToolName = (notification: AppServerNotification) =>
  Option.toArray(decodeItem(notification.params))
    .flatMap(({ item }) => itemEvents(item, { planEmitted: true }))
    .flatMap((event) => (event.kind === "tool_use" ? [event.name] : []))
    .at(0);

/** The running turn, as `turn/steer` and `turn/interrupt` name it. */
export interface TurnIds {
  threadId: string;
  turnId: string;
}

/** Which thread and turn a notification is about, where it says so. */
const decodeIds = Schema.decodeUnknownOption(
  Schema.Struct({
    threadId: Maybe(Schema.String),
    turn: Schema.optional(Schema.Struct({ id: Schema.String })),
    turnId: Maybe(Schema.String),
  })
);

/**
 * Whether a notification belongs to the run's own turn. One server carries
 * the threads of the sub-agents a turn spawns too, so everything else is
 * dropped (what the run shows of its sub-agents is read apart, by
 * `codexAgents`), as `codex exec` drops it (`should_process_notification`): config
 * and deprecation notices always pass, a warning unless it names another
 * thread, the rest only with the turn's own thread and turn id.
 */
const isOurs = (turn: TurnIds, notification: AppServerNotification) => {
  const ids = Option.getOrUndefined(decodeIds(notification.params));
  switch (notification.method) {
    case "configWarning":
    case "deprecationNotice": {
      return true;
    }
    case "warning": {
      return (
        !Predicate.isNotNullish(ids?.threadId) || ids.threadId === turn.threadId
      );
    }
    case "turn/completed": {
      return ids?.threadId === turn.threadId && ids.turn?.id === turn.turnId;
    }
    default: {
      return ids?.threadId === turn.threadId && ids.turnId === turn.turnId;
    }
  }
};

/** What one notification amounts to for the run. */
interface TurnRead {
  /** The turn ended, however it ended. */
  done: boolean;
  events: AgentEvent[];
  /**
   * Why the turn failed. `codex exec` exits non-zero on a failed turn, which
   * fails the run; the run throws this instead of printing it.
   */
  failed?: string;
  /** The `clientUserMessageId`s of steered input the model just took in. */
  taken?: readonly string[];
}

const NOTHING: TurnRead = { done: false, events: [] };

/**
 * A reader of one turn's notifications, started at `start`, from the first
 * one its server sent. It keeps the last answer and the latest error, which
 * the turn's end reports, as `codex exec` does, and the tokens the turn's
 * own requests used, which `codex exec` reported as the thread's total.
 * `threadTotal` is the thread's total before the turn, when the server
 * will not replay it. A turn that fails only on the sampling for a steer
 * sent after the model's own answer ends with that answer, not the
 * failure; a message a tool sent with `async` delivery is not an answer.
 */
export const turnReader = (
  own: TurnIds,
  start: number,
  threadTotal: number | undefined
) => {
  // Steers the turn recorded and the model has not read yet. One that comes
  // as the turn finishes is recorded with no sampling after it: it stays
  // here, unread, and the caller runs it next.
  let recorded: string[] = [];
  // Whether the model's last item was its answer, an `agentMessage` with
  // the `final_answer` phase, and nothing of the model's came after it. A
  // steer recorded then gets a sampling of its own, whose failure leaves the
  // answer standing. A message with no phase does not count: some tools
  // (the goal tools, `update_plan`) leave no item, so a remark before one
  // would read as the answer. Nor does one with `async` delivery: the async
  // ask-the-user tools send it as `final_answer` in the middle of the turn,
  // and the model's work goes on after it.
  let answered = false;
  const meter = tokenMeter(own.threadId, threadTotal);
  let totalTokens = 0;
  let lastError: string | undefined;
  let lastAnswer = "";
  let shown = "";
  const state = { planEmitted: false };
  const agents = codexAgents(own, itemToolName);
  // An error event, unless it repeats the last one shown.
  const warned = (message: string): TurnRead => {
    if (message === shown) {
      return NOTHING;
    }
    shown = message;
    return { done: false, events: [{ kind: "error", message }] };
  };
  // An item of the model's own, not input nor a compaction, is something
  // after the answer; a completed answer sets it again.
  const itemSeen = (notification: AppServerNotification) => {
    for (const { item } of Option.toArray(
      decodeItemType(notification.params)
    )) {
      if (!INPUT_ITEMS.has(item.type)) {
        answered = false;
      }
    }
  };
  const result = (): TurnRead => ({
    done: true,
    events: [
      {
        durationMs: Date.now() - start,
        kind: "result",
        sessionId: own.threadId,
        text: lastAnswer,
        totalTokens,
        turns: 1,
      },
    ],
  });
  const ended = (turn: TurnEnd): TurnRead => {
    if (turn.status === "completed") {
      return result();
    }
    if (turn.status === "failed") {
      const failed = Predicate.isNotNullish(turn.error)
        ? withDetails(turn.error)
        : (lastError ?? "turn failed");
      if (answered && recorded.length > 0) {
        // Only the sampling for a steer sent after the answer failed: the
        // run answered, and the steer, still unread, runs next.
        logOutside(
          Effect.logWarning("codex.late_steer_failed", {
            error: failed,
            unread: recorded.length,
          }).pipe(Effect.annotateLogs({ provider: "codex" }))
        );
        return result();
      }
      return { done: true, events: [], failed };
    }
    // Interrupted: a stop, which reports nothing of its own.
    return { done: turn.status !== "inProgress", events: [] };
  };
  /**
   * A usage update: metered before the turn filter, since an earlier turn's
   * update is where this turn's count starts from; this turn's own also
   * gives the context figure.
   */
  const usageRead = (notification: AppServerNotification): TurnRead => {
    const events: AgentEvent[] = [];
    for (const update of Option.toArray(
      decodeTokenUsage(notification.params)
    )) {
      const added = meter(update);
      if (isOurs(own, notification)) {
        totalTokens += added;
        const context = contextOf(update);
        if (context !== undefined) {
          events.push(context);
        }
      }
    }
    return events.length === 0 ? NOTHING : { done: false, events };
  };
  const read = (notification: AppServerNotification): TurnRead => {
    const { method, params } = notification;
    if (method === "thread/tokenUsage/updated") {
      return usageRead(notification);
    }
    if (!isOurs(own, notification)) {
      return NOTHING;
    }
    if (ITEMLESS_WORK.has(method)) {
      answered = false;
      return NOTHING;
    }
    switch (method) {
      case "item/started": {
        itemSeen(notification);
        const started = Option.getOrUndefined(decodeItem(params));
        if (started === undefined) {
          return NOTHING;
        }
        if (started.item.type === "userMessage") {
          if (Predicate.isNotNullish(started.item.clientId)) {
            recorded.push(started.item.clientId);
          }
          return NOTHING;
        }
        // The model's next item: it read every steer recorded before it.
        if (recorded.length === 0) {
          return NOTHING;
        }
        const taken = recorded;
        recorded = [];
        return { done: false, events: [], taken };
      }
      case "item/completed": {
        itemSeen(notification);
        return Option.match(decodeItem(params), {
          onNone: () => NOTHING,
          onSome: ({ item }) => {
            if (item.type === "agentMessage") {
              lastAnswer = item.text;
              answered =
                item.phase === "final_answer" && item.delivery !== "async";
            }
            return { done: false, events: itemEvents(item, state) };
          },
        });
      }
      case "error": {
        return Option.match(decodeError(params), {
          onNone: () => NOTHING,
          onSome: ({ error, willRetry }) => {
            lastError = withDetails(error);
            // The error a turn ends on comes back as its failure, which
            // fails the run; shown here as well it would read twice.
            return willRetry === false ? NOTHING : warned(lastError);
          },
        });
      }
      case "warning": {
        return Option.match(decodeWarning(params), {
          onNone: () => NOTHING,
          onSome: ({ message }) => warned(message),
        });
      }
      case "configWarning": {
        // About this host's Codex setup (an untrusted project's own config,
        // say), which `codex exec` wrote to its stderr: the log's, not the
        // chat's.
        for (const notice of Option.toArray(decodeNotice(params))) {
          logOutside(
            Effect.logWarning("codex.config_warning", {
              details: notice.details ?? "",
              summary: notice.summary,
            }).pipe(Effect.annotateLogs({ provider: "codex" }))
          );
        }
        return NOTHING;
      }
      case "deprecationNotice": {
        return Option.match(decodeNotice(params), {
          onNone: () => NOTHING,
          onSome: (notice) =>
            warned(joinDetails(notice.summary, notice.details)),
        });
      }
      case "model/rerouted": {
        return Option.match(decodeRerouted(params), {
          onNone: () => NOTHING,
          onSome: (rerouted) =>
            warned(
              `model rerouted: ${rerouted.fromModel} -> ${rerouted.toModel} (${String(rerouted.reason)})`
            ),
        });
      }
      case "turn/completed": {
        return Option.match(decodeTurnCompleted(params), {
          // A turn that ended in a shape this build cannot read still ended.
          onNone: () => ({ done: true, events: [] }),
          onSome: ({ turn }) => ended(turn),
        });
      }
      default: {
        return NOTHING;
      }
    }
  };
  return (notification: AppServerNotification): TurnRead => {
    const spawned = agents(notification);
    const turn = read(notification);
    return spawned.length === 0
      ? turn
      : { ...turn, events: [...spawned, ...turn.events] };
  };
};
