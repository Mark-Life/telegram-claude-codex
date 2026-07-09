// Injects cloud Executor (executor.sh) as an MCP server into agent runs.
//
// Executor exposes exactly two meta-tools over its streamable-HTTP MCP endpoint:
// `execute` (run code against the configured sources) and `resume` (continue a
// paused, approval-gated execution). Under the Claude Agent SDK's MCP tool
// naming these surface to the model as `mcp__executor__execute` /
// `mcp__executor__resume`.
//
// The endpoint is the org-scoped cloud URL (`https://executor.sh/org_<id>/mcp`)
// and requires auth — an API key minted in the Executor dashboard, passed as
// `Authorization: Bearer <key>`. Both values are optional: when either is
// missing the bot runs without Executor, so nothing here is load-bearing for a
// default install.

import type { CodexOptions } from "@openai/codex-sdk";
import { Effect, Option, Redacted } from "effect";
import { AppConfig } from "../config";

/** The tool names Executor's two MCP tools surface as under the Claude Agent SDK. */
export const EXECUTOR_TOOL_NAMES = [
  "mcp__executor__execute",
  "mcp__executor__resume",
] as const;

/** The normalized (Claude-SDK-shaped) HTTP MCP server entry for Executor. */
interface HttpMcpServer {
  headers: Record<string, string>;
  type: "http";
  url: string;
}

/**
 * Build the `mcpServers` map wiring Executor over streamable HTTP, in the shape
 * the Claude Agent SDK's `options.mcpServers` expects. Returns undefined when
 * either the url or the token is absent/blank, so an unconfigured bot simply
 * runs without Executor.
 */
export const buildExecutorMcpServers = (cfg: {
  token?: string;
  url?: string;
}): Record<string, HttpMcpServer> | undefined => {
  const url = cfg.url?.trim();
  const token = cfg.token?.trim();
  if (!(url && token)) {
    return;
  }
  return {
    executor: {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
};

/** The `--config` override object the Codex SDK flattens into dotted TOML paths. */
type CodexConfigObject = NonNullable<CodexOptions["config"]>;

/**
 * Translate the normalized `mcpServers` map into Codex's `mcp_servers` TOML
 * shape (`{ url, http_headers, default_tools_approval_mode:"auto" }`). Approval
 * is `auto` to match the bot's `danger-full-access` posture — Executor's own
 * tool layer is the real gate. Returns undefined when no server is configured.
 */
export const toCodexMcpServers = (
  mcpServers?: Record<string, HttpMcpServer>
): CodexConfigObject | undefined => {
  if (!mcpServers) {
    return;
  }
  const out: CodexConfigObject = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    out[name] = {
      url: server.url,
      http_headers: server.headers,
      default_tools_approval_mode: "auto",
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Read the boot-resolved Executor credentials from AppConfig and build the
 * `mcpServers` map for a run. Undefined when Executor is not configured.
 */
export const readExecutorMcpServers = Effect.map(AppConfig, (c) =>
  buildExecutorMcpServers({
    url: Option.getOrUndefined(c.executorMcpUrl),
    token: Option.getOrUndefined(Option.map(c.executorApiKey, Redacted.value)),
  })
);

export type { HttpMcpServer };
