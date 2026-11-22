import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { listTurns, onTurnChange } from "@workspace/agent";
import type { LiveTurn, TurnChange } from "@workspace/agent";
import { writeJsonAtomic } from "@workspace/core/fs";
import { Effect } from "effect";

import { APP_VERSION } from "./handlers/run-event";
import { logWarning } from "./log";
import { Observability, TURN_EVENT_MARKER, TurnEvent } from "./observability";
import { runtime } from "./runtime";

/**
 * The app's side of the agent turn registry (`@workspace/agent` agent-turns):
 * one ledger line per turn start and end, and `.data/runs.json`, the snapshot
 * the self-update skill reads before it restarts the bot.
 */

/** Changes landing within this window are written as one snapshot. */
const SNAPSHOT_COALESCE_MS = 250;
/** How long `close` waits for ledger lines still being appended. */
const LEDGER_FLUSH_TIMEOUT_MS = 2000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** What `.data/runs.json` holds. A reader treats a `pid` that is not the bot's as stale. */
export interface RunsSnapshot {
  pid: number;
  turns: {
    id: string;
    kind: LiveTurn["kind"];
    label: string;
    provider: LiveTurn["provider"];
    runKey: string | null;
    startedAt: string;
  }[];
  updatedAt: string;
}

const snapshotOf = (turns: readonly LiveTurn[]): RunsSnapshot => ({
  pid: process.pid,
  turns: turns.map((turn) => ({
    id: turn.id,
    kind: turn.kind,
    label: turn.label,
    provider: turn.provider,
    runKey: turn.runKey ?? null,
    startedAt: new Date(turn.startedAt).toISOString(),
  })),
  updatedAt: new Date().toISOString(),
});

const ledgerLine = (change: TurnChange) =>
  Effect.suspend(() =>
    Effect.flatMap(Observability, (observability) =>
      observability.recordTurn(
        new TurnEvent({
          durationMs: change.phase === "end" ? change.durationMs : null,
          event: TURN_EVENT_MARKER,
          host: hostname(),
          kind: change.turn.kind,
          label: change.turn.label,
          outcome: change.phase === "end" ? change.outcome : null,
          phase: change.phase,
          pid: process.pid,
          provider: change.turn.provider,
          runKey: change.turn.runKey ?? null,
          ts: new Date().toISOString(),
          turnId: change.turn.id,
          version: APP_VERSION,
        })
      )
    )
  ).pipe(Effect.catchCause(() => Effect.void));

/** `run/main 42:42:main 12m`, one entry per live turn, for the shutdown log. */
export const describeTurns = (turns: readonly LiveTurn[], now = Date.now()) =>
  turns
    .map((turn) => {
      const seconds = Math.round((now - turn.startedAt) / MS_PER_SECOND);
      const age =
        seconds >= SECONDS_PER_MINUTE
          ? `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`
          : `${seconds}s`;
      const where = turn.runKey === undefined ? "" : ` ${turn.runKey}`;
      return `${turn.kind}/${turn.label}${where} ${age}`;
    })
    .join("; ");

/**
 * Subscribe the ledger and the snapshot to the turn registry. `close` stops
 * both, writes an empty snapshot (a process that is exiting runs nothing) and
 * waits briefly for ledger lines still being appended, so it must be awaited
 * before the runtime is disposed.
 */
export const watchAgentTurns = (snapshotPath: string) => {
  let pending: ReturnType<typeof setTimeout> | undefined;
  let failing = false;
  // Ledger appends in flight: the last turn's `end` line is written after the
  // drain has already seen the registry go idle, so `close` must wait for it.
  const appending = new Set<Promise<unknown>>();

  const write = (snapshot: RunsSnapshot) => {
    try {
      mkdirSync(path.dirname(snapshotPath), { recursive: true });
      writeJsonAtomic(snapshotPath, snapshot);
      failing = false;
    } catch (error) {
      // Once per failure streak: a full disk must not flood the journal.
      if (!failing) {
        logWarning("Failed to write the agent turn snapshot", error);
      }
      failing = true;
    }
  };

  const flush = () => {
    pending = undefined;
    write(snapshotOf(listTurns()));
  };

  const unsubscribe = onTurnChange((change) => {
    // `ledgerLine` swallows its own failures; only an interrupt rejects here.
    const line = runtime
      .runPromise(ledgerLine(change))
      .catch(() => null)
      .finally(() => {
        appending.delete(line);
      });
    appending.add(line);
    pending ??= setTimeout(flush, SNAPSHOT_COALESCE_MS);
  });

  // A snapshot left by the previous process is replaced at once.
  flush();

  const close = async () => {
    unsubscribe();
    clearTimeout(pending);
    pending = undefined;
    write(snapshotOf([]));
    const flushed = new AbortController();
    await Promise.race([
      Promise.allSettled(appending),
      sleep(LEDGER_FLUSH_TIMEOUT_MS, undefined, {
        signal: flushed.signal,
      }).catch(() => null),
    ]);
    flushed.abort();
  };

  return { close } as const;
};
