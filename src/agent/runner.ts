import { type SpawnOptions, type Subprocess, spawn } from "bun";
import { Duration, Effect, Fiber, Queue } from "effect";
import { ProcessFailed, ProviderCrashed } from "./errors";
import type { EventQueue, ProviderSpec, RunOptions } from "./types";

const STDERR_CAP = 64 * 1024;
const LINE_CAP = 1 * 1024 * 1024;
const KILL_GRACE = Duration.seconds(3);
const SIGTERM_EXIT = 143;
const SIGINT_EXIT = 130;

/** A subprocess spawned with piped stdout/stderr (the only shape we spawn). */
type PipedSubprocess = Subprocess<SpawnOptions.Writable, "pipe", "pipe">;

const runSignal = (fn: () => void) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

/**
 * Signals the child's whole process group. The child is spawned detached, so its
 * pid is the group leader and a negative-pid signal reaches its grandchildren
 * (the CLI's own tool subprocesses); falls back to the direct child if group
 * signalling is unavailable. Never throws.
 */
const killGroup = (proc: PipedSubprocess, signal: "SIGTERM" | "SIGKILL") => {
  if (!runSignal(() => process.kill(-proc.pid, signal))) {
    runSignal(() => proc.kill(signal));
  }
};

/**
 * Sends SIGTERM, races process exit against a grace window, then SIGKILLs and
 * awaits exit. Total (never fails) — safe as an acquireRelease finalizer, and
 * runs uninterruptibly during scope teardown, so interrupt => bounded kill.
 */
const killBounded = (proc: PipedSubprocess, grace: Duration.Duration) =>
  Effect.sync(() => killGroup(proc, "SIGTERM")).pipe(
    Effect.andThen(
      Effect.race(
        Effect.promise(() => proc.exited),
        Effect.sleep(grace).pipe(
          Effect.andThen(Effect.sync(() => killGroup(proc, "SIGKILL"))),
          Effect.andThen(Effect.promise(() => proc.exited))
        )
      )
    ),
    Effect.ignore
  );

/** Ring-buffered stderr drain (last 64KB). Total; forked into the run scope. */
const drainStderr = (proc: PipedSubprocess, state: { value: string }) =>
  Effect.gen(function* () {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = yield* Effect.promise(() => reader.read());
      if (chunk.done) {
        break;
      }
      state.value = (
        state.value + decoder.decode(chunk.value, { stream: true })
      ).slice(-STDERR_CAP);
    }
  }).pipe(Effect.ignore);

/**
 * Spawns a provider CLI as a scoped resource and streams its stdout, offering
 * each normalized event to `queue`. The spawn is bracketed with killBounded, so
 * scope-close (normal end OR interrupt) always kills the process within grace —
 * closing the "hung child wedges future runs" hole. Fails with ProcessFailed on
 * non-zero exit or ProviderCrashed on spawn/read defect. Interrupt is signalled
 * via the fiber's Cause, never surfaced here as an exit code.
 */
export const spawnAndStream = (
  spec: ProviderSpec,
  opts: RunOptions,
  queue: EventQueue
) =>
  Effect.gen(function* () {
    const args = spec.buildArgs(opts);
    const env = spec.buildEnv(
      opts,
      process.env as Record<string, string | undefined>
    );

    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn({
            cmd: [spec.command, ...args],
            cwd: opts.projectDir,
            stdout: "pipe",
            stderr: "pipe",
            env,
            detached: true,
          }),
        catch: (e) =>
          new ProviderCrashed({
            message: e instanceof Error ? e.message : String(e),
          }),
      }),
      (p) => killBounded(p, KILL_GRACE)
    );

    const stderrState = { value: "" };
    const stderrFiber = yield* Effect.forkScoped(
      drainStderr(proc, stderrState)
    );

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parseLines = spec.createParser();

    while (true) {
      const chunk = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (e) =>
          new ProviderCrashed({
            message: e instanceof Error ? e.message : String(e),
          }),
      });
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > LINE_CAP) {
        buffer = buffer.slice(-LINE_CAP);
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const ev of parseLines(lines)) {
        yield* Queue.offer(queue, ev);
      }
    }
    if (buffer.trim()) {
      for (const ev of parseLines([buffer])) {
        yield* Queue.offer(queue, ev);
      }
    }

    const exitCode = yield* Effect.promise(() => proc.exited);
    if (
      exitCode === 0 ||
      exitCode === SIGTERM_EXIT ||
      exitCode === SIGINT_EXIT
    ) {
      return;
    }
    yield* Fiber.join(stderrFiber).pipe(
      Effect.timeout(Duration.seconds(1)),
      Effect.ignore
    );
    return yield* new ProcessFailed({
      code: exitCode,
      stderr: stderrState.value,
    });
  });
