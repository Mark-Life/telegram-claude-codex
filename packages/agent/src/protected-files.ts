import { realpath } from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "@workspace/env/paths";

import { providerStateRoots } from "./state-roots";

/**
 * The bot's own secrets, whatever a prompt calls them: the runtime data
 * directory (bot.db, sessions, the event ledger, every scratch dir, the
 * account's media and outbox), the repo's dotfiles, every provider CLI's login
 * and config, and files whose name says they hold a secret. The one deny list
 * of everything that sends a file out of this machine: `send-file-to-user`
 * and the account's `send_media`. A run talked into exfiltrating one of these
 * gets nothing, even when the recipient is trusted.
 */

const BLOCKED_PATTERNS = [
  /^\.env/u,
  /^credentials/iu,
  /^secrets/iu,
  /\.pem$/u,
  /\.key$/u,
];

/**
 * Canonical form of a path: symlinks and `..` resolved, so a link named
 * `report.txt` cannot smuggle out the file it points at. A missing path falls
 * back to a plain resolve; the existence check reports that separately.
 */
export const canonical = async (target: string) =>
  await realpath(target).catch(() => path.resolve(target));

/** True when `target` is `root` itself or sits anywhere beneath it. */
export const isInside = (root: string, target: string) =>
  target === root || target.startsWith(`${root}${path.sep}`);

/**
 * True when the path is one of the bot repo's own dotfiles or lives inside one
 * — `.env`, `.git`, `.data`. Matched on the first segment below the repo root,
 * not on the basename, so `.git/config` is caught too.
 */
const isRepoDotfile = (repoRoot: string, target: string) => {
  const rel = path.relative(repoRoot, target);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  return rel.split(path.sep)[0]?.startsWith(".") === true;
};

/**
 * Why a canonical path must never leave the machine: `bot-file` for the data
 * directory, the repo's dotfiles and the providers' state, `sensitive-name`
 * for a name that says it holds a secret; null when it may go.
 */
export const protectionOf = async (realPath: string) => {
  const repoRoot = await canonical(path.dirname(DATA_DIR));
  const deniedRoots = await Promise.all(
    [DATA_DIR, ...providerStateRoots()].map(canonical)
  );
  if (
    deniedRoots.some((root) => isInside(root, realPath)) ||
    isRepoDotfile(repoRoot, realPath)
  ) {
    return "bot-file" as const;
  }
  const basename = path.basename(realPath);
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(basename))
    ? ("sensitive-name" as const)
    : null;
};

/** True when a canonical path is one of the bot's protected files. */
export const isProtectedFile = async (realPath: string) =>
  (await protectionOf(realPath)) !== null;
