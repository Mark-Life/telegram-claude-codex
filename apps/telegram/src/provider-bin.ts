/**
 * Where a host binary is: a provider's CLI for detection, `bwrap` and `socat`
 * for the sandbox.
 *
 * Codex's CLI is spawned by the resolved path for the status check and the
 * `/login` device flow. For Claude the resolved path is only the installed
 * signal and is never spawned: its status check runs `CLAUDE_BIN` or the SDK's
 * bundled binary. A bare name is enough in a terminal and not enough under
 * systemd. A unit inherits PATH from `/etc/environment` via pam_env; the
 * entries that make a user-installed CLI findable — `~/.local/bin`,
 * `~/.bun/bin` — are added by `~/.zshrc`, which only an interactive shell
 * reads. Nothing execs a shell for a service, so the command that works when
 * you type it is ENOENT for the bot.
 *
 * A miss is never remembered: a binary installed after boot is found by the
 * next check.
 */

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const isExecutable = (candidate: string) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** One host binary to look for. */
interface BinLookup {
  /** The bare name, as PATH names it. */
  command: string;
  home?: string;
  /** Relative to `home`, highest priority first; consulted after PATH. */
  homeBinDirs: readonly string[];
  /** The operator's explicit path (`*_BIN`), taken as given. */
  override?: string | undefined;
  /** The PATH to search. Defaults to the process's own. */
  searchPath?: string | undefined;
}

/**
 * The binary: the override, else PATH, else the first executable in a home
 * bin dir. Undefined when none has it: it is not installed.
 */
export const resolveBin = ({
  command,
  homeBinDirs,
  override,
  home = homedir(),
  searchPath = process.env.PATH,
}: BinLookup) => {
  const explicit = override?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const onPath = Bun.which(command, { PATH: searchPath ?? "" });
  if (onPath !== null) {
    return onPath;
  }
  return homeBinDirs
    .map((dir) => path.join(home, dir, command))
    .find(isExecutable);
};
