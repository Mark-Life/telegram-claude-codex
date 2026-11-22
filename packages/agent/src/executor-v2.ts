// Model-free replay of stored code through Executor v2 (mcp.executor.sh).
//
// v2 has no REST door that runs code: its only one is the MCP `execute` tool.
// So the scheduler connects an MCP client to the same endpoint an agent run
// talks to and calls `execute` once. No model is involved, so a saved script
// still costs no tokens. v2 has no `autoApprove`: a program that reaches an
// approval-gated tool pauses, and only the MCP `resume` tool continues it.

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Option, Schema } from "effect";

import {
  messageOf,
  REPORTED_ERROR,
  UNREADABLE_ANSWER,
} from "./executor-outcome";
import type { ExecutionOutcome } from "./executor-outcome";
import { CALL_TIMEOUT_MS, connectUpstream } from "./mcp-proxy";

/** Credentials one MCP replay needs: the `EXECUTOR_MCP_URL` and its key. */
export interface ExecutorMcp {
  apiKey: string;
  url: string;
}

/** A text block of a `tools/call` result. */
const ContentBlock = Schema.Struct({
  text: Schema.optional(Schema.String),
  type: Schema.String,
});

/** The tool a pending interaction belongs to. */
const PendingTool = Schema.Struct({
  app: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
});

/**
 * What `execute` reports. `completed` carries the program's own result; a
 * pending interaction carries the request a human answers through `resume`;
 * `unavailable`, `busy` and `capacity-exceeded` say why nothing ran.
 */
const ExecuteOutcome = Schema.Struct({
  elicitation: Schema.optional(
    Schema.Struct({ message: Schema.optional(Schema.String) })
  ),
  execution: Schema.optional(
    Schema.Struct({
      error: Schema.optional(
        Schema.Struct({
          message: Schema.optional(Schema.String),
          response: Schema.optional(
            Schema.Struct({
              recovery: Schema.optional(
                Schema.Struct({ action: Schema.optional(Schema.String) })
              ),
              status: Schema.optional(Schema.Number),
            })
          ),
        })
      ),
      ok: Schema.Boolean,
      truncated: Schema.optional(Schema.Boolean),
      value: Schema.optional(Schema.Unknown),
    })
  ),
  invocation: Schema.optional(PendingTool),
  message: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  status: Schema.String,
  tool: Schema.optional(PendingTool),
});

/** A `tools/call` result: the text blocks and the structured outcome. */
const ToolResult = Schema.Struct({
  content: Schema.optional(Schema.Array(ContentBlock)),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(ExecuteOutcome),
});

type ToolResultValue = typeof ToolResult.Type;

const decodeToolResult = Schema.decodeUnknownOption(ToolResult);
const decodeString = Schema.decodeUnknownOption(Schema.String);

/** The longest code v2's `execute` takes. */
const EXECUTE_MAX_CODE_CHARS = 65_536;

/** Status of a program waiting for form input rather than a yes or no. */
const INPUT_REQUIRED = "input-required";

/** Statuses of a program that stopped to ask a human something. */
const PENDING = new Set(["approval-required", INPUT_REQUIRED]);

/**
 * What a pending interaction asks, for the owner to decide on: the tool
 * (`invocation` on an approval, `tool` on an input) and its question.
 */
const asksOf = (outcome: typeof ExecuteOutcome.Type) => {
  const owner = outcome.invocation ?? outcome.tool;
  const tool = [owner?.app, owner?.tool]
    .filter((part) => part !== undefined)
    .join(".");
  const question = outcome.elicitation?.message?.trim() ?? "";
  const parts = [tool, question].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(": ") : undefined;
};

/**
 * The marker Executor puts in place of a value over its output limit. It sets
 * `truncated` for dropped logs too, so only this marker means the value is cut.
 */
const TRUNCATED_VALUE = "[result truncated:";

/** A failed program's message, with the service status and next step. */
const failureOf = (
  error: NonNullable<
    NonNullable<typeof ExecuteOutcome.Type.execution>["error"]
  > = {}
) => {
  const message = error.message?.trim() ?? "";
  const parts = [message.length > 0 ? message : "the script failed"];
  // Executor often spells both into the message already; say each once.
  const status = error.response?.status;
  if (status !== undefined && !message.includes(`HTTP ${status}`)) {
    parts.push(`(HTTP ${status})`);
  }
  const action = error.response?.recovery?.action;
  if (action !== undefined && !message.includes(action)) {
    parts.push(`— ${action}`);
  }
  return parts.join(" ");
};

/** Turn an `execute` tool result into the outcome the caller acts on. */
const outcomeOf = (tool: ToolResultValue): ExecutionOutcome => {
  const text = (tool.content ?? [])
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  if (tool.isError === true) {
    return {
      kind: "failed",
      message: text.length > 0 ? text : REPORTED_ERROR,
    };
  }
  const outcome = tool.structuredContent;
  if (outcome === undefined) {
    return { kind: "failed", message: UNREADABLE_ANSWER };
  }
  if (PENDING.has(outcome.status)) {
    return {
      asks: asksOf(outcome),
      executionId: outcome.requestId,
      input: outcome.status === INPUT_REQUIRED,
      kind: "paused",
      resume: "mcp",
      text,
    };
  }
  if (outcome.status !== "completed" || outcome.execution === undefined) {
    const why = outcome.message === undefined ? "" : `: ${outcome.message}`;
    return {
      kind: "failed",
      message: `Executor did not run the script (${outcome.status})${why}`,
    };
  }
  const { execution } = outcome;
  if (!execution.ok) {
    return { kind: "failed", message: failureOf(execution.error) };
  }
  // A string value is the text itself; anything else is delivered as JSON.
  const asString = Option.getOrUndefined(decodeString(execution.value));
  if (
    execution.truncated === true &&
    asString?.includes(TRUNCATED_VALUE) === true
  ) {
    return {
      kind: "failed",
      message:
        "the script's result is over Executor's output limit; return a smaller value",
    };
  }
  return {
    kind: "ok",
    maxCodeChars: EXECUTE_MAX_CODE_CHARS,
    structured: execution.value,
    text: asString ?? JSON.stringify(execution.value) ?? "",
  };
};

/**
 * Run stored code through Executor v2's MCP `execute` and report what
 * happened. Every failure is data — a rejected fetch, a non-2xx answer, a
 * JSON-RPC error and an `isError` result all arrive as `failed` — so a caller
 * never has to catch anything. A run that stops for an approval or input
 * comes back as `paused` with the request id `resume` answers.
 */
export const runExecutorMcpCode = async (args: {
  code: string;
  fetchImpl?: FetchLike;
  mcp: ExecutorMcp;
}): Promise<ExecutionOutcome> => {
  let client: Awaited<ReturnType<typeof connectUpstream>> | undefined;
  try {
    client = await connectUpstream(
      { token: args.mcp.apiKey, url: args.mcp.url },
      { fetch: args.fetchImpl }
    );
    const result = await client.callTool(
      { arguments: { code: args.code }, name: "execute" },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    );
    return Option.match(decodeToolResult(result), {
      onNone: () => ({ kind: "failed", message: UNREADABLE_ANSWER }) as const,
      onSome: outcomeOf,
    });
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  } finally {
    await client?.close();
  }
};
