import { hostname } from "node:os";

import { Effect } from "effect";

import { APP_VERSION } from "../handlers/run-event";
import { ApiEvent, Observability } from "../observability";

/** The fields of an API ledger line the caller decides. */
export type ApiEventInput = Omit<
  ConstructorParameters<typeof ApiEvent>[0],
  "event" | "host" | "ts" | "version"
>;

/**
 * Append one API key or request event to `.data/events.jsonl`. Best-effort,
 * like every ledger line: `recordApi` swallows its own failures.
 */
export const recordApiEvent = Effect.fn("Api.recordEvent")(function* (
  input: ApiEventInput
) {
  const observability = yield* Observability;
  yield* observability.recordApi(
    new ApiEvent({
      ...input,
      event: "telegram.api",
      host: hostname(),
      ts: new Date().toISOString(),
      version: APP_VERSION,
    })
  );
});
