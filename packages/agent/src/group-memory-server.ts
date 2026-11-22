import { realpathSync } from "node:fs";

import { GROUP_MEMORY_MCP_SCRIPT } from "./run-prompt";
import { openRelay, RELAY_CLIENT, RELAY_VIEW_SOCKET } from "./sandbox/relay";
import type { RunAccess, RunOptions } from "./types";

/**
 * How an agent child starts the chat's `group_memory` stdio server. The
 * server opens `.data/bot.db` and is locked to one chat by its arguments, so
 * it carries no secret. Outside the view the child starts the script itself;
 * inside it the child starts the relay client, and the bot runs the script.
 */

/** Which chat a memory server is locked to, and who is asking. */
export type GroupMemoryChat = Pick<RunOptions, "chatId" | "userId">;

/** A stdio server command as an agent child starts it. */
export interface StdioCommand {
  args: string[];
  command: string;
}

const scriptArgs = (memory: GroupMemoryChat) => [
  GROUP_MEMORY_MCP_SCRIPT,
  "--chat",
  String(memory.chatId),
  "--actor",
  String(memory.userId),
];

/**
 * The server a run started outside the view gets, or undefined when its
 * access holds no group memory or the caller named no chat.
 */
const directGroupMemory = (input: {
  access: Pick<RunAccess, "groupMemory">;
  groupMemory?: GroupMemoryChat;
}): StdioCommand | undefined =>
  input.access.groupMemory !== "current" || input.groupMemory === undefined
    ? undefined
    : { args: scriptArgs(input.groupMemory), command: process.execPath };

/**
 * The server a run's child starts: inside the view the relay the bot opened,
 * never the script itself, which opens `.data/bot.db` the view hides.
 */
export const groupMemoryCommand = (
  input: Parameters<typeof directGroupMemory>[0],
  sandbox: { groupMemory?: StdioCommand } | undefined
) => (sandbox === undefined ? directGroupMemory(input) : sandbox.groupMemory);

/** The names the memory script needs from the bot's env, nothing secret. */
const RELAY_ENV = ["HOME", "LANG", "LC_ALL", "PATH", "TZ"];

/** Start the chat's memory server outside the view, behind a relay socket. */
export const openGroupMemoryRelay = async (memory: GroupMemoryChat) =>
  await openRelay({
    args: scriptArgs(memory),
    command: process.execPath,
    env: Object.fromEntries(
      RELAY_ENV.flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      })
    ),
  });

/** What a view binds read-only so its child can start the relay client. */
export const relayClientFiles = () => [
  realpathSync(process.execPath),
  RELAY_CLIENT,
];

/** The server a child inside the view starts: the relay client. */
export const relayGroupMemory = () => ({
  args: [RELAY_CLIENT, RELAY_VIEW_SOCKET],
  command: realpathSync(process.execPath),
});
