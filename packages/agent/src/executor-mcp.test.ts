import { describe, expect, test } from "bun:test";

import { buildExecutorMcpServers, toCodexMcpServers } from "./executor-mcp";

const URL = "https://executor.sh/org_abc/mcp";

describe("buildExecutorMcpServers", () => {
  test("wires the executor server over http with a bearer token", () => {
    expect(buildExecutorMcpServers({ token: "key", url: URL })).toEqual({
      executor: {
        token: "key",
        tokenEnv: "EXECUTOR_API_KEY",
        type: "http",
        url: URL,
      },
    });
  });

  test("trims surrounding whitespace on both values", () => {
    expect(
      buildExecutorMcpServers({ token: " key\n", url: ` ${URL} ` })
    ).toEqual({
      executor: {
        token: "key",
        tokenEnv: "EXECUTOR_API_KEY",
        type: "http",
        url: URL,
      },
    });
  });

  test.each([
    ["no url", { token: "key" }],
    ["no token", { url: URL }],
    ["neither", {}],
    ["blank url", { token: "key", url: "  " }],
    ["blank token", { token: "", url: URL }],
  ])("returns undefined when %s", (_name, cfg) => {
    expect(buildExecutorMcpServers(cfg)).toBeUndefined();
  });
});

describe("toCodexMcpServers", () => {
  test("translates the http shape into codex's toml shape", () => {
    const servers = buildExecutorMcpServers({ token: "key", url: URL });
    expect(toCodexMcpServers(servers)).toEqual({
      executor: {
        bearer_token_env_var: "EXECUTOR_API_KEY",
        default_tools_approval_mode: "auto",
        url: URL,
      },
    });
  });

  test("returns undefined when executor is unconfigured", () => {
    expect(toCodexMcpServers()).toBeUndefined();
    expect(toCodexMcpServers({})).toBeUndefined();
  });
});
