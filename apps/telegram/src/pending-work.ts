import type { Duration } from "effect";
import { Context, Effect, Fiber, FiberSet, Layer, Option } from "effect";

/**
 * Tracks work intentionally detached from grammY's middleware promise, as
 * fibers in one `FiberSet` owned by the scope that builds it. The bot uses it
 * only to drain accepted work before a graceful shutdown; Codex remains the
 * source of truth for conversation history. Closing the scope interrupts what
 * is still tracked, so the entrypoint closes it only after the drain.
 */
const make = Effect.gen(function* make() {
  const set = yield* FiberSet.make();
  const fork = yield* FiberSet.runtime(set)();

  /** Promise work from a grammy closure; the caller still sees its result. */
  const track = async <T>(work: Promise<T>) => {
    fork(Effect.promise(async () => await Promise.allSettled([work])));
    return await work;
  };

  /**
   * Effect work: runs as tracked work and waits for it. Interrupting the waiter
   * leaves the work running, so a loop stopped at shutdown never cuts a pass
   * the drain still has to wait for.
   */
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => Fiber.join(fork(effect)));

  const size = () => Effect.runSync(FiberSet.size(set));

  /** True when the set was empty, work added while waiting included, before the deadline. */
  const awaitIdleFor = (timeout: Duration.Input) =>
    FiberSet.awaitEmpty(set).pipe(
      Effect.timeoutOption(timeout),
      Effect.map(Option.isSome)
    );

  return { awaitIdleFor, run, size, track } as const;
});

export class PendingWork extends Context.Service<
  PendingWork,
  Effect.Success<typeof make>
>()("@workspace/PendingWork") {
  static readonly layer = Layer.effect(PendingWork, make);
}
