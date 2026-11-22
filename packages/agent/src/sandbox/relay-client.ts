// Runs inside a bwrap view: pipes this process's stdio to the unix socket named
// by the first argument, where the bot serves the real stdio server. No
// imports beyond node: the view has bun and this file, nothing else of the repo.

import { connect } from "node:net";

const USAGE_EXIT = 2;
const SOCKET_ARG = 2;
const target = process.argv.at(SOCKET_ARG);
if (target === undefined) {
  process.stderr.write("usage: relay-client <socket>\n");
  process.exit(USAGE_EXIT);
}
const conn = connect({ allowHalfOpen: true, path: target });
process.stdin.pipe(conn);
conn.pipe(process.stdout);
// Once the socket is gone, stop reading stdin so the process can exit.
conn.on("close", () => {
  process.stdin.destroy();
});
conn.on("error", () => {
  process.exitCode = 1;
});
