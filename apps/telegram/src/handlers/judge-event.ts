import { hostname } from "node:os";

import { Duration, Effect } from "effect";

import {
  JUDGE_EVENT_MARKER,
  JudgeEvent,
  Observability,
} from "../observability";
import { APP_VERSION } from "./run-event";

/**
 * The one ledger line every judgment writes. Best-effort on its own:
 * `JudgeEvent` validates in its constructor and can throw, and a ledger that
 * cannot be written must never change a decision. `suspend` keeps that throw
 * inside the effect.
 */

type JudgeFields = ConstructorParameters<typeof JudgeEvent>[0];

/** The three fields only the model router fills; every other kind says NULL. */
const ROUTE_FIELDS = {
  pickedEffort: null,
  scores: null,
  tier: null,
} as const satisfies Pick<JudgeFields, "pickedEffort" | "scores" | "tier">;

/**
 * What the caller knows; the host, version and timestamp are added here, and
 * the routing fields default to NULL so a yes/no judge states only its own.
 */
interface Judgment
  extends
    Omit<
      JudgeFields,
      | "durationMs"
      | "event"
      | "host"
      | "pickedEffort"
      | "scores"
      | "tier"
      | "ts"
      | "version"
    >,
    Partial<Pick<JudgeFields, "pickedEffort" | "scores" | "tier">> {
  elapsed: Duration.Duration;
}

export const recordJudgment = ({ elapsed, ...fields }: Judgment) =>
  Effect.suspend(() =>
    Effect.flatMap(Observability, (observability) =>
      observability.recordJudge(
        new JudgeEvent({
          ...ROUTE_FIELDS,
          ...fields,
          durationMs: Math.round(Duration.toMillis(elapsed)),
          event: JUDGE_EVENT_MARKER,
          host: hostname(),
          ts: new Date().toISOString(),
          version: APP_VERSION,
        })
      )
    )
  ).pipe(Effect.catchCause(() => Effect.void));
