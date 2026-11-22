import { AppConfig } from "@workspace/env/bot";
import {
  Brand,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Queue,
  Semaphore,
} from "effect";

import {
  AgentInterrupted,
  AtCapacity,
  classifyOutcome,
  ProviderCrashed,
} from "./errors";
import type { AgentError, InterruptReason } from "./errors";
import { readExecutorMcpServers } from "./executor-mcp";
import { createFollowUps } from "./follow-ups";
import type { FollowUps } from "./follow-ups";
import { OwnerSettingsReader } from "./provider-settings";
import { streamProvider } from "./runner";
import { TelegramAccountMcp } from "./telegram-account-mcp";
import type {
  AgentEvent,
  EventQueue,
  ProviderSpec,
  RunContext,
  RunKey,
  RunOptions,
} from "./types";

/** Upper bound on shutdown drain (parallel per-fiber kill grace is ~3s). */
const SHUTDOWN_GRACE_SECONDS = 6;
const SHUTDOWN_GRACE = Duration.seconds(SHUTDOWN_GRACE_SECONDS);
/** Backpressure bound for the per-run event queue. */
const QUEUE_CAPACITY = 256;

/**
 * Map key for a run slot: single-flight within one chat topic, parallel across
 * topics. Every entry outside a topic collapses to the chat's `main` slot, so
 * the pre-topics behavior (one run per user per chat) is unchanged.
 */
export const runKeyOf = ({ chatId, origin, threadId, userId }: RunKey) =>
  `${userId}:${chatId}:${threadId ?? "main"}${origin === undefined ? "" : `@${origin}`}`;

/** One started run; tells a stale consumer's stop apart from the slot's newer run. */
export type RunId = Brand.Branded<string, "RunId">;
const makeRunId = Brand.nominal<RunId>();

/** Slots a low-priority run may never take, so the owner never waits behind one. */
const OWNER_RESERVED_SLOTS = 1;

/** The low-priority pool for a global limit: one less, but never empty. */
const lowPriorityPermits = (maxConcurrentRuns: number) =>
  Math.max(maxConcurrentRuns - OWNER_RESERVED_SLOTS, 1);

const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  const sem = yield* Semaphore.make(cfg.maxConcurrentRuns);
  // Group runs share a smaller pool than the global one: whatever they do, one
  // permit stays free for the owner. Owner priority is therefore a capacity
  // rule, not a queue — a run either starts now or fails AtCapacity.
  const lowPrioritySem = yield* Semaphore.make(
    lowPriorityPermits(cfg.maxConcurrentRuns)
  );
  // Runs parked on background work hold one of these instead: a parked run
  // makes no API calls, and a wake-up turn the CLI starts on its own can
  // never be refused for want of a working permit.
  const backgroundSem = yield* Semaphore.make(cfg.maxBackgroundRuns);

  /**
   * The global permit one run holds: a working one from its start, a waiting
   * one once it parks (`RunContext.waitSlot`). Released on any exit.
   */
  const makeSeat = () => {
    let held: "none" | "waiting" | "working" = "none";
    return {
      release: Effect.suspend(() => {
        const from = held === "waiting" ? backgroundSem : sem;
        const holds = held !== "none";
        held = "none";
        return holds ? Semaphore.release(from, 1) : Effect.void;
      }),
      take: Semaphore.takeIfAvailable(sem, 1).pipe(
        Effect.tap((taken) =>
          Effect.sync(() => {
            if (taken) {
              held = "working";
            }
          })
        )
      ),
      waitSlot: () => {
        if (held !== "working") {
          return held === "waiting";
        }
        if (!Effect.runSync(Semaphore.takeIfAvailable(backgroundSem, 1))) {
          return false;
        }
        held = "waiting";
        Effect.runSync(Semaphore.release(sem, 1));
        return true;
      },
    };
  };
  // Config is boot-resolved, so every run of this registry shares one context.
  const executorServers = yield* readExecutorMcpServers;
  // Provided by the app when the account feature exists; absent, no run
  // ever gets the account tools.
  const accountMcp = yield* Effect.serviceOption(TelegramAccountMcp);
  // The owner's provider settings, read per run so a change in `/settings`
  // applies to the next one; absent with no settings table.
  const ownerSettingsReader = yield* OwnerSettingsReader;
  // oxlint-disable-next-line typescript/no-invalid-void-type -- the producer fiber succeeds with no value
  const fibers = yield* FiberMap.make<string, void, AgentError>();
  // Why the run in a slot was interrupted, handed from the interrupter to that
  // run's own terminal event. One live entry per running slot: every path that
  // reads it also removes it.
  const reasons = new Map<string, InterruptReason>();

  /**
   * File why a slot's run stops. A `replaced` run already ends quietly, so a
   * later stop of the same run (a provider switch right after `/new`) keeps
   * that.
   */
  const fileReason = (key: string, reason: InterruptReason) => {
    if (reasons.get(key) !== "replaced") {
      reasons.set(key, reason);
    }
  };

  /** The pending reason for a slot, consumed. Absent means a plain `/stop`. */
  const takeReason = (key: string): InterruptReason => {
    const reason = reasons.get(key) ?? "stopped";
    reasons.delete(key);
    return reason;
  };
  // Which run currently owns each slot. Set on start, dropped by that same
  // run's terminal, so an early-exit stop can never hit a newer run.
  const owners = new Map<string, RunId>();
  // Each running slot's follow-up inbox, dropped by its run's terminal.
  const followUps = new Map<string, FollowUps>();
  // Set once a shutdown closed every inbox: a run started after takes none.
  let inboxesClosed = false;
  // Slots whose current run is `light`: it runs on the light provider in
  // scratch, never on its topic's provider, so a switch there leaves it be.
  const lightSlots = new Set<string>();

  /**
   * Runs once the producer fiber exits (success / typed failure / interrupt).
   * Translates the fiber's Exit into a terminal AgentEvent (best-effort offer,
   * bounded so an abandoned consumer can't wedge us) and ends the queue so the
   * consuming AsyncGenerator returns. Total.
   *
   * The reason is read once and dropped: it belongs to the run that just ended,
   * so leaving it behind would both leak one entry per slot ever used and hand
   * a stale label to the next run in that slot.
   */
  const emitTerminal = (
    queue: EventQueue,
    exit: Exit.Exit<void, AgentError>,
    key: string,
    runId: RunId
  ) =>
    Effect.gen(function* () {
      // Before the reason is taken: once the owner is gone, stopIfOwner can no
      // longer file a reason this run would leave behind.
      if (owners.get(key) === runId) {
        owners.delete(key);
        lightSlots.delete(key);
        followUps.get(key)?.close();
        followUps.delete(key);
      }
      // Unconditional: this run is over on every exit path, so its reason goes
      // with it whether or not the terminal event needs to read one.
      const reason = takeReason(key);
      if (Exit.isFailure(exit)) {
        const err: AgentError = Cause.hasInterruptsOnly(exit.cause)
          ? new AgentInterrupted({ reason })
          : Option.getOrElse(
              Cause.findErrorOption(exit.cause),
              () => new ProviderCrashed({ message: Cause.pretty(exit.cause) })
            );
        yield* Queue.offer(queue, {
          class: err,
          kind: "error",
          message: classifyOutcome(err).copy,
        }).pipe(Effect.timeout(Duration.seconds(1)), Effect.ignore);
      }
      yield* Queue.end(queue);
    }).pipe(Effect.ignore);

  /**
   * The full run program: take a global permit only if one is immediately
   * available (else fail AtCapacity), then stream the process into the queue.
   * A low-priority run takes a second permit from the smaller group pool first,
   * which is what keeps a slot free for the owner. Both are released on any
   * exit — success, typed failure, or interrupt — so a permit can never leak,
   * whichever pool the seat moved to. Scoped so the process kill runs on any
   * exit; onExit emits the terminal event + ends the queue.
   */
  const buildProducer = (
    spec: ProviderSpec,
    opts: RunOptions,
    queue: EventQueue,
    runId: RunId,
    runContext: RunContext,
    seat: ReturnType<typeof makeSeat>
  ) => {
    const key = runKeyOf(opts);
    const producer = streamProvider(spec, opts, runContext, queue);
    const admitted =
      opts.access.priority === "low"
        ? Semaphore.withPermitsIfAvailable(
            lowPrioritySem,
            1
          )(producer.pipe(Effect.scoped)).pipe(
            Effect.flatMap((ran) =>
              Option.isSome(ran) ? Effect.void : new AtCapacity({})
            )
          )
        : producer.pipe(Effect.scoped);
    return Effect.acquireUseRelease(
      seat.take,
      (taken) => (taken ? admitted : new AtCapacity({})),
      () => seat.release
    ).pipe(
      Effect.onExit((exit) => emitTerminal(queue, exit, key, runId)),
      Effect.annotateLogs({ provider: spec.id, runId, runKey: key })
    );
  };

  /**
   * Starts a run: creates the bridge queue, records the pre-empt reason, and
   * forks the producer into the FiberMap keyed by the run slot — which
   * interrupts any prior run in that same slot (fire-and-forget) while leaving
   * the user's other topics alone. Returns the new run's id and the queue its
   * event stream drains.
   */
  const start = Effect.fn("RunRegistry.start")(function* (
    spec: ProviderSpec,
    opts: RunOptions
  ) {
    const key = runKeyOf(opts);
    // Executor shares the external-tool boundary with account apps and plugin
    // MCPs: only an explicitly entitled private run receives it. The account
    // server is asked per run: the owner may have logged in or out since. A
    // run that names no requester gets no account: a write must say who asked.
    const telegramAccount =
      opts.access.telegramAccount &&
      opts.taskAuthor !== undefined &&
      Option.isSome(accountMcp)
        ? Option.getOrUndefined(
            yield* accountMcp.value.endpoint(opts.taskAuthor)
          )
        : undefined;
    const ownerSettings = yield* ownerSettingsReader.read(spec.id);
    const inbox = createFollowUps();
    if (inboxesClosed) {
      inbox.close(true);
    }
    const seat = makeSeat();
    const runContext: RunContext = {
      followUps: inbox,
      mcpServers: opts.access.externalTools ? executorServers : undefined,
      ownerSettings,
      telegramAccount,
      waitSlot: seat.waitSlot,
    };
    const queue = yield* Queue.bounded<AgentEvent, Cause.Done>(QUEUE_CAPACITY);
    const runId = makeRunId(crypto.randomUUID());
    yield* Effect.sync(() => {
      fileReason(key, "new_prompt");
      owners.set(key, runId);
      followUps.set(key, inbox);
      if (opts.access.modelClass === "light") {
        lightSlots.add(key);
      } else {
        lightSlots.delete(key);
      }
    });
    yield* FiberMap.run(
      fibers,
      key
    )(buildProducer(spec, opts, queue, runId, runContext, seat));
    return { followUps: inbox, queue, runId };
  });

  /**
   * Records the interrupt reason and tears down that slot's fiber. The removal
   * is detached so callers (grammy handlers) never block on the kill grace.
   * Returns whether a run was active.
   */
  const stop = Effect.fn("RunRegistry.stop")(function* (
    key: RunKey,
    reason: InterruptReason
  ) {
    const id = runKeyOf(key);
    const active = yield* FiberMap.has(fibers, id);
    if (!active) {
      return false;
    }
    yield* Effect.sync(() => {
      fileReason(id, reason);
    });
    yield* Effect.forkDetach(FiberMap.remove(fibers, id));
    return true;
  });

  /**
   * `stop`, but only while `runId` still owns the slot: a consumer that exits
   * early must not kill a newer run a later prompt started there. The check
   * and the fiber lookup are one synchronous step, so no start slips between.
   */
  const stopIfOwner = Effect.fn("RunRegistry.stopIfOwner")(function* (
    key: RunKey,
    runId: RunId,
    reason: InterruptReason
  ) {
    const id = runKeyOf(key);
    const fiber = yield* Effect.sync(() => {
      if (owners.get(id) !== runId) {
        return Option.none();
      }
      const found = FiberMap.getUnsafe(fibers, id);
      if (Option.isSome(found)) {
        fileReason(id, reason);
      }
      return found;
    });
    if (Option.isNone(fiber)) {
      return false;
    }
    yield* Effect.forkDetach(Fiber.interrupt(fiber.value));
    return true;
  });

  /**
   * `stop` for every user's run in one chat and topic: a conversation's
   * provider belongs to the topic, so a switch there stops whoever is
   * running on it. A `light` run is left alone: it never ran on the topic's
   * provider. Succeeds with how many runs were stopped.
   */
  const stopRoute = Effect.fn("RunRegistry.stopRoute")(function* (
    route: Omit<RunKey, "userId">,
    reason: InterruptReason
  ) {
    const suffix = runKeyOf({ ...route, userId: 0 }).slice("0".length);
    const ids = [...owners.keys()].filter(
      (id) => id.endsWith(suffix) && !lightSlots.has(id)
    );
    for (const id of ids) {
      yield* Effect.sync(() => {
        fileReason(id, reason);
      });
      yield* Effect.forkDetach(FiberMap.remove(fibers, id));
    }
    return ids.length;
  });

  /**
   * Whether any user's run works in one chat and topic, the slots `stopRoute`
   * would stop: a topic's session is shared by everyone who writes there,
   * while a run slot is per user. A `light` run is left out for the same
   * reason as there.
   */
  const routeBusy = (route: Omit<RunKey, "userId">) =>
    Effect.sync(() => {
      const suffix = runKeyOf({ ...route, userId: 0 }).slice("0".length);
      return [...owners.keys()].some(
        (id) => id.endsWith(suffix) && !lightSlots.has(id)
      );
    });

  const has = (key: RunKey) => FiberMap.has(fibers, runKeyOf(key));

  /**
   * Hand a message to the run in a slot, to be folded into its running turn,
   * or run as its next turn when the run is parked on background work.
   * Succeeds false when no run is there or its provider takes none now; the
   * caller queues the message then.
   */
  const steer = (key: RunKey, text: string) =>
    Effect.sync(() => followUps.get(runKeyOf(key))?.offer(text) ?? false);

  /**
   * End the run in a slot at its last answer, for a conversation that moves
   * to another session, model or effort: a run parked on background work
   * stops now, quietly (`replaced`); one still working takes no more
   * messages, never parks, and ends at its next result.
   */
  const retire = Effect.fn("RunRegistry.retire")(function* (key: RunKey) {
    const inbox = followUps.get(runKeyOf(key));
    if (inbox === undefined) {
      return;
    }
    if (inbox.waiting()) {
      yield* stop(key, "replaced");
      return;
    }
    inbox.close();
  });

  /** Whether the run in a slot answered and waits on background work. */
  const waiting = (key: RunKey) =>
    Effect.sync(() => followUps.get(runKeyOf(key))?.waiting() ?? false);

  /**
   * Shutdown: stop every run parked on background work now, with `reason`,
   * instead of letting the CLI wind its work down for ten minutes. A run
   * still working is left to finish. Succeeds with how many were stopped.
   */
  const stopWaiting = Effect.fn("RunRegistry.stopWaiting")(function* (
    reason: InterruptReason
  ) {
    const ids = [...followUps].flatMap(([id, inbox]) =>
      inbox.waiting() ? [id] : []
    );
    for (const id of ids) {
      yield* Effect.sync(() => {
        fileReason(id, reason);
      });
      yield* Effect.forkDetach(FiberMap.remove(fibers, id));
    }
    return ids.length;
  });

  /**
   * Shutdown: every run takes no more messages, now or later. A run parked
   * on background work stops waiting; one still working ends at its last
   * result, cut as a restart when work is still pending there.
   */
  const closeInboxes = Effect.sync(() => {
    inboxesClosed = true;
    for (const inbox of followUps.values()) {
      inbox.close(true);
    }
  });

  /**
   * A new limit on runs at once, applied now. Nothing waits on a permit (a
   * run that finds none fails AtCapacity), so a raise only lets more new runs
   * start. A cut never stops a running one: its permit stays taken, and new
   * runs are refused until enough of them end.
   */
  const resize = Effect.fn("RunRegistry.resize")(function* (
    maxConcurrentRuns: number
  ) {
    yield* sem.resize(maxConcurrentRuns);
    yield* lowPrioritySem.resize(lowPriorityPermits(maxConcurrentRuns));
  });

  /**
   * Whether a run of `priority` would find a working permit now: the same
   * pools `buildProducer` takes from, probed and given back in one
   * synchronous step, so no other run sees them taken. A caller that must
   * answer "busy" before it spends anything asks this; the run's own start
   * can still fail AtCapacity when another one took the last permit since.
   */
  const canStart = (priority: RunOptions["access"]["priority"]) =>
    Effect.sync(() => {
      const pools = priority === "low" ? [lowPrioritySem, sem] : [sem];
      const taken = pools.filter((pool) =>
        Effect.runSync(Semaphore.takeIfAvailable(pool, 1))
      );
      for (const pool of taken) {
        Effect.runSync(Semaphore.release(pool, 1));
      }
      return taken.length === pools.length;
    });

  /** Shutdown: interrupt every run and await settle, bounded. */
  const stopAll = FiberMap.clear(fibers).pipe(
    Effect.timeout(SHUTDOWN_GRACE),
    Effect.ignore,
    Effect.withSpan("RunRegistry.stopAll")
  );

  return {
    canStart,
    closeInboxes,
    has,
    resize,
    retire,
    routeBusy,
    start,
    steer,
    stop,
    stopAll,
    stopIfOwner,
    stopRoute,
    stopWaiting,
    waiting,
  } as const;
});

/**
 * RunRegistry: owns global concurrency + per-slot single-flight run lifecycles.
 * Built once in the runtime scope (Semaphore/FiberMap live until dispose, which
 * clears — interrupts — all runs). Effect v4 has no Layer.scoped; Layer.effect
 * discharges the Scope FiberMap.make requires.
 */
export class RunRegistry extends Context.Service<
  RunRegistry,
  Effect.Success<typeof make>
>()("@workspace/RunRegistry") {
  static readonly layer = Layer.effect(RunRegistry, make).pipe(
    Layer.provide(OwnerSettingsReader.layer)
  );
}

/** Effect accessors — the package surface in index.ts wraps these. */
export const startRun = (spec: ProviderSpec, opts: RunOptions) =>
  Effect.flatMap(RunRegistry, (r) => r.start(spec, opts));
export const stopRun = (key: RunKey, reason: InterruptReason) =>
  Effect.flatMap(RunRegistry, (r) => r.stop(key, reason));
export const hasRun = (key: RunKey) =>
  Effect.flatMap(RunRegistry, (r) => r.has(key));
export const stopAllRuns = Effect.flatMap(RunRegistry, (r) => r.stopAll);
export const resizeRuns = (maxConcurrentRuns: number) =>
  Effect.flatMap(RunRegistry, (r) => r.resize(maxConcurrentRuns));
