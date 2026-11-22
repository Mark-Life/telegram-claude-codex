import type {
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";

import { isSubAgentEnd, subAgentEndOf } from "./types";
import type { AgentEvent, SubAgentStatus, WorkflowWave } from "./types";

/**
 * Claude Code's task frames as sub-agent events. A `Task`/`Agent` call is a
 * `local_agent` task with frames of its own. A `Workflow` is one
 * `local_workflow` task: its agents get no task, and come only in the
 * `workflow_progress` snapshot some of its `task_progress` frames carry
 * (every phase and every agent so far; the SDK's types leave the field
 * out). Background shells, monitors and MCP tasks are not agents.
 */

/** The tasks the board shows, by task type. */
const ROLES: ReadonlyMap<string, "agent" | "workflow"> = new Map([
  ["local_agent", "agent"],
  ["local_workflow", "workflow"],
  ["remote_agent", "agent"],
]);

/** One agent of a workflow snapshot, as the CLI sends it. */
const WorkflowAgent = Schema.Struct({
  agentType: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Unknown),
  index: Schema.Number,
  label: Schema.String,
  lastToolName: Schema.optional(Schema.String),
  phaseIndex: Schema.optional(Schema.Number),
  skipped: Schema.optional(Schema.Boolean),
  startedAt: Schema.optional(Schema.Number),
  state: Schema.String,
  tokens: Schema.optional(Schema.Number),
  toolCalls: Schema.optional(Schema.Number),
  type: Schema.Literal("workflow_agent"),
});

const WorkflowPhase = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  type: Schema.Literal("workflow_phase"),
});

/** A failed agent's error: a sentence, or an object carrying one. */
const decodeErrorText = Schema.decodeUnknownOption(Schema.String);
const decodeErrorMessage = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.String })
);
const errorOf = (agent: typeof WorkflowAgent.Type) =>
  Option.getOrUndefined(decodeErrorText(agent.error)) ??
  Option.getOrUndefined(decodeErrorMessage(agent.error))?.message;

/** The snapshot; an entry of another type is skipped, not a failure. */
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({ workflow_progress: Schema.Array(Schema.Unknown) })
);
const decodeAgent = Schema.decodeUnknownOption(WorkflowAgent);
const decodePhase = Schema.decodeUnknownOption(WorkflowPhase);

/** A workflow agent's state as a status; `start` before `startedAt` is queued. */
const agentStatus = (agent: typeof WorkflowAgent.Type): SubAgentStatus => {
  switch (agent.state) {
    case "done": {
      return "done";
    }
    // A skip the user asked for comes as an error marked skipped.
    case "error": {
      return agent.skipped === true ? "stopped" : "failed";
    }
    case "start": {
      return agent.startedAt === undefined ? "pending" : "running";
    }
    default: {
      return "running";
    }
  }
};

/** What a task is to the board: an agent, a workflow, or neither. */
const roleOf = (message: SDKTaskStartedMessage) =>
  message.ambient === true
    ? undefined
    : ROLES.get(message.task_type ?? "local_agent");

type Finished = Extract<AgentEvent, { kind: "agent_finished" }>["agent"];

/** What the mapper remembers across a run's frames. */
export const claudeAgents = () => {
  /** Agent and workflow tasks this run started, by task id. */
  const tasks = new Map<string, "agent" | "workflow">();
  /** Workflow agents already seen; tasks and agents that ended. */
  const seen = new Set<string>();
  const ended = new Set<string>();

  const finish = (agent: Finished): AgentEvent => {
    ended.add(agent.id);
    return { agent, kind: "agent_finished" };
  };

  /** The events of one workflow agent in a snapshot. */
  const snapshotAgent = (
    workflowId: string,
    agent: typeof WorkflowAgent.Type
  ): AgentEvent[] => {
    const id = `${workflowId}/${agent.index}`;
    const status = agentStatus(agent);
    // A retry (a stall, a rate limit) comes back under the same index after
    // its error: live again.
    if (ended.has(id)) {
      if (isSubAgentEnd(status)) {
        return [];
      }
      ended.delete(id);
    }
    const stats = {
      durationMs: agent.durationMs,
      id,
      lastTool: agent.lastToolName,
      tokens: agent.tokens,
      toolUses: agent.toolCalls,
    };
    const events: AgentEvent[] = [];
    if (!seen.has(id)) {
      seen.add(id);
      events.push({
        agent: {
          ...stats,
          agentType: agent.agentType,
          label: agent.label,
          parentId: workflowId,
          role: "agent",
          status: status === "pending" ? "pending" : "running",
          wave: agent.phaseIndex,
        },
        kind: "agent_started",
      });
    }
    events.push(
      isSubAgentEnd(status)
        ? finish({
            ...stats,
            error: status === "failed" ? errorOf(agent) : undefined,
            status,
          })
        : { agent: { ...stats, status }, kind: "agent_progress" }
    );
    return events;
  };

  /** A snapshot's waves, then the events of each agent in it. */
  const snapshot = (
    workflowId: string,
    entries: readonly unknown[]
  ): AgentEvent[] => {
    const waves: WorkflowWave[] = entries.flatMap((entry) =>
      Option.toArray(decodePhase(entry)).map(({ index, title }) => ({
        index,
        title,
      }))
    );
    const events: AgentEvent[] =
      waves.length > 0
        ? [{ agent: { id: workflowId, waves }, kind: "agent_progress" }]
        : [];
    for (const entry of entries) {
      for (const agent of Option.toArray(decodeAgent(entry))) {
        events.push(...snapshotAgent(workflowId, agent));
      }
    }
    return events;
  };

  const started = (message: SDKTaskStartedMessage): AgentEvent[] => {
    const role = roleOf(message);
    if (role === undefined) {
      return [];
    }
    tasks.set(message.task_id, role);
    // A resumed task keeps its id: it is live again, its workflow agents
    // with it.
    ended.delete(message.task_id);
    for (const id of [...ended, ...seen]) {
      if (id.startsWith(`${message.task_id}/`)) {
        ended.delete(id);
        seen.delete(id);
      }
    }
    const parent = message.parent_task_id;
    return [
      {
        agent: {
          agentType: message.subagent_type,
          id: message.task_id,
          label:
            role === "workflow"
              ? (message.workflow_name ?? message.description)
              : message.description,
          parentId:
            parent !== undefined && tasks.has(parent) ? parent : undefined,
          role,
          status: "running",
        },
        kind: "agent_started",
      },
    ];
  };

  const progress = (message: SDKTaskProgressMessage): AgentEvent[] => {
    const role = tasks.get(message.task_id);
    if (role === undefined || ended.has(message.task_id)) {
      return [];
    }
    const own: AgentEvent = {
      agent: {
        durationMs: message.usage.duration_ms,
        id: message.task_id,
        // A workflow names the agent that moved here, not a tool.
        lastTool: role === "agent" ? message.last_tool_name : undefined,
        status: "running",
        tokens: message.usage.total_tokens,
        toolUses: message.usage.tool_uses,
      },
      kind: "agent_progress",
    };
    if (role === "agent") {
      return [own];
    }
    return [
      own,
      ...Option.toArray(decodeSnapshot(message)).flatMap((progressed) =>
        snapshot(message.task_id, progressed.workflow_progress)
      ),
    ];
  };

  const updated = (message: SDKTaskUpdatedMessage): AgentEvent[] => {
    const { error, status } = message.patch;
    const id = message.task_id;
    if (!tasks.has(id) || ended.has(id) || status === undefined) {
      return [];
    }
    if (status === "pending" || status === "paused") {
      return [{ agent: { id, status: "pending" }, kind: "agent_progress" }];
    }
    if (status === "running") {
      return [{ agent: { id, status: "running" }, kind: "agent_progress" }];
    }
    return [finish({ error, id, status: subAgentEndOf(status) })];
  };

  // The last word on a task, after its `task_updated`: the final usage
  // comes only here.
  const notified = (message: SDKTaskNotificationMessage): AgentEvent[] =>
    tasks.has(message.task_id)
      ? [
          finish(
            message.usage === undefined
              ? { id: message.task_id, status: subAgentEndOf(message.status) }
              : {
                  durationMs: message.usage.duration_ms,
                  id: message.task_id,
                  status: subAgentEndOf(message.status),
                  tokens: message.usage.total_tokens,
                  toolUses: message.usage.tool_uses,
                }
          ),
        ]
      : [];

  /** One frame's sub-agent events. */
  return (message: SDKMessage): AgentEvent[] => {
    if (message.type !== "system") {
      return [];
    }
    if (message.subtype === "task_started") {
      return started(message);
    }
    if (message.subtype === "task_progress") {
      return progress(message);
    }
    if (message.subtype === "task_updated") {
      return updated(message);
    }
    return message.subtype === "task_notification" ? notified(message) : [];
  };
};

/** The mapper of one run's frames. */
export type ClaudeAgents = ReturnType<typeof claudeAgents>;
