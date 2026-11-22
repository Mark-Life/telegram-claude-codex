import { renameSync, writeFileSync } from "node:fs";

const RANDOM_SUFFIX_RADIX = 36;
/** `Math.random().toString()` starts with "0."; skip those two chars. */
const RANDOM_SUFFIX_SKIP_CHARS = 2;
const JSON_INDENT_SPACES = 2;

/**
 * Collision-safe tmp path: pid + random suffix so two concurrent writers (the
 * bot state file and the runs snapshot, or a future second process) never
 * share a tmp file and clobber each other mid-write.
 */
export const uniqueTmp = (target: string) =>
  `${target}.${process.pid}.${Math.random()
    .toString(RANDOM_SUFFIX_RADIX)
    .slice(RANDOM_SUFFIX_SKIP_CHARS)}.tmp`;

/**
 * Atomically persist `value` as pretty JSON: write to a unique tmp file, then
 * rename over the target (rename is atomic on POSIX). Returns the serialized
 * UTF-8 byte size (as written to disk) and wall-clock duration for observability.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a JSON serializer has no domain type of its own; the caller owns the shape it persists
export const writeJsonAtomic = (target: string, value: unknown) => {
  const started = performance.now();
  const body = JSON.stringify(value, null, JSON_INDENT_SPACES);
  const tmp = uniqueTmp(target);
  writeFileSync(tmp, body);
  renameSync(tmp, target);
  return {
    bytes: Buffer.byteLength(body, "utf-8"),
    durationMs: performance.now() - started,
  };
};
