import { closeSync, readFileSync } from "node:fs";

import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  McpServerConfig,
} from "@earendil-works/pi-coding-agent";

/**
 * A pi extension the bot loads with `-e` into a run that has MCP servers.
 * It runs pi's own MCP client with an empty config, so no `mcp.json` of the
 * agent dir or the project can add a server or shadow one of ours, and
 * registers exactly the servers the bot names in `BOT_PI_MCP` (no
 * secret): an HTTP one is the bot's loopback proxy (`pi-mcp.ts`), reached
 * with the run's token, which the bot writes to fd 3; a stdio one is the
 * chat's memory server. The token is read once at load and fd 3 closed, so
 * it is in no env, argv or file a tool of the run could read. pi's `/mcp`
 * command is left out: an RPC prompt that names a command would run it.
 */

const TOKEN_FD = 3;
/** Seconds one call may take: the bot's own proxy allows 600. */
const CALL_TIMEOUT_S = 600;

/**
 * The servers, one per line, fields split by tabs: `http <name> <url>` or
 * `stdio <name> <command> <args…>`. Anything else is skipped.
 */
const servers = (process.env.BOT_PI_MCP ?? "")
  .split("\n")
  .map((line) => line.split("\t"))
  .flatMap(([kind, name, target, ...args]) =>
    name === undefined ||
    target === undefined ||
    (kind !== "http" && kind !== "stdio")
      ? []
      : [{ args, kind, name, target }]
  );

const readToken = () => {
  try {
    return readFileSync(TOKEN_FD, "utf-8").trim();
  } finally {
    closeSync(TOKEN_FD);
  }
};

const token = servers.some((server) => server.kind === "http")
  ? readToken()
  : "";

const configOf = (server: (typeof servers)[number]): McpServerConfig =>
  server.kind === "http"
    ? {
        exposure: "direct",
        headers: { Authorization: `Bearer ${token}` },
        timeout: CALL_TIMEOUT_S,
        type: "http",
        url: server.target,
      }
    : {
        args: server.args,
        command: server.target,
        exposure: "direct",
        type: "stdio",
      };

/** pi's `/mcp` command, not registered. */
const skipCommand = () => {
  // An RPC prompt naming a command would run it.
};

/**
 * `pi` without `registerCommand`, for pi's MCP extension. pi's API object
 * is a plain record of closures, so a copy calls the same ones.
 */
const withoutCommands = (pi: ExtensionAPI): ExtensionAPI => ({
  ...pi,
  registerCommand: skipCommand,
});

const mcp = async (pi: ExtensionAPI) => {
  await createMcpExtension({
    loadConfig: () => ({ autoEnableCodemode: false, errors: [], servers: [] }),
  })(withoutCommands(pi));
  for (const server of servers) {
    pi.registerMcpServer(server.name, configOf(server));
  }
};

export default mcp;
