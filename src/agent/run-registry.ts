import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Queue,
  Semaphore,
} from "effect";
import { AppConfig } from "../config";
import {
  type AgentError,
  AgentInterrupted,
  AtCapacity,
  classifyOutcome,
  type InterruptReason,
  ProviderCrashed,
} from "./errors";
import { spawnAndStream, streamProvider } from "./runner";
import type { AgentEvent, EventQueue, ProviderSpec, RunOptions } from "./types";

/** Upper bound on shutdown drain (parallel per-fiber kill grace is ~3s). */
const SHUTDOWN_GRACE = Duration.seconds(6);
/** Backpressure bound for the per-run event queue. */
const QUEUE_CAPACITY = 256;

const make = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  const sem = yield* Semaphore.make(cfg.maxConcurrentRuns);
  const fibers = yield* FiberMap.make<number, void, AgentError>();
  const reasons = new Map<number, InterruptReason>();

  /**
   * Runs once the producer fiber exits (success / typed failure / interrupt).
   * Translates the fiber's Exit into a terminal AgentEvent (best-effort offer,
   * bounded so an abandoned consumer can't wedge us) and ends the queue so the
   * consuming AsyncGenerator returns. Total.
   */
  const emitTerminal = (
    queue: EventQueue,
    exit: Exit.Exit<void, AgentError>,
    userId: number
  ) =>
    Effect.gen(function* () {
      if (Exit.isFailure(exit)) {
        const err: AgentError = Cause.hasInterruptsOnly(exit.cause)
          ? new AgentInterrupted({ reason: reasons.get(userId) ?? "stopped" })
          : Option.getOrElse(
              Cause.findErrorOption(exit.cause),
              () => new ProviderCrashed({ message: Cause.pretty(exit.cause) })
            );
        yield* Queue.offer(queue, {
          kind: "error",
          message: classifyOutcome(err).copy,
          class: err,
        }).pipe(Effect.timeout(Duration.seconds(1)), Effect.ignore);
      }
      yield* Queue.end(queue);
    }).pipe(Effect.ignore);

  /**
   * The full run program: take a global permit only if one is immediately
   * available (else fail AtCapacity), then stream the process into the queue.
   * withPermitsIfAvailable releases the permit on any exit — success, typed
   * failure, or interrupt — so a permit can never leak. Scoped so the process
   * kill runs on any exit; onExit emits the terminal event + ends the queue.
   */
  const buildProducer = (
    spec: ProviderSpec,
    opts: RunOptions,
    queue: EventQueue
  ) => {
    const producer =
      spec.kind === "sdk"
        ? streamProvider(spec, opts, queue)
        : spawnAndStream(spec, opts, queue);
    return Semaphore.withPermitsIfAvailable(
      sem,
      1
    )(producer.pipe(Effect.scoped)).pipe(
      Effect.flatMap((ran) =>
        Option.isSome(ran) ? Effect.void : new AtCapacity({})
      ),
      Effect.onExit((exit) => emitTerminal(queue, exit, opts.userId)),
      Effect.annotateLogs({ userId: opts.userId, provider: spec.id })
    );
  };

  /**
   * Starts a run for a user: creates the bridge queue, records the pre-empt
   * reason, and forks the producer into the FiberMap keyed by userId — which
   * interrupts any prior run for that user (fire-and-forget). Returns the queue
   * for the Promise-side AsyncGenerator to drain.
   */
  const start = (spec: ProviderSpec, opts: RunOptions) =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AgentEvent, Cause.Done>(
        QUEUE_CAPACITY
      );
      yield* Effect.sync(() => reasons.set(opts.userId, "new_prompt"));
      yield* FiberMap.run(
        fibers,
        opts.userId
      )(buildProducer(spec, opts, queue));
      return queue;
    });

  /**
   * Records the interrupt reason and tears down the user's fiber. The removal is
   * detached so callers (grammy handlers) never block on the kill grace.
   * Returns whether a run was active.
   */
  const stop = (userId: number, reason: InterruptReason) =>
    Effect.gen(function* () {
      const active = yield* FiberMap.has(fibers, userId);
      if (!active) {
        return false;
      }
      yield* Effect.sync(() => reasons.set(userId, reason));
      yield* Effect.forkDetach(FiberMap.remove(fibers, userId));
      return true;
    });

  const has = (userId: number) => FiberMap.has(fibers, userId);

  /** Shutdown: interrupt every run and await settle, bounded. */
  const stopAll = FiberMap.clear(fibers).pipe(
    Effect.timeout(SHUTDOWN_GRACE),
    Effect.ignore
  );

  return { start, stop, has, stopAll } as const;
});

/**
 * RunRegistry: owns global concurrency + per-user single-flight run lifecycles.
 * Built once in the runtime scope (Semaphore/FiberMap live until dispose, which
 * clears — interrupts — all runs). beta-78 has no Layer.scoped; Layer.effect
 * discharges the Scope FiberMap.make requires.
 */
export class RunRegistry extends Context.Service<
  RunRegistry,
  Effect.Success<typeof make>
>()("@tg/RunRegistry") {
  static readonly layer = Layer.effect(RunRegistry, make);
}

/** Effect accessors — bridged to Promise-land in agent/index.ts. */
export const startRun = (spec: ProviderSpec, opts: RunOptions) =>
  Effect.flatMap(RunRegistry, (r) => r.start(spec, opts));
export const stopRun = (userId: number, reason: InterruptReason) =>
  Effect.flatMap(RunRegistry, (r) => r.stop(userId, reason));
export const hasRun = (userId: number) =>
  Effect.flatMap(RunRegistry, (r) => r.has(userId));
export const stopAllRuns = Effect.flatMap(RunRegistry, (r) => r.stopAll);
