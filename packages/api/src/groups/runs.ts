import { Schema, SchemaTransformation } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

import {
  Conflict,
  Forbidden,
  NotFound,
  RateLimited,
  Unavailable,
} from "../errors";
import { ApiAuth } from "../middleware";
import { IsoTime, pathId } from "./shared";

/**
 * Agent runs: a prompt the bot runs as the key's user, as if they wrote it to
 * the bot in a private chat, with the answer read back here.
 */

/** The longest prompt a run takes. */
export const RUN_PROMPT_MAX_CHARS = 32_000;

/** The longest input a run takes beside its prompt. */
export const RUN_INPUT_MAX_CHARS = 128_000;

/** The most bytes one UTF-16 unit takes in JSON: a `\\uXXXX` escape. */
const JSON_BYTES_PER_UNIT = 6;

/** Room for the body's keys, `profile`, `deliver` and the punctuation. */
const BODY_OVERHEAD_BYTES = 4096;

/**
 * The largest request body the API reads, in bytes: a `runs.create` at both
 * maximums even when every character is sent `\\uXXXX`-escaped (as Python's
 * `json.dumps` does by default), so any body the schemas allow fits.
 */
export const REQUEST_BODY_MAX_BYTES =
  (RUN_PROMPT_MAX_CHARS + RUN_INPUT_MAX_CHARS) * JSON_BYTES_PER_UNIT +
  BODY_OVERHEAD_BYTES;

/** The longest answer a run keeps; a longer one is cut there. */
export const RUN_RESULT_MAX_CHARS = 8000;

/** The longest a `runs.get` waits for the run to end. */
export const RUN_WAIT_MAX_SEC = 20;

/** The longest `Idempotency-Key` taken. */
const IDEMPOTENCY_KEY_MAX = 200;

export const RunStatus = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]).annotate({
  description:
    "`running` until it ends. `succeeded`: it answered (`result`). `failed`: it ended without an answer (`error` says why). `cancelled`: `runs.cancel` stopped it. `interrupted`: the bot restarted while it worked; start it again.",
});

export const RunProfile = Schema.Literals(["full", "guest"]).annotate({
  description:
    "`full` (the default): everything you get in your private chat with the bot, the machine, your tools and connected services, the owner's Telegram account included where you have it. `guest`: what a stranger gets in a private chat: read-only, web search, no shell writes, no secrets, no connected services, no Telegram account, the light model. Use `guest` for untrusted input such as emails or webhooks.",
});

export const RunDelivery = Schema.Literals([
  "never",
  "always",
  "agent",
]).annotate({
  description:
    "Whether the bot also sends the answer to your private chat with it. `never` (the default): only this API gets it. `always`: it is sent too. `agent`: the run decides; it is sent unless the answer is exactly `__TASK_SKIP__`.",
});

export const RunCreate = Schema.Struct({
  deliver: Schema.optionalKey(RunDelivery),
  input: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(RUN_INPUT_MAX_CHARS)).annotate({
      description:
        "Data the run works on (an email, a webhook body), attached after the prompt and marked as data. Marking it is no defence against what it says: run untrusted input with `profile: guest`. Up to 128000 characters.",
    })
  ),
  profile: Schema.optionalKey(RunProfile),
  prompt: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(RUN_PROMPT_MAX_CHARS)
  ).annotate({
    description:
      "What the bot should do, as you would write it to the bot. Up to 32000 characters.",
  }),
}).annotate({ identifier: "RunCreate" });

export const RunCreateHeaders = Schema.Struct({
  "idempotency-key": Schema.optionalKey(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(IDEMPOTENCY_KEY_MAX)
    ).annotate({
      description:
        "Any string unique to this request, up to 200 characters. A retry with the same key and the same body answers the run the first request started instead of starting another; the same key with another body is `Conflict`. Kept per API key, for good.",
    })
  ),
});

const PendingAccountAction = Schema.Struct({
  id: Schema.Int.annotate({ description: "The write's id." }),
  kind: Schema.String.annotate({
    description: "What it would do, such as `send` or `forward`.",
  }),
}).annotate({ identifier: "PendingAccountAction" });

export const RunResult = Schema.Struct({
  costUsd: Schema.optionalKey(
    Schema.Finite.annotate({
      description:
        "What the run cost in USD, when its provider reports it; none of today's providers do, so it is absent for now.",
    })
  ),
  notified: Schema.optionalKey(
    Schema.Struct({
      chatId: Schema.Int.annotate({ description: "The chat it landed in." }),
      messageId: Schema.Int.annotate({
        description: "Its first message there.",
      }),
    }).annotate({
      description:
        "Where the bot sent the answer; absent when it sent nothing (`deliver` `never`, `agent` that answered `__TASK_SKIP__`, or a failed send).",
    })
  ),
  text: Schema.String.annotate({
    description: "The run's final answer, up to 8000 characters.",
  }),
  truncated: Schema.Boolean.annotate({
    description: "The answer was longer and is cut at 8000 characters.",
  }),
}).annotate({ identifier: "RunResult" });

export const RunSchema = Schema.Struct({
  createdAt: IsoTime,
  deliver: RunDelivery,
  error: Schema.optionalKey(
    Schema.String.annotate({
      description: "Why a run that did not succeed ended, in English.",
    })
  ),
  finishedAt: Schema.optionalKey(IsoTime),
  model: Schema.optionalKey(
    Schema.String.annotate({ description: "The model it ran on." })
  ),
  pendingAccountActions: Schema.optionalKey(
    Schema.Array(PendingAccountAction).annotate({
      description:
        "Writes the run asked to make on the owner's Telegram account that still wait for the owner's button in Telegram, whatever the run's status: a write a cancelled or failed run asked for can still be approved. An API run's writes always wait for it. Absent when none waits.",
    })
  ),
  profile: RunProfile,
  provider: Schema.optionalKey(
    Schema.String.annotate({ description: "The provider it ran on." })
  ),
  result: Schema.optionalKey(RunResult),
  runId: Schema.Int.annotate({ description: "The run's id." }),
  status: RunStatus,
}).annotate({ identifier: "Run" });

export type Run = typeof RunSchema.Type;

export const RunAccepted = Schema.Struct({
  runId: Schema.Int.annotate({
    description: "The run's id, for `runs.get` and `runs.cancel`.",
  }),
  status: RunStatus,
}).annotate({ identifier: "RunAccepted" });

const RunIdParams = {
  runId: pathId("The run's id, as `runs.create` answered it."),
};

/**
 * `waitSec` as the query string carries it: the pattern, bounds and words sit
 * on this encoded side, the one the OpenAPI document publishes, and decode
 * to the whole number of seconds.
 */
const WaitSec = Schema.String.check(Schema.isPattern(/^(?:1?\d|20)$/u))
  .annotate({
    description:
      "Wait up to this many seconds (0-20, whole) for a running run to end before answering. 0, the default, answers at once.",
    examples: ["20"],
  })
  .pipe(
    Schema.decodeTo(
      Schema.Int.check(
        Schema.isBetween({ maximum: RUN_WAIT_MAX_SEC, minimum: 0 })
      ),
      SchemaTransformation.numberFromString
    )
  );

export const RunWaitQuery = Schema.Struct({
  waitSec: Schema.optionalKey(WaitSec),
});

const ownRunNote =
  "Only runs started with a key of yours; the owner sees every run.";

export const RunsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.post("create", "/v1/runs", {
      error: [Conflict, Forbidden, RateLimited, Unavailable],
      headers: RunCreateHeaders,
      payload: RunCreate,
      success: RunAccepted.pipe(HttpApiSchema.status("Accepted")),
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Start an agent run.\n\nThe bot runs `prompt` as the key's user, as if they wrote it to the bot in a private chat, in the background, and answers at once with its id; read the answer with `runs.get` (it can wait up to 20 s per call). The run keeps no conversation: every run starts fresh and never continues your chat. `Unavailable` (with `Retry-After`) when every run slot is busy: nothing was started, try again later. `RateLimited` when two runs of yours are already going, or the key started too many runs this hour. Send an `Idempotency-Key` header to make a retry safe.",
        identifier: "runs.create",
        summary: "Start an agent run",
      })
    ),
    HttpApiEndpoint.get("get", "/v1/runs/:runId", {
      error: NotFound,
      params: RunIdParams,
      query: RunWaitQuery,
      success: RunSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Show an agent run.\n\nIts status and, once it succeeded, its answer. With \`waitSec\`, a running run is waited for up to that many seconds first, so a loop of \`runs.get?waitSec=20\` follows it without busy polling. ${ownRunNote}`,
        identifier: "runs.get",
        summary: "Show an agent run",
      })
    ),
    HttpApiEndpoint.post("cancel", "/v1/runs/:runId/cancel", {
      error: NotFound,
      params: RunIdParams,
      success: RunSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Cancel an agent run.\n\nStops a running run; what it already did stays done. Answers the run as it stands after a few seconds, \`cancelled\` once it stopped. A run that already ended is answered as it is. ${ownRunNote}`,
        identifier: "runs.cancel",
        summary: "Cancel an agent run",
      })
    )
  )
  .middleware(ApiAuth)
  .annotateMerge(
    OpenApi.annotations({
      description:
        "Agent runs: the bot does what you ask, with your powers, and you read the answer back. Runs take the bot's lower-priority slots, so they never take the one kept for the owner.",
      title: "runs",
    })
  );
