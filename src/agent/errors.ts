import { Data } from "effect";

/** Why an in-flight run was interrupted (drives structured logs; copy is uniform). */
export type InterruptReason = "stopped" | "switched" | "new_prompt";

/** User/system interrupt of a run (via /stop, provider switch, or pre-empting prompt). */
export class AgentInterrupted extends Data.TaggedError("AgentInterrupted")<{
  readonly reason: InterruptReason;
}> {}

/** Run exceeded the opt-in RUN_TIMEOUT_MS cap. */
export class AgentTimedOut extends Data.TaggedError("AgentTimedOut")<
  Record<string, never>
> {}

/** Provider CLI exited non-zero. */
export class ProcessFailed extends Data.TaggedError("ProcessFailed")<{
  readonly code: number;
  readonly stderr: string;
}> {}

/** Spawn/read defect (command missing, stream error, etc.). */
export class ProviderCrashed extends Data.TaggedError("ProviderCrashed")<{
  readonly message: string;
}> {}

/** Global concurrency cap reached; the run was not started. */
export class AtCapacity extends Data.TaggedError("AtCapacity")<
  Record<string, never>
> {}

/** Failure-channel union for a provider run. */
export type AgentError =
  | AgentInterrupted
  | AgentTimedOut
  | ProcessFailed
  | ProviderCrashed
  | AtCapacity;

/**
 * Maps a tagged agent error to a wide-event run outcome. Pure over `_tag`;
 * distinct from `classifyOutcome` (which supplies user-facing copy and collapses
 * timeout into interrupted).
 */
export const runOutcomeOf = (
  e: AgentError
): "interrupted" | "timeout" | "errored" | "at_capacity" => {
  switch (e._tag) {
    case "AgentInterrupted":
      return "interrupted";
    case "AgentTimedOut":
      return "timeout";
    case "AtCapacity":
      return "at_capacity";
    default:
      return "errored";
  }
};

/**
 * Maps a tagged agent error to a user-facing outcome + copy. Pure over `_tag`;
 * the single source of truth for run-outcome wording.
 */
export const classifyOutcome = (e: AgentError) => {
  switch (e._tag) {
    case "AgentInterrupted":
      return { outcome: "interrupted", copy: "Stopped." } as const;
    case "AgentTimedOut":
      return { outcome: "interrupted", copy: "Timed out." } as const;
    case "AtCapacity":
      return {
        outcome: "at_capacity",
        copy: "Busy, try again shortly.",
      } as const;
    case "ProcessFailed":
      return {
        outcome: "errored",
        copy: e.stderr.trim() || `Process failed (exit ${e.code}).`,
      } as const;
    case "ProviderCrashed":
      return { outcome: "errored", copy: e.message } as const;
    default: {
      // Exhaustive: a new tag makes this assignment a compile error.
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
};
