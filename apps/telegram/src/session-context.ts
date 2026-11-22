import type { AgentEvent, ProviderId } from "@workspace/agent/types";
import { SessionContextRepo } from "@workspace/db";
import { Effect } from "effect";

import { logPersistenceError } from "./db/bridge";

/**
 * Record how full a run's session is, for `/context`. Never fails: a lost
 * figure costs one stale `/context`, a failed run would cost the answer.
 */
export const recordSessionContext = (input: {
  event: Extract<AgentEvent, { kind: "context" }>;
  /** The model the run is on, when the provider names none. */
  model: string | undefined;
  provider: ProviderId;
}) => {
  const { event } = input;
  return SessionContextRepo.use((repo) =>
    repo.record({
      baselineTokens: event.baselineTokens,
      compactAt: event.compactAt,
      model: event.model ?? input.model,
      modelWindowTokens: event.modelWindowTokens,
      provider: input.provider,
      sessionId: event.sessionId,
      usedTokens: event.usedTokens,
      windowTokens: event.windowTokens,
    })
  ).pipe(
    Effect.catchTag("PersistenceError", logPersistenceError),
    Effect.catchDefect((defect) =>
      Effect.logWarning("session context not recorded", defect)
    )
  );
};
