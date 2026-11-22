import { closeSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { spawn } from "bun";
import { Option, Schema } from "effect";

import { lines, stderrTail } from "./codex-app-server";
import type { JsonValue } from "./codex-app-server";
import type { SandboxMode } from "./types";

/**
 * One `pi --mode rpc` child over stdio: a JSON command per line in, its
 * responses and session events per line out, split on LF only (`lines`
 * and the stderr tail are shared with Codex's app server), since a JSON string may hold U+2028.
 * Responses and events come out in one stream, in the order pi wrote them,
 * so a run can tell whether a prompt's answer came before or after the run
 * it started settled.
 */

/** The extension every child loads: it blocks any tool outside the run's list. */
export const PI_GATE = fileURLToPath(
  new URL("pi-ext/gate.ts", import.meta.url)
);

/** The extension a run with MCP servers loads too (`pi-mcp.ts`). */
export const PI_MCP = fileURLToPath(new URL("pi-ext/mcp.ts", import.meta.url));

/** The variable the gate reads the run's tool list from. */
const GATE_TOOLS_ENV = "BOT_PI_TOOLS";

/**
 * The tools per posture. The view is the only boundary pi has: `read`
 * reads whatever the process can. `read-only` is never handed to pi.
 */
const TOOLS = {
  "danger-full-access": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  none: [],
  "read-only": ["read", "bash", "grep", "find", "ls"],
  "workspace-write": ["read", "bash", "edit", "write", "grep", "find", "ls"],
} as const satisfies Record<SandboxMode, readonly string[]>;

/**
 * What every pi child runs with: no discovery of extensions, MCP, skills,
 * templates, themes or context files, nothing fetched at startup.
 * `--skill` files given after `--no-skills` still load.
 */
const PI_ISOLATION_FLAGS = [
  "--offline",
  "--no-approve",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
] as const;

/**
 * The child's flags, every one fixed rather than left to a default: no
 * discovery of extensions, MCP, skills, templates, themes or context files,
 * project-local files ignored, nothing fetched at startup. `skills` are
 * the files of the bot's skills the run is offered, loaded one by one.
 * `session` is the id to keep or resume, or absent for a throwaway one.
 * `mcp` are the `--tools` entries of the run's MCP servers, which load
 * `PI_MCP`; an MCP tool counts only when listed.
 */
export const piArgs = (input: {
  effort?: string;
  mcp?: readonly string[];
  model: { id: string; provider: string };
  sandbox: SandboxMode;
  session?: string;
  skills: readonly string[];
  system?: string;
}) => {
  const mcp = input.mcp ?? [];
  const tools: readonly string[] = [...TOOLS[input.sandbox], ...mcp];
  return {
    args: [
      "--mode",
      "rpc",
      ...PI_ISOLATION_FLAGS,
      ...input.skills.flatMap((file) => ["--skill", file]),
      "-e",
      PI_GATE,
      ...(mcp.length === 0 ? [] : ["-e", PI_MCP]),
      ...(tools.length === 0 ? ["--no-tools"] : ["--tools", tools.join(",")]),
      "--provider",
      input.model.provider,
      "--model",
      input.model.id,
      ...(input.effort === undefined ? [] : ["--thinking", input.effort]),
      ...(input.session === undefined
        ? ["--no-session"]
        : ["--session-id", input.session]),
      ...(input.system === undefined || input.system.length === 0
        ? []
        : ["--append-system-prompt", input.system]),
    ],
    env: { [GATE_TOOLS_ENV]: tools.join(",") },
  };
};

/**
 * One record pi wrote, a response or a session event: its `type`, and the
 * whole record still undecoded, for the reader that knows its shape.
 */
export interface PiRecord {
  readonly raw: unknown;
  readonly type: string;
}

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
);

const decodeType = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String })
);

/** A response to a command of ours. */
export const decodeResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    command: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
    id: Schema.optional(Schema.String),
    success: Schema.Boolean,
    type: Schema.Literal("response"),
  })
);

/** A command; an undefined field is left out, as JSON leaves it. */
type Command = Readonly<Record<string, JsonValue | undefined>> & {
  readonly type: string;
};

/** How long a child may take to exit once its stdin closed: then SIGTERM. */
const EXIT_GRACE_MS = 1500;
/** Then SIGKILL. */
const KILL_AFTER_MS = 3000;
/** Then the child's pipes are no longer waited for. */
const GIVE_UP_MS = 4500;

const CARRIAGE_RETURN = /\r$/u;

/** The child's fd the MCP extension reads the run's token from. */
const SECRET_FD = 3;

/**
 * Start the child; nothing is sent until the first command. A `secret`
 * goes in on fd 3, a pipe written and closed at once, so it is in neither
 * the child's env nor its argv; pi's `bash` children do not inherit it.
 */
export const openPiRpc = (launch: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  secret?: string;
}) => {
  const proc = spawn({
    cmd: [...launch.argv],
    cwd: launch.cwd,
    env: launch.env,
    stderr: "pipe",
    stdin: "pipe",
    stdio:
      launch.secret === undefined
        ? ["pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe", "pipe"],
    stdout: "pipe",
  });
  if (launch.secret !== undefined) {
    const secretFd = proc.stdio[SECRET_FD];
    if (secretFd === undefined || secretFd === null) {
      proc.kill("SIGKILL");
      throw new Error("pi's secret pipe did not open");
    }
    writeSync(secretFd, launch.secret);
    closeSync(secretFd);
  }
  const waiting = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();
  let toReader: ReadableStreamDefaultController<PiRecord>;
  const records = new ReadableStream<PiRecord>({
    start: (controller) => {
      toReader = controller;
    },
  });
  let nextId = 1;
  let exited = false;
  const stderr = stderrTail(proc.stderr);

  const write = async (line: string) => {
    try {
      await proc.stdin.write(line);
      await proc.stdin.flush();
    } catch {
      // The pipe closed with the child; its stdout ending reports it.
    }
  };

  /** Each call queues its line before its first await: lines go in call order. */
  const send = (command: Command) => {
    if (!exited) {
      void write(`${JSON.stringify(command)}\n`);
    }
  };

  const settle = (
    response: Option.Option.Value<ReturnType<typeof decodeResponse>>
  ) => {
    const waiter =
      response.id === undefined ? undefined : waiting.get(response.id);
    if (response.id === undefined || waiter === undefined) {
      return;
    }
    waiting.delete(response.id);
    if (response.success) {
      waiter.resolve(response.data);
    } else {
      waiter.reject(
        new Error(
          `pi ${response.command ?? "command"} failed: ${JSON.stringify(response.error)}`
        )
      );
    }
  };

  const take = (line: string) => {
    const raw = Option.getOrUndefined(
      decodeJson(line.replace(CARRIAGE_RETURN, ""))
    );
    const typed = Option.getOrUndefined(decodeType(raw));
    if (typed === undefined) {
      return;
    }
    for (const response of Option.toArray(decodeResponse(raw))) {
      settle(response);
    }
    toReader.enqueue({ raw, type: typed.type });
  };

  const readStdout = async () => {
    try {
      for await (const line of lines(proc.stdout)) {
        take(line);
      }
    } finally {
      exited = true;
      const gone = new Error("pi exited");
      for (const waiter of waiting.values()) {
        waiter.reject(gone);
      }
      waiting.clear();
      toReader.close();
    }
  };

  // Both pipes are drained for the child's whole life, so neither stalls it.
  const reading = Promise.allSettled([readStdout(), stderr.done]);

  return {
    /**
     * Stop the child: its stdin closes, which pi takes as an orderly
     * shutdown; SIGTERM after the grace, SIGKILL after another. Resolves
     * once it exited and its output is read, or a grace after the SIGKILL.
     */
    close: async () => {
      try {
        await proc.stdin.end();
      } catch {
        // Already closed.
      }
      const term = setTimeout(() => {
        proc.kill();
      }, EXIT_GRACE_MS);
      const kill = setTimeout(() => {
        proc.kill("SIGKILL");
      }, KILL_AFTER_MS);
      try {
        // A grandchild that kept the pipe open must not hold the run.
        await Promise.race([
          Promise.all([reading, proc.exited]),
          Bun.sleep(GIVE_UP_MS),
        ]);
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
      }
    },
    /** Every record in the order pi wrote it, until its stdout ends. */
    records: () => records.values({ preventCancel: true }),
    /**
     * A command whose answer is awaited and parsed with `answer`; rejects
     * on `success: false`, at the timeout, or once the child is gone. Its
     * response still shows in `records`.
     */
    request: async <S extends Schema.ConstraintDecoder<unknown>>(
      command: Command,
      answer: S,
      timeoutMs: number
    ): Promise<S["Type"]> => {
      if (exited) {
        throw new Error("pi exited");
      }
      const id = `bot-${nextId}`;
      nextId += 1;
      const waiter = Promise.withResolvers<unknown>();
      waiting.set(id, waiter);
      send({ ...command, id });
      const timer = setTimeout(() => {
        waiting.delete(id);
        waiter.reject(new Error(`pi ${command.type} timed out`));
      }, timeoutMs);
      try {
        return Schema.decodeUnknownSync(answer)(await waiter.promise);
      } finally {
        clearTimeout(timer);
      }
    },
    /** A command whose response is read off `records`, by its `id`. */
    send,
    /** The last of what the child wrote to stderr, for the log. */
    stderrTail: stderr.text,
  };
};

export type PiRpc = ReturnType<typeof openPiRpc>;

const LIST_TIMEOUT_MS = 10_000;

const Listed = Schema.Struct({ models: Schema.Array(Schema.Unknown) });

/**
 * The models pi lists as configured here (RPC `get_available_models`), each
 * still undecoded, read on a throwaway child with nothing loaded, about
 * 0.4 s. pi resolves each one's `baseUrl` itself, from its catalog or
 * `models.json`.
 */
export const listPiModels = async (launch: {
  bin: string;
  env: Record<string, string>;
}): Promise<readonly unknown[]> => {
  const rpc = openPiRpc({
    argv: [
      launch.bin,
      "--mode",
      "rpc",
      ...PI_ISOLATION_FLAGS,
      "--no-session",
      "--no-tools",
    ],
    // Nowhere a project `.pi/` could sit.
    cwd: tmpdir(),
    env: launch.env,
  });
  try {
    const listed = await rpc.request(
      { type: "get_available_models" },
      Listed,
      LIST_TIMEOUT_MS
    );
    return listed.models;
  } finally {
    await rpc.close();
  }
};
