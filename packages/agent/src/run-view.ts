import { ProviderCrashed } from "./errors";
import {
  openGroupMemoryRelay,
  relayClientFiles,
  relayGroupMemory,
} from "./group-memory-server";
import type { GroupMemoryChat, StdioCommand } from "./group-memory-server";
import { isViewPosture } from "./sandbox/bwrap";
import type { SandboxView, ViewBind, ViewPosture } from "./sandbox/bwrap";
import { hostView, sandboxBin, sandboxSocat } from "./sandbox/host";
import {
  NET_LAUNCHER,
  NET_VIEW_DIR,
  netCommand,
  netProxyEnv,
  openNetProxy,
} from "./sandbox/net-proxy";
import type { NetEndpoint, NetProxy } from "./sandbox/net-proxy";
import { RELAY_VIEW_DIR } from "./sandbox/relay";
import type { Relay } from "./sandbox/relay";
import type { RunAccess } from "./types";

/**
 * The part of one run's bwrap view every provider shares: the checks before
 * it opens, the chat's memory server behind a relay, the network proxy, and
 * their binds and env. A provider adds its own CLI and credentials on top.
 */

/** An open view; `close` stops its relay and proxy once the child is gone. */
interface RunView {
  bwrap: string;
  close: () => void;
  /** The CLI's argv, started through the proxy launcher when isolated. */
  command: (argv: readonly string[]) => string[];
  /** What the child's env gains: the proxy's names when isolated. */
  env: Record<string, string>;
  /** The `group_memory` server through the relay; absent when not wired. */
  groupMemory?: StdioCommand;
  /** The run's posture, which runs in a view. */
  posture: ViewPosture;
  /** The host view: the provider's own binds, then the helpers'. */
  view: (own: {
    readOnly: readonly string[];
    readWrite: readonly ViewBind[];
  }) => SandboxView;
}

/** The helpers a view needs from outside: a memory relay, the network proxy. */
const openHelpers = async (input: {
  access: Pick<RunAccess, "groupMemory">;
  endpoint?: NetEndpoint;
  groupMemory?: GroupMemoryChat;
  hosts: readonly string[];
}) => {
  const relay: Relay | undefined =
    input.access.groupMemory === "current" && input.groupMemory !== undefined
      ? await openGroupMemoryRelay(input.groupMemory)
      : undefined;
  try {
    const socat = sandboxSocat();
    const net: { proxy: NetProxy; socat: string } | undefined =
      socat === undefined
        ? undefined
        : {
            proxy: await openNetProxy({
              endpoint: input.endpoint,
              hosts: input.hosts,
            }),
            socat,
          };
    return { net, relay };
  } catch (error) {
    relay?.close();
    throw error;
  }
};

/**
 * Open the shared part of one child's view, or undefined when it runs
 * unwrapped: full access, or no `bwrap` on this host. `hosts` are what the
 * provider's CLI talks to, and `endpoint` the one exact `host:port` of the
 * run's model (every pi model's `baseUrl`, built-in or the owner's): all the
 * proxy opens, and only at public addresses.
 */
export const openRunView = async (input: {
  access: Pick<RunAccess, "env" | "groupMemory" | "sandbox">;
  endpoint?: NetEndpoint;
  groupMemory?: GroupMemoryChat;
  hosts: readonly string[];
  workingDirectory: string;
}): Promise<RunView | undefined> => {
  const bwrap = sandboxBin();
  const posture = input.access.sandbox;
  if (bwrap === undefined || !isViewPosture(posture)) {
    return undefined;
  }
  if (input.access.env === "inherit") {
    throw new ProviderCrashed({
      message: "A sandboxed run cannot inherit the bot's environment",
    });
  }
  const { net, relay } = await openHelpers(input);
  const run: RunView = {
    bwrap,
    close: () => {
      relay?.close();
      net?.proxy.close();
    },
    command: (argv) =>
      net === undefined ? [...argv] : netCommand(net.socat, argv),
    env: net === undefined ? {} : netProxyEnv(),
    posture,
    view: (own) =>
      hostView({
        cwd: input.workingDirectory,
        network: net === undefined ? "host" : "isolated",
        readOnly: [
          ...own.readOnly,
          ...(relay === undefined ? [] : relayClientFiles()),
          ...(net === undefined ? [] : [net.socat, NET_LAUNCHER]),
        ],
        readWrite: own.readWrite,
        sockets: [
          ...(relay === undefined
            ? []
            : [{ source: relay.dir, target: RELAY_VIEW_DIR }]),
          ...(net === undefined
            ? []
            : [{ source: net.proxy.dir, target: NET_VIEW_DIR }]),
        ],
      }),
  };
  if (relay !== undefined) {
    run.groupMemory = relayGroupMemory();
  }
  return run;
};
