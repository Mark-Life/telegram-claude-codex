import type { ProviderId } from "./types";

/**
 * Every agent turn this process has spawned and not yet reaped, whatever the
 * provider. A turn is one agent child process (`codex app-server`, `codex
 * exec` or `claude`); nothing else in the bot holds one, so this is the one
 * list a restart has to wait on and the one place to read what is running
 * right now.
 *
 * Module state, not an Effect service: side turns run on Effect's default
 * runtime and the format pass is a plain Promise, so a layer-built registry
 * would miss them or exist twice. The fact it records — processes this process
 * spawned — is process-wide by nature, like `side-turn.ts`'s gate.
 */

/** What spawned the turn: a streamed run, a compaction, a format pass or a side turn. */
export type TurnKind = "compact" | "format" | "run" | "side_turn";

/** How a turn ended. `aborted` is a signal, a `/stop` or an abandoned stream. */
export type TurnOutcome = "aborted" | "done" | "failed";

/** What a spawn site says about the turn it is about to start. */
export interface TurnSpec {
  kind: TurnKind;
  /** Which provider's process runs the turn. */
  provider: ProviderId;
  /** Finer name within the kind: `address_judge`, `topic_title`, `main`… */
  label: string;
  /** `user:chat:topic` of the run slot, when the turn belongs to one. */
  runKey?: string;
}

/** One live turn, as listed and snapshotted. */
export interface LiveTurn extends TurnSpec {
  id: string;
  /** Epoch ms the turn was registered, just before its process spawned. */
  startedAt: number;
}

/** What a listener hears: a turn started, or a turn ended and how. */
export type TurnChange =
  | { phase: "end"; durationMs: number; outcome: TurnOutcome; turn: LiveTurn }
  | { phase: "start"; turn: LiveTurn };

const live = new Map<string, LiveTurn>();
const listeners = new Set<(change: TurnChange) => void>();
const idleWaiters = new Set<() => void>();
let sequence = 0;

const RADIX = 36;

/** A listener is observability; it must never break the turn it observes. */
const emit = (change: TurnChange) => {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // Swallowed on purpose: a failed ledger write is not a failed turn.
    }
  }
};

/**
 * Record a turn as started. The returned `end` is idempotent, so a caller can
 * put it in a `finally` and still end early with a more precise outcome.
 */
export const registerTurn = (spec: TurnSpec) => {
  sequence += 1;
  const turn: LiveTurn = {
    ...spec,
    id: `${Date.now().toString(RADIX)}-${sequence}`,
    startedAt: Date.now(),
  };
  live.set(turn.id, turn);
  emit({ phase: "start", turn });

  let ended = false;
  const end = (outcome: TurnOutcome) => {
    if (ended) {
      return;
    }
    ended = true;
    live.delete(turn.id);
    emit({
      durationMs: Date.now() - turn.startedAt,
      outcome,
      phase: "end",
      turn,
    });
    if (live.size === 0) {
      for (const wake of idleWaiters) {
        wake();
      }
      idleWaiters.clear();
    }
  };
  return { end, id: turn.id } as const;
};

/**
 * Track one promise-shaped turn from before it spawns until it settles. A
 * rejection is `aborted` when `signal` fired, `failed` otherwise.
 */
export const trackTurn = async <A>(
  spec: TurnSpec,
  work: () => Promise<A>,
  signal?: AbortSignal
): Promise<A> => {
  const turn = registerTurn(spec);
  try {
    const result = await work();
    turn.end("done");
    return result;
  } catch (error) {
    turn.end(signal?.aborted === true ? "aborted" : "failed");
    throw error;
  } finally {
    turn.end("aborted");
  }
};

/**
 * Track one stream-shaped turn for its whole life: registered before `work`
 * is first pulled, so a lazy stream that spawns on its first `next()` is
 * covered, and ended in `finally`, which also covers a consumer that abandons
 * the stream (`gen.return()`). A throw is `aborted` when `signal` fired,
 * `failed` otherwise.
 *
 * @yields {A} what `work` yields, unchanged.
 */
export const trackStream = async function* trackStream<A>(
  spec: TurnSpec,
  signal: AbortSignal,
  work: () => AsyncIterable<A>
): AsyncGenerator<A> {
  const turn = registerTurn(spec);
  try {
    yield* work();
    turn.end("done");
  } catch (error) {
    turn.end(signal.aborted ? "aborted" : "failed");
    throw error;
  } finally {
    turn.end("aborted");
  }
};

/** Snapshot of every live turn, oldest first. */
export const listTurns = (): readonly LiveTurn[] => [...live.values()];

/** How many turns are live. */
export const turnCount = () => live.size;

/** Subscribe to starts and ends; answers the unsubscribe. */
export const onTurnChange = (listener: (change: TurnChange) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * True when every live turn ended before `timeoutMs`, including turns
 * registered while waiting; false on the deadline.
 */
export const waitForTurnsIdleFor = async (timeoutMs: number) => {
  if (live.size === 0) {
    return true;
  }
  if (timeoutMs <= 0) {
    return false;
  }
  const idle = Promise.withResolvers<boolean>();
  const wake = () => {
    idle.resolve(true);
  };
  idleWaiters.add(wake);
  const timer = setTimeout(() => {
    idle.resolve(false);
  }, timeoutMs);
  try {
    return await idle.promise;
  } finally {
    clearTimeout(timer);
    idleWaiters.delete(wake);
  }
};
