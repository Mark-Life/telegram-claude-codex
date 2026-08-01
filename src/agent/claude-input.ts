import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunOptions } from "./types";

/**
 * The query input as an AsyncIterable rather than a string. This is the crux of
 * background-task support: a string prompt puts the CLI in single-turn mode,
 * which force-closes stdin on the first `result` — ending the session before a
 * background task (dynamic workflow, backgrounded subagent) can report back. An
 * async iterable keeps the session live; the CLI re-drives the agent when the
 * task settles. The stream yields the user turn, then stays open until `closed`
 * resolves (a turn ended with no background tasks left, or the run was aborted).
 */
export async function* userTurns(
  opts: RunOptions,
  closed: Promise<void>
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: opts.prompt },
  };
  await closed;
}
