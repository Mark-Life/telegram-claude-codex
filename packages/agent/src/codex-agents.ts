import { Option, Schema } from "effect";

import type { TurnIds } from "./codex-app-events";
import type { AppServerNotification } from "./codex-app-server";
import { subAgentEndOf } from "./types";
import type { AgentEvent } from "./types";

/**
 * The sub-agents a Codex turn spawns, as sub-agent events. The parent's
 * thread reports each one as a `subAgentActivity` item (`started`,
 * `interacted`, `interrupted`, `completed`) naming the agent's thread and
 * its path (`/root/count_ts`); the agent's own thread sends its turns,
 * items and token usage over the same server, which the run's own reader
 * drops (`isOurs`). An agent ends with its own `turn/completed`, which
 * carries how and the error; the parent's `completed` activity comes before
 * or after it, so it says nothing. Only threads the run's turn spawned are read, so an
 * agent an agent spawned counts too, with its spawner as parent.
 */

const decodeActivity = Schema.decodeUnknownOption(
  Schema.Struct({
    item: Schema.Struct({
      agentPath: Schema.String,
      agentThreadId: Schema.String,
      kind: Schema.String,
      type: Schema.Literal("subAgentActivity"),
    }),
    threadId: Schema.String,
  })
);

const decodeThread = Schema.decodeUnknownOption(
  Schema.Struct({ threadId: Schema.String })
);

const decodeTurnEnd = Schema.decodeUnknownOption(
  Schema.Struct({
    turn: Schema.Struct({
      durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
      error: Schema.optional(
        Schema.NullOr(Schema.Struct({ message: Schema.String }))
      ),
      status: Schema.String,
    }),
  })
);

const decodeUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    tokenUsage: Schema.Struct({
      total: Schema.Struct({
        inputTokens: Schema.Number,
        outputTokens: Schema.Number,
      }),
    }),
  })
);

/** The agent's name: its path's last segment, `count_ts`. */
const nameOf = (agentPath: string) =>
  agentPath.slice(agentPath.lastIndexOf("/") + 1) || agentPath;

/** The path an agent was spawned under, `/root` for the run's own. */
const parentPath = (agentPath: string) =>
  agentPath.slice(0, Math.max(0, agentPath.lastIndexOf("/")));

/**
 * A reader of one turn's sub-agent notifications. `toolOf` names the tool
 * an item is, as the main thread's lines name it.
 */
export const codexAgents = (
  own: TurnIds,
  toolOf: (notification: AppServerNotification) => string | undefined
) => {
  /** Spawned agents' threads, by thread and by path. */
  const threads = new Set<string>();
  const byPath = new Map<string, string>();
  const toolUses = new Map<string, number>();

  const activity = (
    item: Option.Option.Value<ReturnType<typeof decodeActivity>>["item"]
  ): AgentEvent[] => {
    const id = item.agentThreadId;
    switch (item.kind) {
      case "started": {
        if (threads.has(id)) {
          return [];
        }
        threads.add(id);
        byPath.set(item.agentPath, id);
        return [
          {
            agent: {
              id,
              label: nameOf(item.agentPath),
              parentId: byPath.get(parentPath(item.agentPath)),
              role: "agent",
              status: "running",
            },
            kind: "agent_started",
          },
        ];
      }
      case "interacted": {
        return [{ agent: { id, status: "running" }, kind: "agent_progress" }];
      }
      case "interrupted": {
        return [{ agent: { id, status: "stopped" }, kind: "agent_finished" }];
      }
      default: {
        return [];
      }
    }
  };

  /** What an agent's own thread says: a turn, a tool, its tokens. */
  const childEvents = (
    id: string,
    notification: AppServerNotification
  ): AgentEvent[] => {
    switch (notification.method) {
      case "turn/started": {
        return [{ agent: { id, status: "running" }, kind: "agent_progress" }];
      }
      case "item/started": {
        const tool = toolOf(notification);
        if (tool === undefined) {
          return [];
        }
        const uses = (toolUses.get(id) ?? 0) + 1;
        toolUses.set(id, uses);
        return [
          {
            agent: { id, lastTool: tool, toolUses: uses },
            kind: "agent_progress",
          },
        ];
      }
      case "thread/tokenUsage/updated": {
        return Option.match(decodeUsage(notification.params), {
          onNone: () => [],
          onSome: ({ tokenUsage }) => [
            {
              agent: {
                id,
                tokens:
                  tokenUsage.total.inputTokens + tokenUsage.total.outputTokens,
              },
              kind: "agent_progress",
            },
          ],
        });
      }
      case "turn/completed": {
        return Option.match(decodeTurnEnd(notification.params), {
          onNone: () => [],
          onSome: ({ turn }) => [
            {
              agent: {
                durationMs: turn.durationMs ?? undefined,
                error: turn.error?.message,
                id,
                status: subAgentEndOf(turn.status),
              },
              kind: "agent_finished",
            },
          ],
        });
      }
      default: {
        return [];
      }
    }
  };

  return (notification: AppServerNotification): AgentEvent[] => {
    const thread = Option.getOrUndefined(decodeThread(notification.params));
    if (thread === undefined) {
      return [];
    }
    if (thread.threadId === own.threadId || threads.has(thread.threadId)) {
      const spawned =
        notification.method === "item/started"
          ? Option.getOrUndefined(decodeActivity(notification.params))
          : undefined;
      // A `started` comes as an item twice, started and completed: the
      // first is enough. Other kinds come the same way and are idempotent.
      if (spawned !== undefined) {
        return activity(spawned.item);
      }
    }
    return threads.has(thread.threadId)
      ? childEvents(thread.threadId, notification)
      : [];
  };
};
