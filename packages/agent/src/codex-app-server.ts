import { spawn } from "bun";
import { Option, Schema } from "effect";

/**
 * One `codex app-server` child over stdio: newline-delimited JSON-RPC with
 * no `jsonrpc` field. A run talks to it for its whole life, so it can hand
 * the running turn more input (`turn/steer`), which `codex exec` cannot.
 * The child answers our requests, sends notifications, and now and then asks
 * something of its own: an approval or an MCP server's question, refused as
 * `codex exec` refuses them.
 */

/** What the child is started with: the same binary and env `codex exec` had. */
export interface AppServerLaunch {
  args: readonly string[];
  bin: string;
  env: Record<string, string>;
}

/** A server notification: its method and its still undecoded params. */
export interface AppServerNotification {
  method: string;
  params: unknown;
}

/** A JSON value, as a request carries it. */
export type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/** A request's params; an undefined field is left out, as JSON leaves it. */
type RequestParams = Readonly<Record<string, JsonValue | undefined>>;

/** The protocol's request ids; ours are numbers, the child's may be either. */
const RequestId = Schema.Union([Schema.String, Schema.Number]);

/** A line with a `method`: the child's notification, or its request with an `id`. */
const decodeFromServer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(RequestId),
      method: Schema.String,
      params: Schema.optional(Schema.Unknown),
    })
  )
);

/** A line without one: the answer to a request of ours. */
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
      id: Schema.Number,
      result: Schema.optional(Schema.Unknown),
    })
  )
);

type Answer = Option.Option.Value<ReturnType<typeof decodeAnswer>>;

/** An answer whose result nobody reads, checked only for being an object. */
export const AnyResult = Schema.Struct({});

/**
 * The longest line read, 64 million characters. A completed command
 * carries its whole output, so this is large, and still bounded.
 */
const MAX_LINE_CHARS = 64_000_000;

/**
 * Newline-delimited lines off a byte stream, the last one too when the
 * stream ends without a newline. Only `\n` ends a line: Codex writes U+2028
 * unescaped inside JSON strings, which a line reader that also splits on it
 * would cut in half. Only each new chunk is scanned, and a line past
 * `MAX_LINE_CHARS` ends the read: a child that floods without newlines must not
 * hold the event loop or the memory. pi's RPC child is read the same way.
 *
 * @yields {string} each line, without its newline.
 */
export const lines = async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    let start = 0;
    let end = text.indexOf("\n");
    while (end !== -1) {
      yield `${buffered}${text.slice(start, end)}`;
      buffered = "";
      start = end + 1;
      end = text.indexOf("\n", start);
    }
    buffered += text.slice(start);
    if (buffered.length > MAX_LINE_CHARS) {
      throw new Error("line too long");
    }
  }
  const rest = `${buffered}${decoder.decode()}`;
  if (rest.length > 0) {
    yield rest;
  }
};

/** How much of a child's stderr is kept for a crash message. */
const STDERR_TAIL_CHARS = 4000;

/**
 * A child's stderr, drained for its whole life so it never stalls the
 * child, keeping only its last `STDERR_TAIL_CHARS`. pi's RPC child reads
 * its stderr the same way.
 */
export const stderrTail = (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let tail = "";
  const done = (async () => {
    for await (const chunk of stream) {
      tail = `${tail}${decoder.decode(chunk, { stream: true })}`.slice(
        -STDERR_TAIL_CHARS
      );
    }
  })();
  return { done, text: () => tail.trim() };
};

/** How long a stopped child may take to exit before it is killed outright. */
const KILL_GRACE_MS = 1500;

/** The JSON-RPC code of a method the client does not serve. */
const METHOD_NOT_FOUND = -32_601;

/**
 * The answer to a request of the child's own, as `codex exec` gives it: an
 * MCP server's question is cancelled, anything else refused. With approvals
 * set to never the child asks for none.
 */
const answerOf = (method: string) =>
  method === "mcpServer/elicitation/request"
    ? { result: { _meta: null, action: "cancel", content: null } }
    : { error: { code: METHOD_NOT_FOUND, message: `${method} is not served` } };

/** Start the child. Nothing is sent until the first `request`. */
export const openAppServer = (launch: AppServerLaunch) => {
  const proc = spawn({
    cmd: [launch.bin, ...launch.args],
    env: launch.env,
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();
  let toReader: ReadableStreamDefaultController<AppServerNotification>;
  // Buffered until read, in order; a reader that stops early leaves it open.
  const notifications = new ReadableStream<AppServerNotification>({
    start: (controller) => {
      toReader = controller;
    },
  });
  let nextId = 1;
  let exited = false;
  const stderr = stderrTail(proc.stderr);

  /**
   * A child that is gone fails the write, now or once the pipe drains; its
   * stdout ending reports it. Each call queues its line before its first
   * await, so lines go out in call order.
   */
  const send = async (line: string) => {
    try {
      await proc.stdin.write(`${line}\n`);
      await proc.stdin.flush();
    } catch {
      // The pipe closed with the child; `readStdout` rejects what waits.
    }
  };
  const write = (line: string) => {
    void send(line);
  };

  const settle = (answer: Answer) => {
    const waiter = pending.get(answer.id);
    if (waiter === undefined) {
      return;
    }
    pending.delete(answer.id);
    if (answer.error === undefined) {
      waiter.resolve(answer.result);
    } else {
      waiter.reject(new Error(answer.error.message));
    }
  };

  const take = (line: string) => {
    const fromServer = Option.getOrUndefined(decodeFromServer(line));
    if (fromServer === undefined) {
      for (const answer of Option.toArray(decodeAnswer(line))) {
        settle(answer);
      }
      return;
    }
    if (fromServer.id === undefined) {
      toReader.enqueue({
        method: fromServer.method,
        params: fromServer.params,
      });
    } else {
      write(
        JSON.stringify({ id: fromServer.id, ...answerOf(fromServer.method) })
      );
    }
  };

  const readStdout = async () => {
    try {
      for await (const line of lines(proc.stdout)) {
        take(line);
      }
    } finally {
      exited = true;
      const gone = new Error(
        `Codex app-server exited${stderr.text().length > 0 ? `: ${stderr.text()}` : ""}`
      );
      for (const waiter of pending.values()) {
        waiter.reject(gone);
      }
      pending.clear();
      toReader.close();
    }
  };

  // Both pipes are drained for the child's whole life, so neither fills up
  // and stalls it. A read that fails ends the stream, which the run sees.
  const reading = Promise.allSettled([readStdout(), stderr.done]);

  return {
    /**
     * Stop the child: SIGTERM, then SIGKILL if it is still there after the
     * grace. Resolves once its output is read to the end, or at the grace.
     */
    close: async () => {
      proc.kill();
      const grace = Promise.withResolvers<undefined>();
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
        grace.resolve();
      }, KILL_GRACE_MS);
      try {
        await Promise.race([reading, grace.promise]);
      } finally {
        clearTimeout(timer);
      }
    },
    /** Notifications in order, until the child's stdout ends. */
    notifications: () => notifications.values({ preventCancel: true }),
    /** Tell the child something that needs no answer. */
    notify: (method: string) => {
      if (!exited) {
        write(JSON.stringify({ method }));
      }
    },
    /**
     * Ask the child, and parse its result with `answer`; rejects with the
     * child's error, or once the child is gone.
     */
    request: async <S extends Schema.ConstraintDecoder<unknown>>(
      method: string,
      params: RequestParams,
      answer: S
    ): Promise<S["Type"]> => {
      if (exited) {
        throw new Error("Codex app-server exited");
      }
      const id = nextId;
      nextId += 1;
      const waiter = Promise.withResolvers<unknown>();
      pending.set(id, waiter);
      write(JSON.stringify({ id, method, params }));
      return Schema.decodeUnknownSync(answer)(await waiter.promise);
    },
    /** The last of what the child wrote to stderr, for a crash message. */
    stderrTail: stderr.text,
  };
};

export type AppServer = ReturnType<typeof openAppServer>;
