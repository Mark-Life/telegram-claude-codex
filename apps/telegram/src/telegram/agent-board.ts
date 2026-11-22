import { isSubAgentEnd } from "@workspace/agent/types";
import type {
  AgentEvent,
  SubAgentStart,
  SubAgentStatus,
  WorkflowWave,
} from "@workspace/agent/types";

import { t } from "../i18n";
import {
  bar,
  escapeHtml,
  MAX_MSG_LENGTH,
  shortTokens,
  truncate,
} from "./format";
import type { EventOf } from "./format";

/**
 * The sub-agents and workflows of one run as the chat shows them: one board
 * per batch, drawn as one message the run edits in place. The board is plain
 * data; `agent-status.ts` sends, edits and pins it.
 */

/** Per-agent lines a board shows; past it, the rest are counted. */
const MAX_AGENT_LINES = 10;
/** Folded waves shown one by one; older ones share a line. */
const MAX_FOLDED_WAVES = 3;
/** A folded wave names its agents up to this many; past it, counts them. */
const MAX_NAMED_IN_WAVE = 4;
/** How much of a failure's error a finished board quotes. */
const MAX_ERROR_CHARS = 160;
/** How much of a label a line keeps. */
const MAX_LABEL_CHARS = 60;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const FULL = 100;
const SECTION_BREAK = "\n\n";

const ICONS = {
  done: "✅",
  failed: "❌",
  pending: "⏳",
  running: "🔄",
  stopped: "⏹",
} as const satisfies Record<SubAgentStatus, string>;

export type AgentEventOf = EventOf<
  "agent_finished" | "agent_progress" | "agent_started"
>;

/** Whether an event is a sub-agent's. */
export const isAgentEvent = (event: AgentEvent): event is AgentEventOf =>
  event.kind === "agent_started" ||
  event.kind === "agent_progress" ||
  event.kind === "agent_finished";

interface AgentNode
  extends
    Omit<SubAgentStart, "status">,
    Partial<Record<"endedAt" | "startedAt", number>> {
  durationMs?: number;
  error?: string;
  status: SubAgentStatus;
  waves?: readonly WorkflowWave[];
}

export interface AgentBoard {
  /** In the order they started. */
  readonly nodes: Map<string, AgentNode>;
  readonly openedAt: number;
}

export const emptyBoard = (now: number): AgentBoard => ({
  nodes: new Map(),
  openedAt: now,
});

const childrenOf = (board: AgentBoard, id: string) =>
  [...board.nodes.values()].filter((node) => node.parentId === id);

/**
 * Fold one event into the board. An event about an agent the board never
 * saw start is dropped: it belongs to an earlier batch.
 */
export const applyAgentEvent = (
  board: AgentBoard,
  event: AgentEventOf,
  now: number
) => {
  const known = board.nodes.get(event.agent.id);
  if (event.kind === "agent_started") {
    // A start again (a resumed task) is a new clock.
    const again = known !== undefined && isSubAgentEnd(known.status);
    const node: AgentNode = {
      ...known,
      ...event.agent,
      endedAt: undefined,
      startedAt:
        (again ? undefined : known?.startedAt) ??
        (event.agent.status === "running" ? now : undefined),
    };
    // What the last run ended with is not this one's.
    if (again) {
      node.durationMs = event.agent.durationMs;
      node.error = undefined;
    }
    board.nodes.set(event.agent.id, node);
    return;
  }
  if (known === undefined) {
    return;
  }
  const wasEnded = isSubAgentEnd(known.status);
  Object.assign(known, event.agent);
  if (event.kind === "agent_progress") {
    if (known.status === "running") {
      // Back at work after it ended (a Codex agent handed more input): a
      // new clock, as for a start again.
      if (wasEnded) {
        known.startedAt = now;
        known.durationMs = event.agent.durationMs;
        known.error = undefined;
      }
      known.startedAt ??= now;
      known.endedAt = undefined;
    }
    return;
  }
  known.endedAt = now;
  known.startedAt ??= now;
  // A workflow's last snapshot may lag its end: what it left open ends
  // with it, done when it is done, stopped otherwise. A sub-agent's own
  // agents report their own ends.
  if (known.role !== "workflow") {
    return;
  }
  for (const child of childrenOf(board, known.id)) {
    if (!isSubAgentEnd(child.status)) {
      child.status = known.status === "done" ? "done" : "stopped";
      child.endedAt = now;
    }
  }
};

/** Whether the board has something and all of it ended. */
export const boardSettled = (board: AgentBoard) =>
  board.nodes.size > 0 &&
  [...board.nodes.values()].every((node) => isSubAgentEnd(node.status));

/** End whatever still runs, as stopped: the run is over. */
export const closeBoard = (board: AgentBoard, now: number) => {
  for (const node of board.nodes.values()) {
    if (!isSubAgentEnd(node.status)) {
      node.status = "stopped";
      node.endedAt = now;
    }
  }
};

/** An elapsed time in the bot's language. */
const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.round(ms / MS_PER_SECOND));
  const seconds = total % SECONDS_PER_MINUTE;
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const hours = Math.floor(total / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  return t().agents.duration(hours, minutes, seconds);
};

const elapsedOf = (node: AgentNode, now: number) => {
  if (isSubAgentEnd(node.status) && node.durationMs !== undefined) {
    return node.durationMs;
  }
  return node.startedAt === undefined
    ? undefined
    : (node.endedAt ?? now) - node.startedAt;
};

/** What may stand between a wave's title and the rest of a label. */
const LABEL_SEPARATOR_RE = /^[\s:/._-]+(?=\S)/u;

/**
 * A label as its line shows it: under its wave, without the start that
 * repeats the wave's title (`hermes` for `research:hermes` in Research).
 */
const labelOf = (board: AgentBoard, node: AgentNode) => {
  const parent =
    node.parentId === undefined ? undefined : board.nodes.get(node.parentId);
  const title = parent?.waves?.find((wave) => wave.index === node.wave)?.title;
  if (
    title === undefined ||
    node.label.slice(0, title.length).toLowerCase() !== title.toLowerCase()
  ) {
    return node.label;
  }
  const rest = node.label.slice(title.length);
  const separator = LABEL_SEPARATOR_RE.exec(rest);
  return separator === null ? node.label : rest.slice(separator[0].length);
};

/** `🔄 Count files (Explore) · Bash · 12 s`. */
const agentLine = (
  board: AgentBoard,
  node: AgentNode,
  now: number,
  depth: number
) => {
  const parts = [
    `${ICONS[node.status]} ${escapeHtml(truncate(labelOf(board, node), MAX_LABEL_CHARS))}`,
  ];
  if (node.agentType !== undefined && node.agentType !== "general-purpose") {
    parts[0] += ` <i>(${escapeHtml(node.agentType)})</i>`;
  }
  if (node.status === "running" && node.lastTool !== undefined) {
    parts.push(
      `<code>${escapeHtml(truncate(node.lastTool, MAX_LABEL_CHARS))}</code>`
    );
  }
  const elapsed = elapsedOf(node, now);
  if (elapsed !== undefined) {
    parts.push(formatElapsed(elapsed));
  }
  const line = `${"  ".repeat(depth)}${parts.join(" · ")}`;
  return node.status === "failed" && node.error !== undefined
    ? `${line}\n${"  ".repeat(depth + 1)}<i>${escapeHtml(truncate(node.error, MAX_ERROR_CHARS))}</i>`
    : line;
};

/** Which agents a crowded list shows first, and the order counts read in. */
const BY_RANK = [
  "running",
  "failed",
  "pending",
  "stopped",
  "done",
] as const satisfies readonly SubAgentStatus[];

/** `2 ✅ · 1 ❌`: a list's statuses, counted. */
const counts = (nodes: readonly AgentNode[]) =>
  BY_RANK.flatMap((status) => {
    const count = nodes.filter((node) => node.status === status).length;
    return count === 0 ? [] : [`${count} ${ICONS[status]}`];
  }).join(" · ");

/**
 * Lines for a list of agents with their own sub-agents under them, at most
 * `budget` of them; the rest are counted on one line. Shown in the order
 * they started, chosen by status (running first, done last).
 */
const agentLines = (
  board: AgentBoard,
  nodes: readonly AgentNode[],
  now: number,
  budget: { left: number },
  depth = 0
): string[] => {
  const shown = new Set(
    BY_RANK.flatMap((status) =>
      nodes.filter((node) => node.status === status)
    ).slice(0, Math.max(0, budget.left))
  );
  budget.left -= shown.size;
  const lines: string[] = [];
  for (const node of nodes) {
    if (shown.has(node)) {
      lines.push(agentLine(board, node, now, depth));
      const children = childrenOf(board, node.id);
      if (children.length > 0) {
        lines.push(...agentLines(board, children, now, budget, depth + 1));
      }
    }
  }
  const hidden = nodes.filter((node) => !shown.has(node));
  if (hidden.length > 0) {
    lines.push(
      `${"  ".repeat(depth)}<i>${t().agents.more(hidden.length)}: ${counts(hidden)}</i>`
    );
  }
  return lines;
};

/** The wave a workflow is on: the last one with an agent that started. */
const currentWave = (agents: readonly AgentNode[]) =>
  Math.max(
    0,
    ...agents.flatMap((agent) =>
      agent.status === "pending" ? [] : [agent.wave ?? 0]
    )
  );

/** A workflow's waves, the ones the script declared or its agents named. */
const wavesOf = (workflow: AgentNode, agents: readonly AgentNode[]) => {
  const declared = new Map(
    (workflow.waves ?? []).map((wave) => [wave.index, wave.title])
  );
  for (const agent of agents) {
    if (agent.wave !== undefined && !declared.has(agent.wave)) {
      declared.set(agent.wave, String(agent.wave));
    }
  }
  const last = Math.max(0, ...declared.keys());
  const waves: WorkflowWave[] = [];
  for (let index = 1; index <= last; index += 1) {
    const title = declared.get(index);
    if (title !== undefined) {
      waves.push({ index, title });
    }
  }
  return waves;
};

/**
 * A workflow: its header, then each wave. A wave that ended folds into one
 * line, and so does every wave of a finished board; the wave that runs
 * lists its agents.
 */
const workflowLines = (
  board: AgentBoard,
  workflow: AgentNode,
  now: number,
  budget: { left: number },
  final: boolean
) => {
  const agents = childrenOf(board, workflow.id);
  const waves = wavesOf(workflow, agents);
  const current = currentWave(agents);
  const header = [
    `${ICONS[workflow.status]} <b>${escapeHtml(t().agents.workflow(truncate(workflow.label, MAX_LABEL_CHARS)))}</b>`,
  ];
  if (!final && current > 0 && waves.length > 0) {
    header.push(t().agents.wave(current, waves.length));
  }
  const lines = [header.join(" · ")];
  const unwaved = agents.filter((agent) => agent.wave === undefined);
  const inWave = (index: number) =>
    agents.filter((agent) => agent.wave === index);
  const folds = (index: number) =>
    final ||
    (index !== current &&
      inWave(index).every((agent) => isSubAgentEnd(agent.status)));
  const failuresOf = (members: readonly AgentNode[]) =>
    agentLines(
      board,
      members.filter((agent) => agent.status === "failed"),
      now,
      budget,
      1
    );
  const shown = waves.filter((wave) => inWave(wave.index).length > 0);
  // The waves from the first that all folded: past a few, the oldest of
  // them share one line.
  const leading = shown.findIndex((wave) => !folds(wave.index));
  const folded = leading === -1 ? shown : shown.slice(0, leading);
  const merged = new Set(
    folded.slice(0, Math.max(0, folded.length - MAX_FOLDED_WAVES + 1))
  );
  if (merged.size > 1) {
    const indexes = [...merged].map((wave) => wave.index);
    const members = agents.filter(
      (agent) => agent.wave !== undefined && indexes.includes(agent.wave)
    );
    lines.push(
      `${t().agents.waves(Math.min(...indexes), Math.max(...indexes))} — ${counts(members)}`,
      ...failuresOf(members)
    );
  }
  for (const wave of waves) {
    const members = inWave(wave.index);
    if (members.length === 0 || (merged.size > 1 && merged.has(wave))) {
      continue;
    }
    if (folds(wave.index)) {
      const named =
        members.length <= MAX_NAMED_IN_WAVE
          ? members
              .map(
                (agent) =>
                  `${ICONS[agent.status]} ${escapeHtml(truncate(labelOf(board, agent), MAX_LABEL_CHARS))}`
              )
              .join(", ")
          : counts(members);
      lines.push(
        `${escapeHtml(truncate(wave.title, MAX_LABEL_CHARS))} — ${named}`,
        ...failuresOf(members)
      );
    } else {
      lines.push(
        `<i>${escapeHtml(truncate(wave.title, MAX_LABEL_CHARS))}</i>`,
        ...agentLines(board, members, now, budget, 1)
      );
    }
  }
  if (unwaved.length > 0) {
    lines.push(...agentLines(board, unwaved, now, budget, 1));
  }
  return lines;
};

/** The agents a board counts: every one but the workflows themselves. */
const leaves = (board: AgentBoard) =>
  [...board.nodes.values()].filter((node) => node.role === "agent");

/**
 * Tokens so far: a workflow's own count, which covers its agents (else
 * theirs), plus every other agent's, each of which counts its own thread.
 */
const tokensOf = (board: AgentBoard) => {
  let sum = 0;
  for (const node of board.nodes.values()) {
    const parent =
      node.parentId === undefined ? undefined : board.nodes.get(node.parentId);
    if (node.role === "workflow") {
      sum +=
        node.tokens ??
        childrenOf(board, node.id).reduce(
          (total, child) => total + (child.tokens ?? 0),
          0
        );
    } else if (parent?.role !== "workflow") {
      sum += node.tokens ?? 0;
    }
  }
  return sum;
};

/** `3/7 done · 1 failed · 2m10s · 84k tokens`. */
const totals = (board: AgentBoard, now: number) => {
  const agents = leaves(board);
  const ended = agents.filter((agent) => isSubAgentEnd(agent.status)).length;
  const done = agents.filter((agent) => agent.status === "done").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const stopped = agents.filter((agent) => agent.status === "stopped").length;
  const ends = [...board.nodes.values()].map((node) => node.endedAt ?? now);
  const elapsed = Math.max(...ends, board.openedAt) - board.openedAt;
  const parts = [t().agents.progress(done, agents.length)];
  if (failed > 0) {
    parts.push(t().agents.failed(failed));
  }
  if (stopped > 0) {
    parts.push(t().agents.stopped(stopped));
  }
  parts.push(formatElapsed(elapsed));
  const tokens = tokensOf(board);
  if (tokens > 0) {
    parts.push(t().agents.tokens(shortTokens(tokens)));
  }
  return {
    line: parts.join(" · "),
    percent: agents.length === 0 ? 0 : (ended * FULL) / agents.length,
  };
};

/**
 * The board as one HTML message. Live, it lists what runs with the overall
 * bar; `final`, it is the run's summary: each plain sub-agent with its time,
 * every wave folded (its agents named, or counted past a few; past three
 * folded waves the oldest share one line), and failures with their error.
 */
export const renderBoard = (board: AgentBoard, now: number, final: boolean) => {
  const budget = { left: MAX_AGENT_LINES };
  const top = [...board.nodes.values()].filter(
    (node) => node.parentId === undefined || !board.nodes.has(node.parentId)
  );
  const workflows = top.filter((node) => node.role === "workflow");
  const agents = top.filter((node) => node.role === "agent");
  const sections: string[] = [];
  for (const workflow of workflows) {
    sections.push(
      workflowLines(board, workflow, now, budget, final).join("\n")
    );
  }
  if (agents.length > 0) {
    sections.push(
      [
        `<b>${t().agents.title}</b>`,
        ...agentLines(board, agents, now, budget),
      ].join("\n")
    );
  }
  const sum = totals(board, now);
  const footer = final ? sum.line : `${sum.line}\n${bar(sum.percent)}`;
  const body = sections.join(SECTION_BREAK);
  const room = MAX_MSG_LENGTH - footer.length - SECTION_BREAK.length;
  // A board of long labels and errors could still pass the limit: cut it
  // at a line, never inside a tag.
  const fitted =
    body.length <= room
      ? body
      : `${body.slice(0, body.lastIndexOf("\n", room - 1))}\n…`;
  return `${fitted}${SECTION_BREAK}${footer}`;
};
