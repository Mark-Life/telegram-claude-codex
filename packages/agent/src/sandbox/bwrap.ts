import path from "node:path";

import type { SandboxMode } from "../types";

/**
 * The bwrap view a sandboxed agent child runs in, as pure data: the host facts
 * come in (`SandboxView`, gathered by `host.ts`), an argv comes out. Every
 * posture but full access gets a view. Full access is never wrapped: owner,
 * executor and task runs keep the real machine on purpose.
 */

/** The postures that run inside a view. */
const VIEW_POSTURES = [
  "none",
  "read-only",
  "workspace-write",
] as const satisfies readonly SandboxMode[];

export type ViewPosture = (typeof VIEW_POSTURES)[number];

export const isViewPosture = (sandbox: SandboxMode): sandbox is ViewPosture =>
  VIEW_POSTURES.some((posture) => posture === sandbox);

/** One host path as it exists: a directory gets a tmpfs, a file `/dev/null`. */
export interface HostPath {
  kind: "dir" | "file";
  path: string;
}

/** A host path mounted at `target` inside the view. */
export interface ViewBind {
  source: string;
  target: string;
}

/** Everything one view needs to know about the host. */
export interface SandboxView {
  /** Where the run works: bound read-only, or read-write for `workspace-write`. */
  cwd: string;
  /**
   * Whole trees the view starts empty: `/home`, the home directory, the bot
   * repo. Whatever the run needs from inside them is bound back.
   */
  emptied: readonly HostPath[];
  /** Variables set inside the view, on top of the env the child was given. */
  env: Readonly<Record<string, string>>;
  /** Writable per-view directories that hide the host's (`/run`). */
  masked: readonly string[];
  /**
   * `isolated`: the view gets its own network namespace with only loopback,
   * and reaches out through the bot's proxy alone. `host`: the host's network,
   * for a host with no `socat` to carry the proxy in.
   */
  network: "host" | "isolated";
  /** Install dirs and files the CLI needs, bound back read-only. */
  readOnly: readonly string[];
  /**
   * Bound read-write after everything else: the CLI's real credentials file,
   * never a copy, so a token refresh lands.
   */
  readWrite: readonly ViewBind[];
  /**
   * What the run must never read, wherever it sits: `.data`, `.env`, every
   * provider's state root. Hidden again under anything bound back, unless the
   * run's own directory is inside it.
   */
  secrets: readonly HostPath[];
  /**
   * The bot's socket directories, bound read-only last: `connect` works on a
   * read-only bind, and the run cannot leave anything in them that the bot
   * could fail to remove.
   */
  sockets: readonly ViewBind[];
}

/** True when `child` is `parent` or inside it. */
export const isWithin = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Drop entries that sit inside another one: the outer mount covers them. */
const outermost = (entries: readonly HostPath[]) =>
  entries.filter(
    (entry, index) =>
      !entries.some(
        (other, at) =>
          (other.path !== entry.path || at < index) &&
          isWithin(entry.path, other.path)
      )
  );

const hide = ({ kind, path: target }: HostPath) =>
  kind === "dir" ? ["--tmpfs", target] : ["--ro-bind", "/dev/null", target];

/**
 * The bwrap flags of one view, in mount order: a later mount covers an
 * earlier one. The root is read-only, `/tmp` and the other shared writable
 * places are private, whole trees are emptied, the secrets outside them are
 * hidden, the CLI's install dirs and the run's directory are bound back, any
 * secret under those is hidden again, and the read-write binds go last. The
 * run gets its own pid, IPC and UTS namespaces, its own network namespace when
 * the view is `isolated`, and dies with the bot.
 */
const sandboxArgv = (posture: ViewPosture, view: SandboxView) => {
  const roots = outermost(view.emptied);
  const emptied = roots.map((entry) => entry.path);
  const exposed = [...view.readOnly, view.cwd];
  const outside = view.secrets.filter(
    (secret) => !emptied.some((dir) => isWithin(secret.path, dir))
  );
  const under = view.secrets.filter(
    (secret) =>
      exposed.some((dir) => isWithin(secret.path, dir)) &&
      !isWithin(view.cwd, secret.path)
  );
  const cwdBind = posture === "workspace-write" ? "--bind" : "--ro-bind";
  const argv = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(view.network === "isolated" ? ["--unshare-net"] : []),
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/dev/shm",
    ...view.masked.flatMap((dir) => ["--tmpfs", dir]),
    ...roots.flatMap(hide),
    ...outside.flatMap(hide),
    ...view.readOnly.flatMap((entry) => ["--ro-bind", entry, entry]),
    cwdBind,
    view.cwd,
    view.cwd,
    ...under.flatMap(hide),
    ...view.readWrite.flatMap(({ source, target }) => [
      "--bind",
      source,
      target,
    ]),
    ...view.sockets.flatMap(({ source, target }) => [
      "--ro-bind",
      source,
      target,
    ]),
    "--chdir",
    view.cwd,
    ...Object.entries(view.env).flatMap(([name, value]) => [
      "--setenv",
      name,
      value,
    ]),
  ];
  return argv;
};

/** The argv that runs `command` in `posture`: `bwrap`, the view's flags and the command. */
export const sandboxCommand = (input: {
  bwrap: string;
  command: readonly string[];
  posture: ViewPosture;
  view: SandboxView;
}) => [
  input.bwrap,
  ...sandboxArgv(input.posture, input.view),
  "--",
  ...input.command,
];
