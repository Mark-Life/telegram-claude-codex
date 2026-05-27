import { spawn } from "bun";
import type { AgentEvent, ProviderSpec, RunOptions } from "./types";

interface ProcessEntry {
  ac: AbortController;
  done: Promise<void>;
}

/** Global per-user process map — one active process per user across all providers */
const userProcesses = new Map<number, ProcessEntry>();
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Spawn a provider CLI and yield streaming events, tracked per Telegram user.
 * Enforces the global one-process-per-user invariant (keyed by userId only).
 */
export async function* runProvider(
  spec: ProviderSpec,
  opts: RunOptions
): AsyncGenerator<AgentEvent> {
  const existing = userProcesses.get(opts.userId);
  if (existing) {
    if (!existing.ac.signal.aborted) {
      yield {
        kind: "error",
        message: "An agent is already running. Use /stop first.",
      };
      return;
    }
    await existing.done;
  }

  const args = spec.buildArgs(opts);

  const ac = new AbortController();
  let resolveCleanup!: () => void;
  const done = new Promise<void>((r) => {
    resolveCleanup = r;
  });
  userProcesses.set(opts.userId, { ac, done });

  const env = spec.buildEnv(
    opts,
    process.env as Record<string, string | undefined>
  );
  const proc = spawn({
    cmd: [spec.command, ...args],
    cwd: opts.projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env,
    signal: ac.signal,
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, DEFAULT_TIMEOUT_MS);

  let stderrBuffer = "";
  const stderrDrain = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done: drained, value } = await reader.read();
      if (drained) {
        break;
      }
      stderrBuffer += decoder.decode(value, { stream: true });
    }
  })();

  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parseLines = spec.createParser();

    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      yield* parseLines(lines);
    }

    if (buffer.trim()) {
      yield* parseLines([buffer]);
    }

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      await stderrDrain;
      yield {
        kind: "error",
        message: stderrBuffer.trim() || `Process exited with code ${exitCode}`,
      };
    }
  } catch (_err) {
    const reason = timedOut ? "Process timed out." : "Process was stopped.";
    const detail = stderrBuffer.trim();
    yield { kind: "error", message: detail ? `${reason}\n${detail}` : reason };
  } finally {
    clearTimeout(timeout);
    proc.kill();
    await proc.exited;
    await stderrDrain.catch(() => {});
    userProcesses.delete(opts.userId);
    resolveCleanup();
  }
}

/** Stop the active process for a user */
export function stopAgent(telegramUserId: number) {
  const entry = userProcesses.get(telegramUserId);
  if (!entry || entry.ac.signal.aborted) {
    return false;
  }
  entry.ac.abort();
  return true;
}

/** Check if a user has an active process */
export function hasActiveProcess(telegramUserId: number) {
  const entry = userProcesses.get(telegramUserId);
  return !!entry && !entry.ac.signal.aborted;
}

/** Abort all active processes (used during shutdown) */
export function stopAll() {
  for (const entry of userProcesses.values()) {
    entry.ac.abort();
  }
}
