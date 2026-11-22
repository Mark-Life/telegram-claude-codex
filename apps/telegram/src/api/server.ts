import { BunHttpServer } from "@effect/platform-bun";
import {
  InputErrors,
  InvalidInput,
  PayloadTooLarge,
  REQUEST_BODY_MAX_BYTES,
  servedAt,
} from "@workspace/api";
import { AppConfig } from "@workspace/env/bot";
import { Cause, Effect, Layer, Option, Schema } from "effect";
import {
  HttpApiBuilder,
  HttpApiMiddleware,
  HttpApiScalar,
} from "effect/http-api";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { logUnlessTelegram } from "../handlers/helpers";
import { t } from "../i18n";
import type { PendingWork } from "../pending-work";
import { AgentRuns, interruptCutApiRuns } from "../runs/agent-runs";
import type { TaskSchedulerHandle } from "../tasks";
import { sendTo } from "../telegram/bridge";
import { ApiAuthLive, isRequestPart, operationOf } from "./auth";
import { HealthLive, KeysLive, MeLive } from "./handlers";
import { NotifyLive } from "./notify";
import { RemindersLive } from "./reminders";
import { RunsLive } from "./runs";
import { SettingsLive } from "./settings";
import { tasksLive } from "./tasks";

/** The address the API binds: loopback only, a reverse proxy faces out. */
const API_HOST = "127.0.0.1";

/**
 * Seconds a connection may sit idle. Above the longest long-poll the API will
 * hold, so a waiting request is never cut by Bun's 10 s default.
 */
const IDLE_TIMEOUT_SEC = 30;

/**
 * Bun's own hard cap on a body, twice the contract's. A body that says it is
 * over `REQUEST_BODY_MAX_BYTES` gets a typed 413 from `BodyCapLive` before
 * any of it is read; Bun's cap (a bare 413, its default is 128 MB) only
 * stops a body that does not say its length and keeps going.
 */
const HARD_CAP_FACTOR = 2;
const HARD_BODY_CAP_BYTES = REQUEST_BODY_MAX_BYTES * HARD_CAP_FACTOR;

const PAYLOAD_TOO_LARGE = 413;

const encodePayloadTooLarge = Schema.encodeSync(PayloadTooLarge);

/**
 * A request whose `Content-Length` is over the contract's cap: 413
 * `PayloadTooLarge`, its body exactly what the contract declares. Bun
 * answers a body over its own cap with an empty 413 before any route runs,
 * so the typed answer needs Bun's cap above this one.
 */
const BodyCapLive = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const length = Number(request.headers["content-length"] ?? 0);
      if (length <= REQUEST_BODY_MAX_BYTES) {
        return yield* httpEffect;
      }
      return HttpServerResponse.jsonUnsafe(
        encodePayloadTooLarge(
          new PayloadTooLarge({
            message: `The body is ${length} bytes; the API reads at most ${REQUEST_BODY_MAX_BYTES}.`,
          })
        ),
        { status: PAYLOAD_TOO_LARGE }
      );
    }),
  { global: true }
);

/**
 * How long a shutdown waits for open requests before the drain goes on.
 * Well under systemd's stop timeout, which also covers the run drain.
 */
const GRACEFUL_SHUTDOWN = "5 seconds";

/**
 * A request that fails its schema: 422 with what was wrong. A response that
 * fails its own schema is the server's bug, never the caller's: logged, and
 * a 500, since what the handler did may already be done.
 */
export const InputErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(
  InputErrors,
  (error, { endpoint, group }) =>
    isRequestPart(error.kind)
      ? Effect.fail(
          new InvalidInput({
            message: `${error.kind}: ${error.cause.message}`,
          })
        )
      : Effect.logError("api response does not match its schema").pipe(
          Effect.annotateLogs({
            cause: error.cause.message,
            kind: error.kind,
            op: operationOf(endpoint, group),
          }),
          // A plain defect: the schema error itself would render as a 400.
          Effect.andThen(
            Effect.die(new Error(`${error.kind}: ${error.cause.message}`))
          )
        )
);

/**
 * The HTTP API inside the bot process: the contract from `@workspace/api`,
 * its handlers, the public `/openapi.json` and `/docs`, on 127.0.0.1. Built
 * in the caller's scope, so the repositories come from the bot's one runtime
 * (never a second db client) and closing the scope stops the server.
 */
const apiLayer = (input: {
  pendingWork: PendingWork["Service"];
  port: number;
  projectsDir: string;
  publicUrl: string;
  scheduler: TaskSchedulerHandle;
}) => {
  const api = servedAt(input.publicUrl);
  // One instance for both groups: a revoke over `keys` stops that key's runs.
  const agentRuns = AgentRuns.layer({
    pendingWork: input.pendingWork,
    projectsDir: input.projectsDir,
  });
  const routes = Layer.mergeAll(
    HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" }),
    HttpApiScalar.layer(api, { path: "/docs" }),
    BodyCapLive
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        HealthLive,
        MeLive,
        tasksLive(input.scheduler),
        RemindersLive,
        NotifyLive,
        SettingsLive,
        Layer.mergeAll(KeysLive, RunsLive).pipe(Layer.provide(agentRuns))
      )
    ),
    Layer.provide(Layer.mergeAll(ApiAuthLive, InputErrorsLive))
  );
  return HttpRouter.serve(routes).pipe(
    Layer.provide(
      BunHttpServer.layer({
        gracefulShutdownTimeout: GRACEFUL_SHUTDOWN,
        hostname: API_HOST,
        idleTimeout: IDLE_TIMEOUT_SEC,
        maxRequestBodySize: HARD_BODY_CAP_BYTES,
        port: input.port,
      })
    )
  );
};

/** What `Bun.serve` throws when something else holds the port. */
const PortBusy = Schema.Struct({ code: Schema.Literal("EADDRINUSE") });
const isPortBusyError = Schema.is(PortBusy);

const isPortBusy = (cause: Cause.Cause<unknown>) =>
  isPortBusyError(Cause.squash(cause));

/**
 * The server did not start (a busy `API_PORT` above all): the log says why
 * and the owner gets one line in their private chat, best-effort. The bot
 * goes on without the API rather than crash-looping with chat down too.
 */
const reportNotStarted = (input: {
  cause: Cause.Cause<unknown>;
  ownerId: number;
  port: number;
}) =>
  Effect.gen(function* () {
    const busy = isPortBusy(input.cause);
    yield* Effect.logError(
      busy
        ? `HTTP API not started: port ${input.port} unavailable`
        : "HTTP API not started",
      input.cause
    );
    const copy = t().apiServer;
    const text = busy ? copy.portBusy(input.port) : copy.notStarted;
    yield* Effect.sync(() => {
      sendTo({ chatId: input.ownerId, threadId: null }, text).catch(
        logUnlessTelegram("HTTP API notice not sent")
      );
    });
  });

/**
 * Start the API when `API_ENABLED` is on; nothing listens otherwise. The
 * server lives until the caller's scope closes. The entrypoint builds it
 * after registering the run drain, so at shutdown the server stops taking
 * requests before accepted work drains (finalizers run last-in, first-out):
 * an agent run the API started is pending work, so the drain waits for it.
 * A server that cannot start leaves the API off, never the bot.
 */
export const serveApi = Effect.fn("Api.serve")(function* (input: {
  readonly pendingWork: PendingWork["Service"];
  readonly projectsDir: string;
  readonly scheduler: TaskSchedulerHandle;
}) {
  // Whether or not the API is on now: a run the last process left running
  // is over either way, and `runs.get` must say so once it is on again.
  yield* interruptCutApiRuns;
  const { allowedUserId, api } = yield* AppConfig;
  if (Option.isNone(api)) {
    return;
  }
  const { port } = api.value;
  const publicUrl = Option.getOrElse(
    api.value.publicUrl,
    () => `http://${API_HOST}:${port}`
  );
  const started = yield* Layer.build(
    apiLayer({
      pendingWork: input.pendingWork,
      port,
      projectsDir: input.projectsDir,
      publicUrl,
      scheduler: input.scheduler,
    })
  ).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : reportNotStarted({ cause, ownerId: allowedUserId, port }).pipe(
            Effect.as(false)
          )
    )
  );
  if (!started) {
    return;
  }
  yield* Effect.log(`HTTP API on ${API_HOST}:${port}, public at ${publicUrl}`);
});
