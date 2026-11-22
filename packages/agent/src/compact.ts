import { Effect, Stream } from "effect";

import { classifyOutcome } from "./errors";
import type {
  AgentEvent,
  AgentProvider,
  CompactEvent,
  ProviderId,
  ProviderSpec,
} from "./types";

/**
 * A provider's compaction, dressed as a run spec. Compaction has the same shape
 * as a run — one AbortSignal, one event stream — so the generic runner,
 * the per-user single-flight registry and the concurrency cap all apply to it
 * unchanged; only the folding of the stream differs (see foldCompactEvents).
 */
export const compactSpec = (
  id: ProviderId,
  compact: NonNullable<AgentProvider["compact"]>
): ProviderSpec => ({ id, run: compact });

interface CompactFold {
  readonly outcome: CompactEvent | undefined;
  readonly failure: string;
}

const emptyFold: CompactFold = { failure: "", outcome: undefined };

/** One event into the fold. A terminal event already seen wins over a later error. */
const stepCompact = (fold: CompactFold, event: AgentEvent): CompactFold => {
  if (event.kind === "compact_done" || event.kind === "compact_failed") {
    return fold.outcome ? fold : { ...fold, outcome: event };
  }
  if (event.kind === "error") {
    return {
      ...fold,
      failure: event.class ? classifyOutcome(event.class).copy : event.message,
    };
  }
  return fold;
};

/**
 * Fold a compaction run's events into its terminal event. A run that ends
 * without one — interrupted, at capacity, provider crash — becomes a failure
 * carrying the run's own copy, so every path has words for the user. A terminal
 * event already seen wins over a later error: compaction that ran, ran.
 */
export const foldCompactEvents = <E, R>(
  events: Stream.Stream<AgentEvent, E, R>
) =>
  Stream.runFold(events, () => emptyFold, stepCompact).pipe(
    Effect.map(
      ({ failure, outcome }): CompactEvent =>
        outcome ?? {
          kind: "compact_failed",
          reason: failure || "Compaction ended without a result.",
        }
    )
  );
