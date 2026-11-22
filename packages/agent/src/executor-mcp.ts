// Injects cloud Executor (executor.sh) as an MCP server into agent runs.
//
// Executor exposes exactly two meta-tools over its streamable-HTTP MCP endpoint:
// `execute` (run code against the configured sources) and `resume` (continue a
// paused, approval-gated execution).
//
// The endpoint is the org-scoped cloud URL (`https://executor.sh/org_<id>/mcp`)
// and requires auth — an API key minted in the Executor dashboard, sent as
// `Authorization: Bearer <key>`. Both values are optional: when either is
// missing the bot runs without Executor, so nothing here is load-bearing for a
// default install.
//
// The key never travels on an agent's argv, where any user on the host can
// read it from `/proc/<pid>/cmdline`: it goes into the child's env under
// `tokenEnv`, and Codex reads it from there. Claude never gets it: its runs
// reach Executor through an in-process proxy (`claude-mcp-proxy.ts`).

import type { CodexOptions } from "@openai/codex-sdk";
import { AppConfig } from "@workspace/env/bot";
import { Effect, Option, Redacted } from "effect";

/** The env var the Executor key reaches an agent child in. */
const EXECUTOR_TOKEN_ENV = "EXECUTOR_API_KEY";

/** The bot's normalized HTTP MCP server entry: a URL and a bearer token. */
interface HttpMcpServer {
  /** The bearer token; put in the child env, never in its config. */
  token: string;
  /** The env var the child reads `token` from. */
  tokenEnv: string;
  type: "http";
  url: string;
}

/**
 * Build the normalized `mcpServers` map wiring Executor over streamable HTTP.
 * Returns undefined when either the url or the token is absent/blank, so an
 * unconfigured bot simply runs without Executor.
 */
export const buildExecutorMcpServers = (cfg: {
  token?: string;
  url?: string;
}): Record<string, HttpMcpServer> | undefined => {
  const url = cfg.url?.trim() ?? "";
  const token = cfg.token?.trim() ?? "";
  if (url.length === 0 || token.length === 0) {
    return undefined;
  }
  return {
    executor: { token, tokenEnv: EXECUTOR_TOKEN_ENV, type: "http", url },
  };
};

/** The `--config` override object the Codex SDK flattens into dotted TOML paths. */
type CodexConfigObject = NonNullable<CodexOptions["config"]>;

/**
 * Translate the normalized `mcpServers` map into Codex's `mcp_servers` TOML
 * shape (`{ url, bearer_token_env_var, default_tools_approval_mode:"auto" }`).
 * The SDK flattens this config onto argv, so it names the env var and never
 * holds the token; `mcpTokenEnv` gives the env that carries it. Approval is
 * `auto` to match the bot's `danger-full-access` posture — Executor's own tool
 * layer is the real gate. Returns undefined when no server is configured.
 */
export const toCodexMcpServers = (
  mcpServers?: Record<string, HttpMcpServer>
): CodexConfigObject | undefined => {
  if (mcpServers === undefined) {
    return undefined;
  }
  const out: CodexConfigObject = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    out[name] = {
      bearer_token_env_var: server.tokenEnv,
      default_tools_approval_mode: "auto",
      url: server.url,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/** The child env that carries each server's token, by its `tokenEnv`. */
export const mcpTokenEnv = (mcpServers?: Record<string, HttpMcpServer>) =>
  Object.fromEntries(
    Object.values(mcpServers ?? {}).map((server) => [
      server.tokenEnv,
      server.token,
    ])
  );

/**
 * Read the boot-resolved Executor credentials from AppConfig and build the
 * `mcpServers` map for a run. Undefined when Executor is not configured.
 */
export const readExecutorMcpServers = Effect.map(AppConfig, (c) =>
  buildExecutorMcpServers({
    token: Option.getOrUndefined(Option.map(c.executorApiKey, Redacted.value)),
    url: Option.getOrUndefined(c.executorMcpUrl),
  })
);

export type { HttpMcpServer };
