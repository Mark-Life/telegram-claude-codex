import { LIGHT_ACCESS, OWNER_ACCESS } from "@workspace/agent/types";
import type { RunAccess } from "@workspace/agent/types";
import type { TaskAuthor, TaskStamp } from "@workspace/db";

import type { Surface, Tier } from "./tier";

/**
 * What one run is allowed to do, decided from who asked and where. This is the
 * whole gating matrix: `agent` travels to the provider as plain data, the rest
 * is what the bot itself does differently.
 */
export interface AccessDecision {
  agent: RunAccess;
  /** Render quietly whatever the stored verbosity says (group runs). */
  forceQuiet: boolean;
  /**
   * Run in a scratch directory instead of the chosen project: the sender's
   * own (`user`), or the group's, shared by its members (`chat`).
   */
  scratch: "chat" | "user" | false;
}

/**
 * A lightweight group run with web search and only that group's memory, in
 * the group's own directory, which holds the files its members sent.
 */
const GROUP_DECISION = {
  agent: LIGHT_ACCESS,
  forceQuiet: true,
  scratch: "chat",
} as const satisfies AccessDecision;

/**
 * A tier-1 user gets the owner's execution profile without owner identity:
 * the machine, project directory, Executor, sessions, the recurring-task CLI
 * and the owner's Telegram account, but no other administrative helper
 * instructions. Account writes follow the same `confirm`/`direct` mode as the
 * owner's, and under `confirm` only the owner can press the button.
 */
const EXECUTOR_DECISION = {
  agent: {
    ...OWNER_ACCESS,
    adminScripts: false,
    groupMemory: "none",
    workspaceMemory: "executor",
  },
  forceQuiet: false,
  scratch: false,
} as const satisfies AccessDecision;

/** A tier-2 user: builds things in their scratch dir, no Executor to leak. */
const MEMBER_DECISION = {
  agent: {
    adminScripts: false,
    externalTools: false,
    groupMemory: "none",
    modelClass: "light",
    persistSession: true,
    priority: "normal",
    sandbox: "workspace-write",
    telegramAccount: false,
    webSearch: true,
    workspaceMemory: "none",
  },
  forceQuiet: false,
  scratch: "user",
} as const satisfies AccessDecision;

/** The stamp a tier writes tasks under; none for a tier that cannot. */
const authorOf = (tier: Tier): TaskAuthor | undefined => {
  if (tier === "owner") {
    return "owner";
  }
  return tier === "executor" ? "executor" : undefined;
};

/**
 * Whether a task runs with the owner's Telegram account. A task that names
 * the user who wrote it holds the account while that user's tier now matches
 * the stamped one, so a revoked or demoted executor's tasks lose it at their
 * next fire, and a stamp an older build rewrote without the id (an executor's
 * edit over the owner's id) does not borrow the owner's tier. A task without
 * an id (written before ids were kept) holds it only when the owner wrote it;
 * one written from a run without the account carries `executor` with no id and
 * never holds it. `writer` is that user's tier now, undefined when the task
 * names nobody.
 */
export const taskHoldsAccount = (input: {
  author: TaskAuthor | undefined;
  writer: Tier | undefined;
}) =>
  input.writer === undefined
    ? input.author === "owner"
    : input.author !== undefined && input.author === authorOf(input.writer);

/**
 * A task runs on the owner's profile when the owner wrote it: named, the
 * writer's tier now; unnamed, any stamp but `executor` (a task from before
 * stamps were kept was the owner's).
 */
const isOwnerWritten = (input: {
  author: TaskAuthor | undefined;
  writer: Tier | undefined;
}) =>
  input.writer === undefined
    ? input.author !== "executor"
    : input.writer === "owner";

/**
 * What a scheduled task runs as: the owner's profile, keeping no session
 * unless the task keeps its own (`keepSession`, an `own` task), whose id the
 * scheduler stores on the task. A fresh fire's session is not kept for the
 * next fire: a task fires on its own clock, and neither kind ever becomes the
 * conversation the owner's next message continues (a run with a thread id
 * never writes the per-project session). On Claude, a fire that waits on
 * background work persists its session meanwhile, so a restart can resume
 * it; a fresh fire's transcript is deleted once the fire ended. A task
 * whose writer is not the owner (`isOwnerWritten`) runs on the executor's
 * profile (no owner-only helpers, the executor's memory), so a task never
 * reaches more than its writer could in chat. The owner's Telegram account
 * only when `taskHoldsAccount` says so. A `route` task does not run as this:
 * it runs in a chat's conversation, on its writer's chat access there
 * (`tasks/route-run.ts`).
 */
export const scheduledAccessFor = (input: {
  author: TaskAuthor | undefined;
  holdsAccount: boolean;
  keepSession?: boolean;
  writer: Tier | undefined;
}) =>
  ({
    ...(isOwnerWritten(input) ? OWNER_ACCESS : EXECUTOR_DECISION.agent),
    persistSession: input.keepSession === true,
    telegramAccount: input.holdsAccount,
  }) satisfies RunAccess;

/**
 * Who a task written from a chat run is stamped with: the owner or an
 * executor, by id. Every other tier gets no stamp, so its tasks never run
 * with the owner's account (it cannot write tasks anyway).
 */
export const taskStampFor = (input: {
  tier: Tier;
  userId: number;
}): TaskStamp | undefined => {
  const author = authorOf(input.tier);
  return author === undefined ? undefined : { author, userId: input.userId };
};

/**
 * A quick reference explicitly summoned from one of the owner's Business
 * chats. It may use the web, but never inherits the owner's account tools,
 * administrative helpers or session. The owner initiated it, so it keeps
 * normal priority even though the filesystem posture is read-only.
 */
export const BUSINESS_ACCESS = {
  adminScripts: false,
  externalTools: false,
  groupMemory: "none",
  modelClass: "light",
  persistSession: false,
  priority: "normal",
  sandbox: "read-only",
  telegramAccount: false,
  webSearch: true,
  workspaceMemory: "none",
} as const satisfies RunAccess;

/** The owner in their own chat or workspace: the machine, as before tiers. */
const OWNER_DECISION = {
  agent: OWNER_ACCESS,
  forceQuiet: false,
  scratch: false,
} as const satisfies AccessDecision;

const GUEST_DECISION = {
  ...GROUP_DECISION,
  agent: { ...GROUP_DECISION.agent, groupMemory: "none" },
  scratch: "user",
} as const satisfies AccessDecision;

/**
 * Keep the surface's filesystem posture while hiding every external tool,
 * the owner's Telegram account included.
 */
const withoutExternalTools = (decision: AccessDecision): AccessDecision => ({
  ...decision,
  agent: { ...decision.agent, externalTools: false, telegramAccount: false },
});

/**
 * Resolve the privileges of a run.
 *
 * Two rules, in this order. A group is always lightweight, for everyone
 * including the owner: no writes, no external tools, no session kept. The
 * workspace forum keeps its normal filesystem posture but receives no account
 * apps, plugins or inherited MCP servers. Ordinary groups receive only the
 * current-chat memory server. Account tools, the owner's Telegram account
 * included, exist only in a private chat for the owner and Executor-enabled
 * users. Owner-only bot administration remains
 * a separate flag. Only the owner and Executor-enabled users get the main model
 * operators choose with /model; groups, guests and members run on the light one.
 */
export const runAccessFor = (input: {
  surface: Surface;
  tier: Tier;
}): AccessDecision => {
  if (input.surface === "group") {
    return GROUP_DECISION;
  }
  const decision = (() => {
    switch (input.tier) {
      case "owner": {
        return OWNER_DECISION;
      }
      case "executor": {
        return EXECUTOR_DECISION;
      }
      case "member": {
        return MEMBER_DECISION;
      }
      case "guest": {
        // Anyone may open a private conversation without /start or a prior
        // grant. Ungranted users get the same short-lived, read-only profile as
        // group runs, isolated in their own scratch directory.
        return GUEST_DECISION;
      }
      default: {
        return GUEST_DECISION;
      }
    }
  })();
  return input.surface === "private"
    ? decision
    : withoutExternalTools(decision);
};
