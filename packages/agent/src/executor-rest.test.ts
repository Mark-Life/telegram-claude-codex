import { describe, expect, test } from "bun:test";

import { executorApiBase, runExecutorCode } from "./executor-rest";
import type { FetchLike } from "./executor-rest";

const REST = { apiKey: "exk_test", base: "https://executor.sh/api" };

/** The fields of an execution body a test cares about. */
interface StubBody {
  id?: string;
  isError?: boolean;
  status?: string;
  structured?: { unread: number };
  text?: string;
}

/** A fetch that never answers at all. */
const rejectingFetch: FetchLike = async () =>
  await Promise.reject(new Error("network down"));

/** A fetch answering with a body of a shape the client does not expect. */
const junkBodyFetch: FetchLike = async () =>
  await Promise.resolve({
    json: async () => await Promise.resolve("plain string"),
    ok: true,
    status: 200,
  });

/** A fetch stub answering one body, recording what it was called with. */
const stubFetch = (
  body: StubBody,
  init: { ok?: boolean; status?: number } = {}
) => {
  const calls: { init: RequestInit; url: string }[] = [];
  const impl: FetchLike = async (url, requestInit) => {
    calls.push({ init: requestInit, url });
    return await Promise.resolve({
      json: async () => await Promise.resolve(body),
      ok: init.ok ?? true,
      status: init.status ?? 200,
    });
  };
  return { calls, impl };
};

describe("executorApiBase", () => {
  test("derives the REST base from the org-scoped MCP url", () => {
    expect(executorApiBase("https://executor.sh/org_x/mcp")).toBe(
      "https://executor.sh/api"
    );
  });

  test("keeps a non-default port and refuses junk", () => {
    expect(executorApiBase("http://localhost:8080/org_x/mcp")).toBe(
      "http://localhost:8080/api"
    );
    expect(executorApiBase("not a url")).toBeUndefined();
  });
});

describe("runExecutorCode", () => {
  test("posts the code with auto-approve and bearer auth", async () => {
    const { calls, impl } = stubFetch({ status: "completed", text: "hi" });
    await runExecutorCode({ code: "tools.x()", fetchImpl: impl, rest: REST });

    const [call] = calls;
    expect(call?.url).toBe("https://executor.sh/api/executions");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe(
      JSON.stringify({ autoApprove: true, code: "tools.x()" })
    );
    expect(call?.init.headers).toMatchObject({
      Authorization: "Bearer exk_test",
    });
  });

  test("a completed execution carries its text and structured result", async () => {
    const { impl } = stubFetch({
      status: "completed",
      structured: { unread: 3 },
      text: "3 unread",
    });
    const outcome = await runExecutorCode({
      code: "x",
      fetchImpl: impl,
      rest: REST,
    });
    expect(outcome).toEqual({
      kind: "ok",
      structured: { unread: 3 },
      text: "3 unread",
    });
  });

  test("a paused execution reports its id so a human can resume it", async () => {
    const { impl } = stubFetch({ id: "exec_42", status: "paused", text: "" });
    const outcome = await runExecutorCode({
      code: "x",
      fetchImpl: impl,
      rest: REST,
    });
    expect(outcome).toEqual({
      executionId: "exec_42",
      kind: "paused",
      resume: "rest",
      text: "",
    });
  });

  test("isError becomes a failure carrying the reported text", async () => {
    const { impl } = stubFetch({
      isError: true,
      status: "completed",
      text: "gmail: token expired",
    });
    expect(
      await runExecutorCode({ code: "x", fetchImpl: impl, rest: REST })
    ).toEqual({ kind: "failed", message: "gmail: token expired" });
  });

  test("a non-2xx answer fails with its status", async () => {
    const { impl } = stubFetch({}, { ok: false, status: 401 });
    expect(
      await runExecutorCode({ code: "x", fetchImpl: impl, rest: REST })
    ).toEqual({ kind: "failed", message: "Executor answered HTTP 401." });
  });

  test("a rejected fetch fails with its message instead of throwing", async () => {
    expect(
      await runExecutorCode({
        code: "x",
        fetchImpl: rejectingFetch,
        rest: REST,
      })
    ).toEqual({ kind: "failed", message: "network down" });
  });

  test("a body of an unknown shape fails instead of being trusted", async () => {
    const outcome = await runExecutorCode({
      code: "x",
      fetchImpl: junkBodyFetch,
      rest: REST,
    });
    expect(outcome.kind).toBe("failed");
  });
});
