import { Effect, Option, Semaphore } from "effect";

import { getProvider } from "./registry";
import type { HelperTurn, ProviderId, RoutedEffort } from "./types";

/**
 * One-turn calls that are not runs: the address judge's fallback and the topic
 * titler. They answer a question the bot asks itself, nobody waits on them in
 * a chat, and they never appear in `/stop` — so they must not be able to spawn
 * an agent process per inbound message. This is their own small pool,
 * separate from `RunRegistry`: at capacity a side turn does not queue, it takes
 * the caller's safe answer, exactly as a failed one already does.
 *
 * Each turn runs on the `oneTurn` of the provider the caller picked for it
 * (Codex, Claude or pi: the owner's choice in `/settings`, else the detected
 * helper), which registers it in `agent-turns.ts` under its `label`, so a
 * restart waits for it and the snapshot shows it. The owner's depth for the
 * pass, when set, replaces the turn's own and reaches pi as `ownEffort`.
 */

/**
 * Concurrent side turns. Small: every one of them is a short `light` turn, on
 * the light model unless the owner picked one for the pass or for light runs.
 */
const SIDE_TURN_SLOTS = 2;

const gate = Semaphore.makeUnsafe(SIDE_TURN_SLOTS);

/**
 * Run one side turn on `helper`, or answer `fallback` — when there is no
 * helper or it has no `oneTurn`, when the pool is full, or when the turn itself throws. Never
 * rejects: a question the bot asks itself must not be able to fail a chat.
 */
export const runSideTurn = async <A>(args: {
  /** The owner's depth for this pass; undefined keeps the turn's own. */
  effort?: RoutedEffort;
  fallback: A;
  /** The provider this pass runs on; undefined when none serves it. */
  helper: ProviderId | undefined;
  /** What the turn is for, as the turn registry and the ledger name it. */
  label: "address_judge" | "topic_title";
  /** Model slug on `helper`; undefined keeps its light model. */
  model?: string;
  turn: (oneTurn: HelperTurn) => Promise<A>;
}): Promise<A> => {
  const oneTurn =
    args.helper === undefined ? undefined : getProvider(args.helper).oneTurn;
  if (oneTurn === undefined) {
    return args.fallback;
  }
  const ran = await Effect.runPromise(
    Semaphore.withPermitsIfAvailable(
      gate,
      1
    )(
      Effect.promise(async () => {
        try {
          return await args.turn(
            async (request) =>
              await oneTurn({
                ...request,
                effort: args.effort ?? request.effort,
                kind: "side_turn",
                label: args.label,
                model: args.model,
                ownEffort: args.effort,
              })
          );
        } catch {
          return args.fallback;
        }
      })
    )
  );
  return Option.getOrElse(ran, () => args.fallback);
};
