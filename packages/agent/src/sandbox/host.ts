import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DATA_DIR } from "@workspace/env/paths";
import { spawn } from "bun";

import { providerStateRoots } from "../state-roots";
import type { SandboxMode } from "../types";
import { isViewPosture, isWithin } from "./bwrap";
import type { HostPath, SandboxView, ViewBind } from "./bwrap";

export { socketPathFits, sweepSocketDirs } from "./relay";

/**
 * The host side of the bwrap view: which `bwrap` and `socat` this host has,
 * pinned once at boot, and the paths a view hides, read from the disk when a
 * run starts.
 */

/** A path as it is on disk, symlinks resolved; undefined when it is not there. */
const hostPath = (target: string): HostPath | undefined => {
  try {
    const real = realpathSync(target);
    return { kind: statSync(real).isDirectory() ? "dir" : "file", path: real };
  } catch {
    return undefined;
  }
};

let bwrapBin: string | undefined;
let socatBin: string | undefined;

/**
 * Pin what the boot found to work. No `bwrap`: runs are not wrapped. No
 * `socat`: views keep the host's network, because nothing can carry the proxy
 * into them.
 */
export const pinSandbox = (bins: { bwrap?: string; socat?: string }) => {
  bwrapBin = bins.bwrap;
  // Resolved, because a link in a home bin dir is gone inside the view.
  socatBin =
    bins.bwrap === undefined || bins.socat === undefined
      ? undefined
      : (hostPath(bins.socat)?.path ?? bins.socat);
};

/** The pinned `bwrap`, or undefined when runs are not wrapped on this host. */
export const sandboxBin = () => bwrapBin;

/**
 * The pinned `socat`, or undefined when views keep the host's network. Set,
 * every view has its own network and reaches only what its proxy allows.
 */
export const sandboxSocat = () => socatBin;

/**
 * The postures of a provider whose view holds its own credentials (Claude,
 * pi): groups, guests and Business replies never get a tool that reads
 * files, so `read-only` is not here and narrows to `none`. A member gets
 * `workspace-write` only while both `bwrap` and `socat` are pinned, so the
 * view has its own network; without either a member is refused.
 */
export const credentialViewPostures = (): readonly SandboxMode[] =>
  bwrapBin === undefined || socatBin === undefined
    ? ["danger-full-access", "none"]
    : ["danger-full-access", "none", "workspace-write"];

/** Whether a run in `sandbox` runs inside a view on this host. */
export const runsInView = (sandbox: SandboxMode) =>
  bwrapBin !== undefined && isViewPosture(sandbox);

/** The bot repo: `.data` sits at its root. */
const REPO_ROOT = path.dirname(DATA_DIR);

const existing = (targets: readonly string[]) =>
  targets.flatMap((target) => {
    const found = hostPath(target);
    return found === undefined ? [] : [found];
  });

/** The repo's env files: `.env` and its variants, never the example. */
const envFiles = () => {
  try {
    return readdirSync(REPO_ROOT)
      .filter((name) => name.startsWith(".env") && name !== ".env.example")
      .map((name) => path.join(REPO_ROOT, name));
  } catch {
    return [];
  }
};

/**
 * The runtime dirs: every host daemon's unix socket sits there (tailscaled,
 * sshd, D-Bus, systemd, docker), and a socket stays reachable on a read-only
 * bind and in a view with its own network.
 */
const RUNTIME_DIRS = ["/run", "/var/run"];

/**
 * The host logs: `journalctl` reads the service account's own user journal
 * straight from the files, and the bot's ledger is mirrored into it.
 */
const LOG_DIRS = ["/var/log"];

/**
 * `/etc/resolv.conf` when it points into a runtime dir (systemd-resolved),
 * bound back so a view on the host's network still resolves names.
 */
const resolverFile = () => {
  const found = hostPath("/etc/resolv.conf");
  return found !== undefined &&
    RUNTIME_DIRS.some((dir) => isWithin(found.path, dir))
    ? [found.path]
    : [];
};

/**
 * The service account's own toolchain under the home dir: the dir of the bun
 * running the bot, and every `PATH` entry inside the home dir (`~/.bun/bin`,
 * `~/.local/bin`, an fnm or nvm node). Bound back read-only, so a run in the
 * view still finds them. Never the home dir itself or anything holding or
 * inside the bot repo or a secret; a secret under one is hidden again by the
 * view.
 */
const toolchainDirs = (secrets: readonly HostPath[]) => {
  const home = homedir();
  const entries = [
    path.dirname(process.execPath),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ];
  return existing(entries.filter((entry) => path.isAbsolute(entry)))
    .filter(
      (entry) =>
        entry.kind === "dir" &&
        entry.path !== home &&
        isWithin(entry.path, home) &&
        !isWithin(entry.path, REPO_ROOT) &&
        !isWithin(REPO_ROOT, entry.path) &&
        !secrets.some((secret) => isWithin(entry.path, secret.path))
    )
    .map((entry) => entry.path);
};

/**
 * The view of one run on this host. The home directories and the bot repo
 * start empty; `.data`, the env files and every provider's state root are
 * hidden wherever they sit; the toolchain dirs come back read-only; the
 * runtime dirs are masked, which takes away every daemon socket, the user's
 * D-Bus and with it `systemd-run --user`; `/var/log` is masked too. `TMPDIR`
 * points at the view's own `/tmp`, because the host's may be hidden.
 */
export const hostView = (input: {
  cwd: string;
  network: SandboxView["network"];
  readOnly: readonly string[];
  readWrite: readonly ViewBind[];
  sockets: readonly ViewBind[];
}): SandboxView => {
  const secrets = existing([DATA_DIR, ...envFiles(), ...providerStateRoots()]);
  return {
    cwd: hostPath(input.cwd)?.path ?? input.cwd,
    emptied: existing(["/home", homedir(), REPO_ROOT]),
    env: { TMPDIR: "/tmp" },
    masked: [
      ...new Set(
        existing([...RUNTIME_DIRS, ...LOG_DIRS]).map((entry) => entry.path)
      ),
    ],
    network: input.network,
    readOnly: [
      ...new Set([
        ...existing(input.readOnly).map((entry) => entry.path),
        ...toolchainDirs(secrets),
        ...resolverFile(),
      ]),
    ],
    readWrite: input.readWrite,
    secrets,
    sockets: input.sockets,
  };
};

/**
 * Whether `bin` can build a view on this host and run `command` in it, with
 * its own network when `isolated`: a kernel or an AppArmor policy can refuse
 * the unprivileged namespaces it needs. `signal` ends a check that hangs.
 */
export const bwrapWorks = async (
  bin: string,
  check: {
    command: readonly string[];
    isolated: boolean;
    signal?: AbortSignal;
  }
) => {
  try {
    const proc = spawn({
      cmd: [
        bin,
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        ...(check.isolated ? ["--unshare-net"] : []),
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        ...check.command,
      ],
      signal: check.signal,
      stderr: "ignore",
      stdout: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
};
