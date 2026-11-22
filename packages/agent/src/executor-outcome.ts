// What a model-free Executor replay reports, shared by both generations'
// transports (`executor-rest.ts` for v1, `executor-v2.ts` for v2).

/**
 * What one execution did. Every failure is data — a rejected fetch, a non-2xx
 * answer and an `isError` body all arrive as `failed` — so a caller never has
 * to catch anything. A paused run says how it is continued: v1's REST resume
 * of the execution id, or v2's MCP `resume` of the request id.
 */
export type ExecutionOutcome =
  | { kind: "failed"; message: string }
  | {
      kind: "ok";
      /** The longest code this Executor takes, when it has a limit (v2). */
      maxCodeChars?: number;
      structured?: unknown;
      text: string;
    }
  | {
      /** What Executor asks: the tool and its question (v2). */
      asks?: string;
      executionId?: string;
      /** The pause wants form input, not a yes or no (v2). */
      input?: boolean;
      kind: "paused";
      resume: "mcp" | "rest";
      text: string;
    };

/** A body neither transport can read. */
export const UNREADABLE_ANSWER = "Executor answered in an unknown shape.";

/** An error Executor flagged without saying what went wrong. */
export const REPORTED_ERROR = "Executor reported an error.";

export const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
