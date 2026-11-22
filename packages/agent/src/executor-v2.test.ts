import { describe, expect, test } from "bun:test";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Schema } from "effect";

import { runExecutorMcpCode } from "./executor-v2";

const MCP = { apiKey: "exp_test", url: "https://mcp.executor.sh/org/o/mcp" };

/** One stubbed HTTP answer. */
interface StubAnswer {
  body: string;
  contentType?: string;
  status?: number;
}

/** What the stub answers `initialize` with. */
const INITIALIZE_RESULT = {
  capabilities: { tools: {} },
  protocolVersion: "2025-06-18",
  serverInfo: { name: "Executor", version: "0" },
};

/** The fields of an `execute` tool result a test sets. */
interface StubResult {
  content?: { text: string; type: string }[];
  isError?: boolean;
  structuredContent?: {
    elicitation?: { message: string };
    invocation?: { app: string; tool: string };
    requestId?: string;
    status: string;
  };
}

/** The fields of a finished program a test sets. */
interface StubExecution {
  error?: {
    message: string;
    response: { recovery: { action: string }; status: number };
  };
  ok: boolean;
  toolCalls: [];
  value?: number | string | { prompt: null; state: { seen: number } };
}

/** A JSON-RPC answer to request `id` with this result. */
const answered =
  (result: StubResult | typeof INITIALIZE_RESULT) =>
  (id: number | string): StubAnswer => ({
    body: JSON.stringify({ id, jsonrpc: "2.0", result }),
  });

/** The `tools/call` answer with this result. */
const executed = (result: StubResult) => answered(result);

/** A completed `execute` whose program ended with this execution. */
const completed = (execution: StubExecution) => ({
  content: [{ text: "summary", type: "text" }],
  structuredContent: { execution, status: "completed", unavailableApps: [] },
});

/** The part of a sent JSON-RPC message a test reads. */
const decodeSent = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
      method: Schema.String,
      params: Schema.optional(Schema.Unknown),
    })
  )
);

/** How the stub answers `tools/call`, by the request's id. */
type ExecuteAnswer = (id: number | string) => StubAnswer;

/** The stub server's answer to one JSON-RPC message. */
const replyTo = (
  method: string,
  id: number | string,
  execute: ExecuteAnswer
): StubAnswer => {
  if (method === "initialize") {
    return answered(INITIALIZE_RESULT)(id);
  }
  if (method === "tools/call") {
    return execute(id);
  }
  return { body: "", status: 202 };
};

/**
 * A fetch playing an MCP server: `initialize` names a session, a
 * notification gets 202, `tools/call` gets `execute`'s answer and the
 * standalone SSE stream is refused. Records every POST it was sent.
 */
const stubFetch = (execute: ExecuteAnswer) => {
  const calls: { body: ReturnType<typeof decodeSent>; headers: Headers }[] = [];
  const impl: FetchLike = async (_url, init) => {
    if (init?.method !== "POST") {
      return await Promise.resolve(new Response(null, { status: 405 }));
    }
    const body = decodeSent(init.body);
    calls.push({ body, headers: new Headers(init.headers) });
    const id = body.id ?? 0;
    const answer = replyTo(body.method, id, execute);
    const headers = new Headers({
      "content-type": answer.contentType ?? "application/json",
      "mcp-session-id": "sess_1",
    });
    return await Promise.resolve(
      new Response(answer.body.length > 0 ? answer.body : null, {
        headers,
        status: answer.status ?? 200,
      })
    );
  };
  return { calls, impl };
};

const run = async (execute: ExecuteAnswer) => {
  const stub = stubFetch(execute);
  const outcome = await runExecutorMcpCode({
    code: "return 1 + 1",
    fetchImpl: stub.impl,
    mcp: MCP,
  });
  return { calls: stub.calls, outcome };
};

describe("runExecutorMcpCode", () => {
  test("initializes, then calls execute on the same session", async () => {
    const { calls } = await run(
      executed(completed({ ok: true, toolCalls: [], value: 2 }))
    );
    expect(calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer exp_test");
    expect(calls[0]?.headers.get("mcp-session-id")).toBeNull();
    expect(calls[2]?.headers.get("authorization")).toBe("Bearer exp_test");
    expect(calls[2]?.headers.get("mcp-session-id")).toBe("sess_1");
    expect(calls[2]?.body.params).toEqual({
      arguments: { code: "return 1 + 1" },
      name: "execute",
    });
  });

  test("a completed program is ok with its value", async () => {
    const value = { prompt: null, state: { seen: 3 } };
    const { outcome } = await run(
      executed(completed({ ok: true, toolCalls: [], value }))
    );
    expect(outcome).toEqual({
      kind: "ok",
      maxCodeChars: 65_536,
      structured: value,
      text: JSON.stringify(value),
    });
  });

  test("a string value is the text itself", async () => {
    const { outcome } = await run(
      executed(completed({ ok: true, toolCalls: [], value: "3 unread" }))
    );
    expect(outcome).toEqual({
      kind: "ok",
      maxCodeChars: 65_536,
      structured: "3 unread",
      text: "3 unread",
    });
  });

  test("a failed program carries its message and service status", async () => {
    const { outcome } = await run(
      executed(
        completed({
          error: {
            message: "Not Found",
            response: {
              recovery: { action: "check the repo name" },
              status: 404,
            },
          },
          ok: false,
          toolCalls: [],
        })
      )
    );
    expect(outcome).toEqual({
      kind: "failed",
      message: "Not Found (HTTP 404) — check the repo name",
    });
  });

  test("a program waiting for approval is paused with its request id", async () => {
    const { outcome } = await run(
      executed({
        content: [{ text: "Approve publish?", type: "text" }],
        structuredContent: {
          elicitation: { message: "Publish the post?" },
          invocation: { app: "blog", tool: "publish" },
          requestId: "req_7",
          status: "approval-required",
        },
      })
    );
    expect(outcome).toEqual({
      asks: "blog.publish: Publish the post?",
      executionId: "req_7",
      input: false,
      kind: "paused",
      resume: "mcp",
      text: "Approve publish?",
    });
  });

  test("a JSON-RPC error fails", async () => {
    const { outcome } = await run((id) => ({
      body: JSON.stringify({
        error: { code: -32_602, message: "Unknown tool" },
        id,
        jsonrpc: "2.0",
      }),
    }));
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain(
      "Unknown tool"
    );
  });

  test("an isError result fails with its text", async () => {
    const { outcome } = await run(
      executed({ content: [{ text: "boom", type: "text" }], isError: true })
    );
    expect(outcome).toEqual({ kind: "failed", message: "boom" });
  });

  test("a non-2xx answer to execute fails", async () => {
    const { calls, outcome } = await run(() => ({ body: "", status: 401 }));
    expect(outcome.kind).toBe("failed");
    expect(calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  test("an SSE answer is read from its matching data event", async () => {
    const result = completed({ ok: true, toolCalls: [], value: 2 });
    const { outcome } = await run((id) => ({
      body: `event: message\ndata: ${JSON.stringify({ id, jsonrpc: "2.0", result })}\n\n`,
      contentType: "text/event-stream",
    }));
    expect(outcome).toEqual({
      kind: "ok",
      maxCodeChars: 65_536,
      structured: 2,
      text: "2",
    });
  });

  test("a rejected fetch fails", async () => {
    const outcome = await runExecutorMcpCode({
      code: "x",
      fetchImpl: async () => await Promise.reject(new Error("network down")),
      mcp: MCP,
    });
    expect(outcome).toEqual({ kind: "failed", message: "network down" });
  });
});
