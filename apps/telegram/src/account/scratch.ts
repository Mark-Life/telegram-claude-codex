import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Shared by the account's scratch dirs, `account-media` and `account-outbox`. */

export const MS_PER_HOUR = 3_600_000;
export const BYTES_PER_MB = 1_048_576;

/** Best-effort file work: a failure only leaves the file behind. */
export const swallow = () => null;

/**
 * Remove every entry of `dir` last changed more than `keepMs` ago, file or
 * directory. Best effort: a failure on one entry never stops the rest, and
 * a missing `dir` is nothing to prune.
 */
export const pruneOlderThan = async (dir: string, keepMs: number) => {
  const cutoff = Date.now() - keepMs;
  const names = await readdir(dir).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const entry = path.join(dir, name);
      const info = await stat(entry).catch(swallow);
      if (info !== null && info.mtimeMs < cutoff) {
        await rm(entry, { force: true, recursive: true }).catch(swallow);
      }
    })
  );
};
