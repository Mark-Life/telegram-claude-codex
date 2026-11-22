// Model-free replay of stored code through cloud Executor (executor.sh), and
// the dispatch `EXECUTOR_VERSION` picks (`readExecutorTarget`,
// `runExecutorScript`).
//
// v1 (this file): the MCP endpoint is what an agent run talks to; this is the
// REST door the scheduler uses instead, so a saved script costs no tokens:
// POST /api/executions with the code and `autoApprove`, and read the finished
// result back. Both the base url and the key come from the Executor config the
// bot already has — the base is derived from the MCP url's origin, so there is
// no second env var. v2 has no such door and replays through MCP `execute`
// (`executor-v2.ts`).

import { AppConfig } from "@workspace/env/bot";
import { Effect, Option, Redacted, Schema } from "effect";

import {
  messageOf,
  REPORTED_ERROR,
  UNREADABLE_ANSWER,
} from "./executor-outcome";
import type { ExecutionOutcome } from "./executor-outcome";
import { runExecutorMcpCode } from "./executor-v2";
import type { ExecutorMcp } from "./executor-v2";

/** Credentials one REST call needs. */
export interface ExecutorRest {
  apiKey: string;
  /** Origin plus `/api`, e.g. `https://executor.sh/api`. */
  base: string;
}

/**
 * The fetch surface a call uses. Narrower than the global so a test can hand in
 * a stub without standing up a server.
 */
export type FetchLike = (
  url: string,
  init: RequestInit
) => Promise<Pick<Response, "json" | "ok" | "status">>;

/** Where an Executor script is replayed, per generation. */
export type ExecutorTarget =
  | { mcp: ExecutorMcp; version: "v2" }
  | { rest: ExecutorRest; version: "v1" };

/** The body Executor answers an execution with; every field is optional. */
const ExecutionBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.String),
  structured: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.String),
});

const decodeBody = Schema.decodeUnknownOption(ExecutionBody);

/** Status Executor reports when an execution is waiting for a human approval. */
const PAUSED = "paused";

/**
 * Derive the REST base from the org-scoped MCP endpoint:
 * `https://executor.sh/org_x/mcp` → `https://executor.sh/api`. Undefined when
 * the configured url is not a url at all.
 */
export const executorApiBase = (mcpUrl: string) =>
  URL.canParse(mcpUrl) ? `${new URL(mcpUrl).origin}/api` : undefined;

/** Turn a decoded body into the outcome the caller acts on. */
const outcomeOf = (
  body: typeof ExecutionBody.Type,
  fallback: string
): ExecutionOutcome => {
  const text = body.text ?? "";
  if (body.isError === true) {
    return { kind: "failed", message: text.trim() || fallback };
  }
  if (body.status === PAUSED) {
    return { executionId: body.id, kind: PAUSED, resume: "rest", text };
  }
  return { kind: "ok", structured: body.structured, text };
};

/**
 * Run stored code through Executor and report what happened.
 *
 * `autoApprove` is on: the owner authored the code, and Executor's own block
 * policies still apply on top. A run Executor pauses anyway comes back as
 * `paused` with the execution id, which is the only handle a human has to
 * resume it.
 */
export const runExecutorCode = async (args: {
  code: string;
  fetchImpl?: FetchLike;
  rest: ExecutorRest;
  signal?: AbortSignal;
}): Promise<ExecutionOutcome> => {
  const call = args.fetchImpl ?? fetch;
  try {
    const response = await call(`${args.rest.base}/executions`, {
      body: JSON.stringify({ autoApprove: true, code: args.code }),
      headers: {
        Authorization: `Bearer ${args.rest.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: args.signal,
    });
    if (!response.ok) {
      return {
        kind: "failed",
        message: `Executor answered HTTP ${response.status}.`,
      };
    }
    const body = decodeBody(await response.json());
    if (Option.isNone(body)) {
      return {
        kind: "failed",
        message: UNREADABLE_ANSWER,
      };
    }
    return outcomeOf(body.value, REPORTED_ERROR);
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }
};

/**
 * Read where scripts replay from AppConfig: v1's REST base, or v2's MCP url.
 * Undefined when Executor is not configured, which is what a script task is
 * told when it fires.
 */
export const readExecutorTarget = Effect.map(
  AppConfig,
  (cfg): ExecutorTarget | undefined => {
    const url = Option.getOrUndefined(cfg.executorMcpUrl);
    const apiKey = Option.getOrUndefined(
      Option.map(cfg.executorApiKey, Redacted.value)
    );
    if (url === undefined || apiKey === undefined) {
      return undefined;
    }
    if (cfg.executorVersion === "v2") {
      return URL.canParse(url)
        ? { mcp: { apiKey, url }, version: "v2" }
        : undefined;
    }
    const base = executorApiBase(url);
    return base === undefined
      ? undefined
      : { rest: { apiKey, base }, version: "v1" };
  }
);

/** Replay stored code on whichever Executor generation the target names. */
export const runExecutorScript = async (args: {
  code: string;
  target: ExecutorTarget;
}): Promise<ExecutionOutcome> =>
  args.target.version === "v2"
    ? await runExecutorMcpCode({
        code: args.code,
        mcp: args.target.mcp,
      })
    : await runExecutorCode({
        code: args.code,
        rest: args.target.rest,
      });
