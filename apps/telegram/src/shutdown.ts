import {
  closeRunInboxes,
  listTurns,
  stopAll,
  turnCount,
  waitForTurnsIdleFor,
} from "@workspace/agent";
import { Effect } from "effect";

import type { PendingWork } from "./pending-work";
import { prepareRestart } from "./runs/continuation";
import { describeTurns } from "./turn-watch";

const MS_PER_MINUTE = 60_000;
const DRAIN_TIMEOUT_MINUTES = 30;
/** Fits inside `TimeoutStopSec` in `deploy/bot.service`. */
const DRAIN_TIMEOUT_MS = DRAIN_TIMEOUT_MINUTES * MS_PER_MINUTE;
const FORCED_SETTLE_TIMEOUT_MS = 10_000;
/** How often a waiting shutdown says what it is still waiting for. */
const DRAIN_REPORT_INTERVAL_MS = MS_PER_MINUTE;

const waitingOn = (pendingWork: PendingWork["Service"]) =>
  `${pendingWork.size()} operation(s) and ${turnCount()} agent turn(s): ${describeTurns(listTurns()) || "none"}`;

/** The first line of a shutdown, naming the agent turns it will wait for. */
export const logShutdownStart = Effect.suspend(() =>
  Effect.log(
    turnCount() > 0
      ? `Shutting down; waiting for ${turnCount()} agent turn(s): ${describeTurns(listTurns())}`
      : "Shutting down..."
  )
);

/**
 * Wait until accepted work and agent turns are both idle at the same moment:
 * pending work can start a turn and a turn's caller can queue more work, so
 * each pass re-checks the other. False when `timeoutMs` ran out first.
 */
const drainAll = (pendingWork: PendingWork["Service"], timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (pendingWork.size() > 0 || turnCount() > 0) {
      const workIdle = yield* pendingWork.awaitIdleFor(
        Math.max(0, deadline - Date.now())
      );
      const turnsIdle = yield* Effect.promise(
        async () => await waitForTurnsIdleFor(deadline - Date.now())
      );
      if (!(workIdle && turnsIdle)) {
        return false;
      }
    }
    return true;
  });

/** `drainAll`, logging once a minute what the restart is waiting for. */
const drainWithReports = (
  pendingWork: PendingWork["Service"],
  timeoutMs: number
) =>
  Effect.race(
    drainAll(pendingWork, timeoutMs),
    Effect.sleep(DRAIN_REPORT_INTERVAL_MS).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          Effect.log(`Shutdown waiting on ${waitingOn(pendingWork)}`)
        )
      ),
      Effect.forever
    )
  );

/**
 * Let accepted work and agent turns finish, up to 30 minutes; past that, stop
 * every run and give them a short moment to settle. Runs as a finalizer, so a
 * second signal cannot cut it short. A run parked on background work stops at
 * once and the boot resumes it (`prepareRestart`); then no run takes another
 * message.
 */
export const drainOrStop = (pendingWork: PendingWork["Service"]) =>
  Effect.gen(function* () {
    yield* prepareRestart;
    yield* closeRunInboxes;
    const drained = yield* drainWithReports(pendingWork, DRAIN_TIMEOUT_MS);
    if (drained) {
      return;
    }
    yield* Effect.logWarning(
      `Graceful drain timed out with ${waitingOn(pendingWork)}; stopping them.`
    );
    yield* stopAll;
    yield* drainAll(pendingWork, FORCED_SETTLE_TIMEOUT_MS);
  });
