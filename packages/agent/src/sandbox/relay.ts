import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dataPath } from "@workspace/env/paths";

/**
 * A stdio server that must run outside the view, reached from inside it. The
 * bot listens on a unix socket in a private directory under `.data`; the view
 * gets only that directory, at `RELAY_VIEW_DIR`. Each connection starts the
 * server process with the arguments the bot fixed, so whoever connects from
 * inside reaches exactly what the run was given. The in-view side is
 * `RELAY_CLIENT`, run by bun: it pipes its stdio to the socket.
 */

/** The in-view half: stdin and stdout piped to the socket named by argv. */
export const RELAY_CLIENT = fileURLToPath(
  new URL("relay-client.ts", import.meta.url)
);

/** Where the relay directory appears inside the view. */
export const RELAY_VIEW_DIR = "/tmp/.bot-relay";

const SOCKET_NAME = "s";

/** A socket's path inside the view, once its directory is bound at `viewDir`. */
export const viewSocket = (viewDir: string) => path.join(viewDir, SOCKET_NAME);

/** The socket's path inside the view. */
export const RELAY_VIEW_SOCKET = viewSocket(RELAY_VIEW_DIR);

/** An open relay; `close` stops it and every server it started. */
export interface Relay {
  close: () => void;
  /** The host directory holding the socket, bound at `RELAY_VIEW_DIR`. */
  dir: string;
}

/** Longest unix socket path the kernel takes (`sun_path` less its NUL). */
const SOCKET_PATH_MAX = 107;

/**
 * Whether a socket under `.data/relay` fits `sun_path`. A repo path past about
 * 84 characters does not, and then every relay and proxy fails to listen.
 */
export const socketPathFits = () =>
  Buffer.byteLength(path.join(dataPath("relay"), "n-XXXXXX", SOCKET_NAME)) <=
  SOCKET_PATH_MAX;

/**
 * Remove a socket directory and whatever is in it, never throwing: a failed
 * removal must not fail a finished run or the boot. The view binds it read-only, so a run
 * cannot leave a subdirectory it locked; should one be there anyway, the
 * owner's permissions come back and the removal runs again.
 */
export const removeSocketDir = (dir: string) => {
  const remove = () => {
    rmSync(dir, { force: true, recursive: true });
  };
  try {
    remove();
  } catch {
    spawnSync("chmod", ["-R", "u+rwx", dir], { stdio: "ignore" });
    try {
      remove();
    } catch {
      // Left for the next sweep; the directory holds no secret.
    }
  }
};

/**
 * Remove the socket dirs a previous process left behind: a crash or a restart
 * mid-run skips their `close`. Only at boot, before any run opens one.
 */
export const sweepSocketDirs = () => {
  removeSocketDir(dataPath("relay"));
};

/**
 * A fresh private directory under `.data/relay` for one socket the bot serves
 * into a view. `prefix` names what it is for in a listing.
 */
export const socketDir = (prefix: string) => {
  const root = dataPath("relay");
  mkdirSync(root, { mode: 0o700, recursive: true });
  const dir = mkdtempSync(path.join(root, `${prefix}-`));
  return { dir, socket: path.join(dir, SOCKET_NAME) };
};

/** Start serving `command` over a fresh socket. */
export const openRelay = async (input: {
  args: readonly string[];
  command: string;
  env: Readonly<Record<string, string>>;
}): Promise<Relay> => {
  const { dir, socket } = socketDir("r");
  const children = new Set<ChildProcess>();
  // Half-open: the client ending its input must not cut the server's output.
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    const child = spawn(input.command, [...input.args], {
      env: input.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.add(child);
    const stop = () => {
      children.delete(child);
      child.kill();
    };
    conn.on("close", stop);
    conn.on("error", stop);
    child.stdin.on("error", stop);
    // `close`, not `exit`: the server's last output must reach the socket.
    child.on("close", () => {
      conn.end();
    });
    child.on("error", () => {
      conn.destroy();
    });
    conn.pipe(child.stdin);
    child.stdout.pipe(conn);
  });
  server.listen(socket);
  await once(server, "listening");
  return {
    close: () => {
      server.close();
      for (const child of children) {
        child.kill();
      }
      removeSocketDir(dir);
    },
    dir,
  };
};
