import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";

import { claudeLog } from "./claude-log";
import type { ClaudeSandbox } from "./claude-sandbox";
import { groupMemoryCommand } from "./group-memory-server";
import type { GroupMemoryChat } from "./group-memory-server";
import {
  CALL_TIMEOUT_MS,
  openUpstreams,
  proxyServer,
  upstreamsOf,
} from "./mcp-proxy";
import type { RunAccess, RunContext } from "./types";

/**
 * The MCP servers of one Claude run. A server that needs a bearer token
 * (Executor, the owner's Telegram account) is an in-process `type:"sdk"`
 * proxy (`mcp-proxy.ts`): the CLI talks to it over the SDK's own channel,
 * and the bot alone holds the token. The token never reaches the CLI's
 * argv, its env or the model's shell. The chat's `group_memory` server is
 * plain stdio, because it carries no secret.
 */

/** The MCP servers of one run, and how to let go of them once it ends. */
export interface ClaudeMcp {
  close: () => Promise<void>;
  servers: Record<string, McpServerConfig>;
}

/**
 * Open every MCP server a run may use. Inside the view the chat's memory
 * server is the relay the sandbox opened; outside it the CLI starts the
 * script. Memory tools load on the first turn rather than behind tool
 * search, because a run without local tools has no tool search.
 */
export const openClaudeMcp = async (input: {
  access: RunAccess;
  ctx: RunContext;
  groupMemory?: GroupMemoryChat;
  sandbox?: ClaudeSandbox;
}) => {
  const upstreams = await openUpstreams(
    upstreamsOf(input.access, input.ctx),
    (server, error) => {
      claudeLog(
        Effect.logWarning("claude.mcp.unavailable", {
          error,
          server,
        })
      );
    }
  );
  const proxies = upstreams.map((upstream) => ({
    client: upstream.client,
    config: {
      instance: proxyServer(upstream.name, upstream.client),
      name: upstream.name,
      timeout: CALL_TIMEOUT_MS,
      type: "sdk",
    } satisfies McpSdkServerConfigWithInstance,
  }));
  const servers: Record<string, McpServerConfig> = Object.fromEntries(
    proxies.map((proxy) => [proxy.config.name, proxy.config])
  );
  const memory = groupMemoryCommand(input, input.sandbox);
  if (memory !== undefined) {
    servers.group_memory = { ...memory, alwaysLoad: true, type: "stdio" };
  }
  return {
    close: async () => {
      await Promise.allSettled(
        proxies.flatMap((proxy) => [
          proxy.client.close(),
          proxy.config.instance.close(),
        ])
      );
    },
    servers,
  };
};
