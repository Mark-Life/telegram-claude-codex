import { renameSync, writeFileSync } from "node:fs";

/**
 * Collision-safe tmp path: pid + random suffix so two concurrent writers (the
 * SessionStore and state.ts, or a future second process) never share a tmp file
 * and clobber each other mid-write.
 */
export const uniqueTmp = (path: string) =>
  `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

/**
 * Atomically persist `value` as pretty JSON: write to a unique tmp file, then
 * rename over the target (rename is atomic on POSIX). Returns the serialized
 * byte size and wall-clock duration for observability.
 */
export const writeJsonAtomic = (path: string, value: unknown) => {
  const started = performance.now();
  const body = JSON.stringify(value, null, 2);
  const tmp = uniqueTmp(path);
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return { bytes: body.length, durationMs: performance.now() - started };
};
