/**
 * In-process token buckets for the HTTP API: per key and class of request,
 * and per client address for keys that fail. A reverse proxy in front adds
 * none of its own, and one process holds every key, so memory is enough; a
 * restart refills every bucket.
 */

/** What a request costs: a read or a write. */
export type RequestClass = "mutation" | "read";

interface Rate {
  /** How many requests fit in a burst. */
  readonly burst: number;
  /** How long one request takes to come back, in ms. */
  readonly refillMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** `count` requests per `windowMs`, all of them allowed at once. */
const perWindow = (count: number, windowMs: number): Rate => ({
  burst: count,
  refillMs: windowMs / count,
});

const READS_PER_MINUTE = 60;
const MUTATIONS_PER_MINUTE = 20;
const FAILED_KEYS_PER_MINUTE = 20;
const RUNS_PER_HOUR = 20;

/** The budget of one key per class of request. */
export const KEY_RATES: Readonly<Record<RequestClass, Rate>> = {
  mutation: perWindow(MUTATIONS_PER_MINUTE, MINUTE_MS),
  read: perWindow(READS_PER_MINUTE, MINUTE_MS),
};

/**
 * Agent runs one key may start an hour, on top of its writes: spent only by
 * a run that really starts (`AgentRuns.submit`), never by a refusal or an
 * idempotent replay.
 */
export const RUN_RATE = perWindow(RUNS_PER_HOUR, HOUR_MS);

/** Failed keys one client address may send before it waits. */
export const FAILED_AUTH_RATE = perWindow(FAILED_KEYS_PER_MINUTE, MINUTE_MS);

/** Buckets idle this long are full again and dropped. */
const IDLE_MS = HOUR_MS;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const MS_PER_SECOND = 1000;

/**
 * A set of named token buckets. `take` spends one token and answers how many
 * seconds to wait when there was none; `peek` only checks.
 */
export const bucketsOf = (rate: Rate) => {
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  const refilled = (name: string, now: number) => {
    const bucket = buckets.get(name);
    if (bucket === undefined) {
      return { tokens: rate.burst, updatedAt: now };
    }
    const gained = (now - bucket.updatedAt) / rate.refillMs;
    return {
      tokens: Math.min(rate.burst, bucket.tokens + gained),
      updatedAt: now,
    };
  };

  const waitSec = (bucket: Bucket) =>
    Math.max(
      1,
      Math.ceil(((1 - bucket.tokens) * rate.refillMs) / MS_PER_SECOND)
    );

  /** Drop buckets nobody touched for an hour: they would be full anyway. */
  const sweep = (now: number) => {
    if (now - lastSweep < IDLE_MS) {
      return;
    }
    lastSweep = now;
    for (const [name, bucket] of buckets) {
      if (now - bucket.updatedAt >= IDLE_MS) {
        buckets.delete(name);
      }
    }
  };

  /** Spend one token: undefined when there was one, else the wait in seconds. */
  const take = (name: string, now: number) => {
    sweep(now);
    const bucket = refilled(name, now);
    const wait = bucket.tokens < 1 ? waitSec(bucket) : undefined;
    buckets.set(
      name,
      wait === undefined ? { ...bucket, tokens: bucket.tokens - 1 } : bucket
    );
    return wait;
  };

  /** The wait in seconds while the bucket is empty, without spending. */
  const peek = (name: string, now: number) => {
    const bucket = refilled(name, now);
    return bucket.tokens < 1 ? waitSec(bucket) : undefined;
  };

  return { peek, take } as const;
};
