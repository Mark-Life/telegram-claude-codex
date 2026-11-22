import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";

import { claudeLog } from "./claude-log";
import type { GroupMemoryChat, StdioCommand } from "./group-memory-server";
import { openRunView } from "./run-view";
import { sandboxCommand } from "./sandbox/bwrap";
import { claudeStateRoots } from "./state-roots";
import type { RunAccess } from "./types";

/**
 * A Claude child inside the bwrap view. The SDK hands every spawn to
 * `spawnClaudeCodeProcess`, so the view is prepended there: bwrap, its flags,
 * then the CLI the SDK chose with the SDK's own arguments. The view holds that
 * binary read-only and the real `.credentials.json` read-write in every
 * posture, `none` and helper turns included: without it the CLI has no
 * subscription login, and a token refresh must land. A member's
 * `workspace-write` run can read it; groups, guests and Business replies run
 * `none`, with no tool that reads files. No run in the view keeps a session,
 * so no transcripts directory is bound. Everything else of
 * `~/.claude` and `~/.claude.json` is gone: the CLI starts from an empty home.
 * With `socat` on the host the view has its own network and reaches only
 * Anthropic: web search runs there, so the CLI needs no other host, and a
 * run in the view gets no `WebFetch`. The chat's
 * memory server runs outside the view, behind a relay.
 */

/** What Claude itself talks to: the API and the login refresh. */
const CLAUDE_HOSTS = ["api.anthropic.com", "platform.claude.com"];

/** The config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
const configDir = () => claudeStateRoots()[0] ?? "";

/** The real credentials file, bound read-write so a token refresh lands. */
const credentialBinds = () => {
  const file = path.join(configDir(), ".credentials.json");
  return existsSync(file) ? [{ source: file, target: file }] : [];
};

const STDERR_TAIL_CHARS = 2000;

/**
 * Start the wrapped child. Its stderr is kept as a short tail and logged when
 * the child fails, because a view that cannot start says why only there.
 */
const spawnLogged = (argv: readonly string[], options: SpawnOptions) => {
  const [command = "", ...args] = argv;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail = `${tail}${chunk.toString("utf-8")}`.slice(-STDERR_TAIL_CHARS);
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      claudeLog(
        Effect.logWarning("claude sandboxed child failed", {
          code,
          stderr: tail,
        })
      );
    }
  });
  const spawned: SpawnedProcess = child;
  return spawned;
};

/** What a run inside the view adds to its Claude options. */
export interface ClaudeSandbox {
  close: () => void;
  /** The `group_memory` server through the relay; absent when not wired. */
  groupMemory?: StdioCommand;
  spawn: (options: SpawnOptions) => SpawnedProcess;
}

/**
 * Open the view of one Claude child, or undefined when it runs unwrapped:
 * full access, or no `bwrap` on this host, where only `none` (no local tools)
 * is ever handed to Claude. `groupMemory` starts the chat's memory server
 * outside the view; `close` stops it and the network proxy once the child is
 * gone.
 */
export const openClaudeSandbox = async (input: {
  access: Pick<RunAccess, "env" | "groupMemory" | "sandbox">;
  groupMemory?: GroupMemoryChat;
  workingDirectory: string;
}): Promise<ClaudeSandbox | undefined> => {
  const run = await openRunView({ ...input, hosts: CLAUDE_HOSTS });
  if (run === undefined) {
    return undefined;
  }
  try {
    const readWrite = credentialBinds();
    // Telemetry, error reports and update checks would only be refused by
    // the proxy, one log line each.
    const env = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...run.env };
    const sandbox: ClaudeSandbox = {
      close: run.close,
      spawn: (options) => {
        const cli = realpathSync(options.command);
        const argv = sandboxCommand({
          bwrap: run.bwrap,
          command: run.command([cli, ...options.args]),
          posture: run.posture,
          view: run.view({ readOnly: [cli], readWrite }),
        });
        return spawnLogged(argv, {
          ...options,
          env: { ...options.env, ...env },
        });
      },
    };
    if (run.groupMemory !== undefined) {
      sandbox.groupMemory = run.groupMemory;
    }
    return sandbox;
  } catch (error) {
    run.close();
    throw error;
  }
};
