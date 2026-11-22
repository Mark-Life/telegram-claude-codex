import { Data, Match } from "effect";

/**
 * Why an in-flight run was interrupted (drives structured logs; copy is
 * uniform, except `replaced`). `replaced`: a run parked on background work
 * whose conversation moved on (`/new`, `/compact`, `/history`, a model or
 * effort pick); the chat is told nothing and its session is not stored again.
 * `restart`: a parked run the bot stopped to restart, which it resumes once
 * it is back.
 */
export type InterruptReason =
  | "new_prompt"
  | "replaced"
  | "restart"
  | "stopped"
  | "switched";

/**
 * User/system interrupt of a run (via /stop, provider switch, pre-empting
 * prompt, or a parked run replaced).
 */
export class AgentInterrupted extends Data.TaggedError("AgentInterrupted")<{
  readonly reason: InterruptReason;
}> {}

/** A parked run the user moved on from: nothing to say, nothing to store. */
export const isReplaced = (error: AgentError | undefined) =>
  error?._tag === "AgentInterrupted" && error.reason === "replaced";

/** A parked run the bot stopped for its restart; it continues after boot. */
export const isRestartCut = (error: AgentError | undefined) =>
  error?._tag === "AgentInterrupted" && error.reason === "restart";

/** The provider threw something that is not one of our own errors. */
export class ProviderCrashed extends Data.TaggedError("ProviderCrashed")<{
  readonly message: string;
}> {}

/** Global concurrency cap reached; the run was not started. */
export class AtCapacity extends Data.TaggedError("AtCapacity")<
  Record<string, never>
> {}

/** Failure-channel union for a provider run. */
export type AgentError = AgentInterrupted | ProviderCrashed | AtCapacity;

/**
 * Wide-event run outcome per tag. A table rather than a switch, so adding a
 * member to `AgentError` without an outcome fails to compile.
 */
const RUN_OUTCOME_BY_TAG = {
  AgentInterrupted: "interrupted",
  AtCapacity: "at_capacity",
  ProviderCrashed: "errored",
} as const satisfies Record<AgentError["_tag"], string>;

/**
 * Maps a tagged agent error to a wide-event run outcome. Pure over `_tag`;
 * distinct from `classifyOutcome`, which supplies the user-facing copy.
 */
export const runOutcomeOf = (e: AgentError) => RUN_OUTCOME_BY_TAG[e._tag];

/**
 * Maps a tagged agent error to a user-facing outcome + copy. Pure over `_tag`;
 * the single source of truth for run-outcome wording.
 */
export const classifyOutcome = (e: AgentError) =>
  Match.value(e).pipe(
    Match.tagsExhaustive({
      AgentInterrupted: () =>
        ({ copy: "Stopped.", outcome: "interrupted" }) as const,
      AtCapacity: () =>
        ({ copy: "Busy, try again shortly.", outcome: "at_capacity" }) as const,
      ProviderCrashed: (crashed) =>
        ({ copy: crashed.message, outcome: "errored" }) as const,
    })
  );
