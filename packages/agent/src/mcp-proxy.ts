import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { RunAccess, RunContext } from "./types";

/**
 * The bot's side of a run's MCP servers that need a bearer token (Executor,
 * the owner's Telegram account): one MCP `Client` per granted endpoint, in
 * the bot process, which alone holds the token, and an `McpServer` that
 * forwards `tools/list` and `tools/call` to it. Claude gets that server
 * in-process (`claude-mcp-proxy.ts`), pi over loopback HTTP behind a per-run
 * token (`pi-mcp.ts`). Either way the real token never reaches the child.
 */

/** One HTTP MCP endpoint the bot holds the bearer token of. */
interface Upstream {
  name: string;
  token: string;
  url: string;
}

const CLIENT_INFO = { name: "owner-telegram-bot", version: "1.0.0" };

/** How long the upstream may take to answer `initialize`. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long one tool call may run. An Executor `execute` can be slow; each
 * progress notification from the upstream restarts the clock.
 */
export const CALL_TIMEOUT_MS = 600_000;

/**
 * An MCP client connected to `upstream`. `fetch` replaces the global one (a
 * test's stub).
 */
export const connectUpstream = async (
  upstream: Pick<Upstream, "token" | "url">,
  options: { fetch?: FetchLike } = {}
) => {
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(upstream.url), {
    fetch: options.fetch,
    requestInit: { headers: { Authorization: `Bearer ${upstream.token}` } },
  });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
};

/**
 * A server forwarding to `client`. It keeps the upstream's own instructions,
 * which the agent shows the model.
 */
export const proxyServer = (name: string, client: Client) => {
  const instructions = client.getInstructions();
  const mcp = new McpServer(
    { name, version: CLIENT_INFO.version },
    instructions === undefined
      ? { capabilities: { tools: {} } }
      : { capabilities: { tools: {} }, instructions }
  );
  mcp.server.setRequestHandler(
    ListToolsRequestSchema,
    async (request, extra) =>
      await client.listTools(request.params, { signal: extra.signal })
  );
  // The client puts its own progress token on the forwarded call, so the
  // upstream's progress is relayed under the token the agent sent, if any.
  mcp.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const progressToken = request.params._meta?.progressToken;
      return await client.request(
        { method: "tools/call", params: request.params },
        CallToolResultSchema,
        {
          onprogress: (progress) => {
            if (progressToken !== undefined) {
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { ...progress, progressToken },
                })
                .catch(() => {
                  // swallow: progress is advisory, the call result still arrives
                });
            }
          },
          resetTimeoutOnProgress: true,
          signal: extra.signal,
          timeout: CALL_TIMEOUT_MS,
        }
      );
    }
  );
  return mcp;
};

/** A connected upstream: its name and the client holding its token. */
export interface OpenUpstream {
  client: Client;
  name: string;
}

/**
 * Connect every upstream; one that does not answer is left out and reported
 * to `onUnavailable`, and the run goes on without it.
 */
export const openUpstreams = async (
  upstreams: readonly Upstream[],
  onUnavailable: (server: string, error: string) => void
): Promise<OpenUpstream[]> => {
  const opened = await Promise.all(
    upstreams.map(async (upstream) => {
      try {
        return [
          { client: await connectUpstream(upstream), name: upstream.name },
        ];
      } catch (error) {
        onUnavailable(upstream.name, String(error));
        return [];
      }
    })
  );
  return opened.flat();
};

/** The endpoints this run's narrowed access and context grant. */
export const upstreamsOf = (
  access: Pick<RunAccess, "externalTools" | "telegramAccount">,
  ctx: Pick<RunContext, "mcpServers" | "telegramAccount">
): Upstream[] => {
  const external = access.externalTools
    ? Object.entries(ctx.mcpServers ?? {}).map(([name, server]) => ({
        name,
        token: server.token,
        url: server.url,
      }))
    : [];
  const account = ctx.telegramAccount;
  return access.telegramAccount && account !== undefined
    ? [
        ...external,
        { name: "telegram_account", token: account.token, url: account.url },
      ]
    : external;
};
