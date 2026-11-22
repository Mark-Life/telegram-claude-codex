import { Duration, Effect, Queue } from "effect";

import { AgentInterrupted, ProviderCrashed } from "./errors";
import type { AgentError } from "./errors";
import type { EventQueue, ProviderSpec, RunContext, RunOptions } from "./types";

const KILL_GRACE_SECONDS = 3;
const KILL_GRACE = Duration.seconds(KILL_GRACE_SECONDS);

/** One provider generator, its abort switch, and whether it already ended. */
interface SdkHandle {
  readonly ac: AbortController;
  readonly gen: ReturnType<ProviderSpec["run"]>;
  readonly settled: { value: boolean };
}

/** A provider's already-tagged error is preserved; anything else crashes. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this guard narrows it
const isAgentError = (e: unknown): e is AgentError =>
  e instanceof AgentInterrupted || e instanceof ProviderCrashed;

/**
 * Aborts the controller and closes the generator within the kill grace. Total,
 * so it is safe as an acquireRelease finalizer: on scope-close OR interrupt the
 * provider's own subprocess is torn down.
 */
const teardownSdk = ({ ac, gen, settled }: SdkHandle) =>
  Effect.sync(() => {
    // A generator that already ended ran its own cleanup and killed the
    // process; aborting it now only makes node emit an "error" on a child
    // nobody listens to anymore, which crashes the bot.
    if (settled.value) {
      return;
    }
    try {
      ac.abort();
    } catch {
      // Same failure raised synchronously: the process is being torn down anyway.
    }
  }).pipe(
    Effect.andThen(
      Effect.tryPromise(async () => await gen.return()).pipe(
        Effect.timeout(KILL_GRACE),
        Effect.ignore
      )
    )
  );

/**
 * Drives a provider's AsyncGenerator as a scoped resource, offering each
 * normalized event to `queue`. A fresh AbortController is wired into spec.run;
 * scope-close (normal end OR interrupt) aborts it and returns the generator, so
 * the provider's subprocess is always torn down on /stop, provider-switch, or a
 * new prompt. Exit codes are never read — the provider owns its subprocess.
 * Interruption surfaces as the fiber's interrupt Cause, which RunRegistry maps
 * to AgentInterrupted. An error thrown by the generator that is already a
 * tagged AgentError is preserved; anything else becomes ProviderCrashed.
 */
export const streamProvider = (
  spec: ProviderSpec,
  opts: RunOptions,
  ctx: RunContext,
  queue: EventQueue
) =>
  Effect.gen(function* () {
    const { gen, settled } = yield* Effect.acquireRelease(
      Effect.sync((): SdkHandle => {
        const ac = new AbortController();
        return {
          ac,
          gen: spec.run(opts, ctx, ac.signal),
          settled: { value: false },
        };
      }),
      teardownSdk
    );

    while (true) {
      const chunk = yield* Effect.tryPromise({
        catch: (e) =>
          isAgentError(e)
            ? e
            : new ProviderCrashed({
                message: e instanceof Error ? e.message : String(e),
              }),
        try: async () => {
          try {
            const next = await gen.next();
            settled.value = next.done === true;
            return next;
          } catch (error) {
            settled.value = true;
            throw error;
          }
        },
      });
      if (chunk.done === true) {
        break;
      }
      yield* Queue.offer(queue, chunk.value);
    }
  });
