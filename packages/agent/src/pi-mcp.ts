import { randomBytes, timingSafeEqual } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CancelledNotificationSchema,
  isJSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";

import { groupMemoryCommand } from "./group-memory-server";
import type { GroupMemoryChat, StdioCommand } from "./group-memory-server";
import { openUpstreams, proxyServer, upstreamsOf } from "./mcp-proxy";
import type { OpenUpstream } from "./mcp-proxy";
import { piLog } from "./pi-log";
import { runsInView } from "./sandbox/host";
import type { RunAccess, RunContext } from "./types";

/**
 * The MCP servers of one pi run. pi has no in-process channel like Claude's
 * SDK, so the servers that need a bearer token (Executor, the owner's
 * Telegram account) are the shared proxy (`mcp-proxy.ts`) served on a
 * loopback port for the life of the run, behind a token minted for it. The
 * child gets that token on fd 3 (`pi-ext/mcp.ts`), never the real one, and
 * the port closes when the run ends, so the token dies with it. Only a run
 * outside the view gets them: a view has its own network, whose proxy
 * refuses loopback. The chat's `group_memory` server is plain stdio, the
 * relay inside the view.
 */

/** The variable the extension reads its servers from; nothing secret. */
const MCP_ENV = "BOT_PI_MCP";

const LOOPBACK = "127.0.0.1";
const TOKEN_BYTES = 32;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

/**
 * How often an open answer stream gets an SSE comment. pi's HTTP client
 * drops a response that sends nothing for `httpIdleTimeoutMs` (300 s by
 * default), and Bun closes a connection idle for 10 s; a call may run 600.
 */
const KEEPALIVE_MS = 5000;
const KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");

/**
 * A server as the extension registers it, one line of `MCP_ENV` each, its
 * fields split by tabs: `http <name> <url>` or `stdio <name> <command>
 * <args…>`.
 */
type PiServer =
  | { kind: "http"; name: string; url: string }
  | (StdioCommand & { kind: "stdio"; name: string });

const serverLine = (server: PiServer) =>
  (server.kind === "http"
    ? ["http", server.name, server.url]
    : ["stdio", server.name, server.command, ...server.args]
  ).join("\t");

/** One run's MCP servers; `close` revokes the token and drops the clients. */
export interface PiMcp {
  close: () => Promise<void>;
  /** What the child's env gains: the server list, the port kept off a proxy. */
  env: (base: Record<string, string>) => Record<string, string>;
  /** The run's token, for fd 3; undefined when it has no HTTP server. */
  token: string | undefined;
  /** The `--tools` entries: every tool of each server. */
  tools: string[];
}

/** pi's namespace for a server's tools, as it names them, plus `*`. */
const toolsOf = (server: string) =>
  `mcp__${server.replaceAll(/[^A-Za-z0-9_]/gu, "_")}__*`;

const sameToken = (header: string | null, token: string) => {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** What closes each call in flight on one upstream, by its JSON-RPC id. */
type Calls = Map<RequestId, () => void>;

/**
 * `body` with an SSE comment every `KEEPALIVE_MS`, the first at once so
 * the headers go out before the upstream answers. `onEnd` runs once:
 * `answered` when the stream ended, else the client cancelled it.
 */
const keptAlive = (
  body: ReadableStream<Uint8Array>,
  onEnd: (answered: boolean) => void
) => {
  const reader = body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  const end = (answered: boolean) => {
    clearInterval(timer);
    onEnd(answered);
  };
  return new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      end(false);
      await reader.cancel(reason);
    },
    pull: async (controller) => {
      const next = await reader.read();
      if (next.done) {
        end(true);
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    start: (controller) => {
      controller.enqueue(KEEPALIVE);
      timer = setInterval(() => {
        controller.enqueue(KEEPALIVE);
      }, KEEPALIVE_MS);
    },
  });
};

/**
 * One request to the proxy of `upstream`. Stateless, as the account server
 * is: a server object per request, answering over SSE kept alive until the
 * upstream answers. When the client drops the request or pi cancels the
 * call, the server closes at once, which cancels the forwarded call: pi
 * sends `notifications/cancelled` as a request of its own, so `calls`
 * finds the call it names. Once answered it closes only after its handler
 * has settled, since closing aborts a handler still in flight, and the
 * SDK's client then cancels upstream a call that already returned.
 */
const handle = async (input: {
  calls: Calls;
  request: Request;
  upstream: OpenUpstream;
}) => {
  const { calls, request } = input;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: HTTP_BAD_REQUEST });
  }
  const cancelled = CancelledNotificationSchema.safeParse(body);
  if (cancelled.success) {
    const { requestId } = cancelled.data.params;
    if (requestId !== undefined) {
      calls.get(requestId)?.();
    }
    return new Response(null, { status: HTTP_ACCEPTED });
  }
  const ids = (Array.isArray(body) ? body : [body]).flatMap((message) =>
    isJSONRPCRequest(message) ? [message.id] : []
  );
  const server = proxyServer(input.upstream.name, input.upstream.client);
  const transport = new WebStandardStreamableHTTPServerTransport();
  let closed = false;
  const close = (answered: boolean) => {
    if (closed) {
      return;
    }
    closed = true;
    for (const id of ids) {
      calls.delete(id);
    }
    if (answered) {
      setTimeout(() => {
        void server.close();
      }, 0);
    } else {
      void server.close();
    }
  };
  const cancel = () => {
    close(false);
  };
  for (const id of ids) {
    calls.set(id, cancel);
  }
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: body,
    });
    if (
      response.body === null ||
      response.headers.get("content-type") !== "text/event-stream"
    ) {
      close(true);
      return response;
    }
    return new Response(keptAlive(response.body, close), {
      headers: response.headers,
      status: response.status,
    });
  } catch (error) {
    cancel();
    throw error;
  }
};

/** Serve `upstreams` on loopback, each at `/<name>`, behind `token`. */
const serve = (upstreams: readonly OpenUpstream[], token: string) => {
  const calls = new Map(
    upstreams.map((upstream): [string, Calls] => [upstream.name, new Map()])
  );
  return Bun.serve({
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1);
      const upstream = upstreams.find((entry) => entry.name === name);
      const open = calls.get(name);
      if (upstream === undefined || open === undefined) {
        return new Response("not found", { status: HTTP_NOT_FOUND });
      }
      if (!sameToken(request.headers.get("authorization"), token)) {
        return new Response("unauthorized", { status: HTTP_UNAUTHORIZED });
      }
      return await handle({ calls: open, request, upstream });
    },
    hostname: LOOPBACK,
    port: 0,
  });
};

/**
 * `NO_PROXY` and `no_proxy`, each the entries of both in `base` plus
 * `entry`: tools read one or the other first, and a name set in one case
 * only must not hide the host's list behind the other.
 */
const noProxy = (base: Record<string, string>, entry: string) => {
  const merged = [
    ...new Set(
      [base.NO_PROXY, base.no_proxy, entry]
        .flatMap((value) => value?.split(",") ?? [])
        .flatMap((part) => (part.trim() === "" ? [] : [part.trim()]))
    ),
  ].join(",");
  return { NO_PROXY: merged, no_proxy: merged };
};

/**
 * Open every MCP server a pi run may use. An upstream that does not answer
 * is left out with a `pi.mcp.unavailable` warning, as on Claude.
 */
export const openPiMcp = async (input: {
  access: RunAccess;
  ctx: Pick<RunContext, "mcpServers" | "telegramAccount">;
  groupMemory?: GroupMemoryChat;
  sandbox?: { groupMemory?: StdioCommand };
}): Promise<PiMcp> => {
  const upstreams = runsInView(input.access.sandbox)
    ? []
    : await openUpstreams(
        upstreamsOf(input.access, input.ctx),
        (server, error) => {
          piLog(Effect.logWarning("pi.mcp.unavailable", { error, server }));
        }
      );
  const token =
    upstreams.length === 0
      ? undefined
      : randomBytes(TOKEN_BYTES).toString("hex");
  const http = token === undefined ? undefined : serve(upstreams, token);
  const memory = groupMemoryCommand(input, input.sandbox);
  const servers: PiServer[] = [
    ...upstreams.map((upstream) => ({
      kind: "http" as const,
      name: upstream.name,
      url: `http://${LOOPBACK}:${String(http?.port)}/${upstream.name}`,
    })),
    ...(memory === undefined
      ? []
      : [{ ...memory, kind: "stdio" as const, name: "group_memory" }]),
  ];
  if (servers.length > 0) {
    piLog(
      Effect.logInfo("pi.mcp", {
        servers: servers.map((server) => server.name),
      })
    );
  }
  const env = (base: Record<string, string>) => {
    const added: Record<string, string> = {};
    if (servers.length > 0) {
      added[MCP_ENV] = servers.map(serverLine).join("\n");
    }
    if (http !== undefined) {
      Object.assign(added, noProxy(base, `${LOOPBACK}:${String(http.port)}`));
    }
    return added;
  };
  return {
    close: async () => {
      await http?.stop(true);
      await Promise.allSettled(
        upstreams.map(async (upstream) => {
          await upstream.client.close();
        })
      );
    },
    env,
    token,
    tools: servers.map((server) => toolsOf(server.name)),
  };
};
