import { describe, expect, test } from "bun:test";
import {
  buildExecutorMcpServers,
  EXECUTOR_TOOL_NAMES,
  toCodexMcpServers,
} from "./executor-mcp";

const URL = "https://executor.sh/org_abc/mcp";

describe("buildExecutorMcpServers", () => {
  test("wires the executor server over http with a bearer token", () => {
    expect(buildExecutorMcpServers({ url: URL, token: "key" })).toEqual({
      executor: {
        type: "http",
        url: URL,
        headers: { Authorization: "Bearer key" },
      },
    });
  });

  test("trims surrounding whitespace on both values", () => {
    expect(
      buildExecutorMcpServers({ url: ` ${URL} `, token: " key\n" })
    ).toEqual({
      executor: {
        type: "http",
        url: URL,
        headers: { Authorization: "Bearer key" },
      },
    });
  });

  test.each([
    ["no url", { token: "key" }],
    ["no token", { url: URL }],
    ["neither", {}],
    ["blank url", { url: "  ", token: "key" }],
    ["blank token", { url: URL, token: "" }],
  ])("returns undefined when %s", (_name, cfg) => {
    expect(buildExecutorMcpServers(cfg)).toBeUndefined();
  });

  test("exposes the two tool names the sdk surfaces", () => {
    expect(EXECUTOR_TOOL_NAMES).toEqual([
      "mcp__executor__execute",
      "mcp__executor__resume",
    ]);
  });
});

describe("toCodexMcpServers", () => {
  test("translates the http shape into codex's toml shape", () => {
    const servers = buildExecutorMcpServers({ url: URL, token: "key" });
    expect(toCodexMcpServers(servers)).toEqual({
      executor: {
        url: URL,
        http_headers: { Authorization: "Bearer key" },
        default_tools_approval_mode: "auto",
      },
    });
  });

  test("returns undefined when executor is unconfigured", () => {
    expect(toCodexMcpServers(undefined)).toBeUndefined();
    expect(toCodexMcpServers({})).toBeUndefined();
  });
});
