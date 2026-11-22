import { createHash } from "node:crypto";

import type { RunRegistry } from "@workspace/agent";
import {
  apiInputPrompt,
  apiRunPrompt,
  canStartRun,
  SKIP_OUTPUT,
  stopAgent,
} from "@workspace/agent";
import type { AgentEvent, RunAccess, RunKey } from "@workspace/agent/types";
import { RUN_RESULT_MAX_CHARS } from "@workspace/api";
import {
  AccountActionsRepo,
  ApiKeyService,
  ApiRunsRepo,
  TIERS,
} from "@workspace/db";
import type {
  ApiRunDelivery,
  ApiRunEnding,
  ApiRunEntry,
  ApiRunProfile,
  Tier,
} from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schedule,
} from "effect";

import { runAccessFor, taskStampFor } from "../access/run-access";
import {
  ensureApiRunScratchDir,
  ensureScratchDir,
  removeApiRunScratchDir,
} from "../access/scratch";
import { bucketsOf, RUN_RATE } from "../api/limits";
import { logRejection } from "../handlers/helpers";
import { readLightChoice } from "../handlers/light-defaults";
import { taskRunFor } from "../handlers/model-route";
import { routeProvider } from "../handlers/route-provider";
import { t } from "../i18n";
import type { PendingWork } from "../pending-work";
import { loadPersona } from "../persona";
import { splitText } from "../telegram/format";
import { sendRichSafe } from "../telegram/send";
import { TelegramBot } from "../telegram/telegram-bot";
import { setApiRunStopper } from "./api-run-stops";
import { isRestarting } from "./continuation";
import { runHeadless, runnableProvider } from "./headless-run";
import type { RunEnding } from "./headless-run";

/**
 * Agent runs the HTTP API starts: the same bot as a private chat, without the
 * chat. A run gets what its key's holder gets in their private chat with the
 * bot (`runAccessFor` on the private surface), or what a guest gets there,
 * and always low priority, so API runs never take the slot kept for the
 * owner. It keeps no conversation: it never resumes the chat's session,
 * never writes one, and never parks on background work (a park would be
 * resumed into a chat that never asked). It runs on the headless core the
 * task scheduler fires through (`runHeadless`), in its own run slot
 * (`apiRunKey`), as pending work, so a shutdown drains it. `api_runs` keeps
 * every run and how it ended; the boot marks the ones a restart cut.
 */

/** Runs of one user that may work at once over the API. */
const MAX_LIVE_PER_USER = 2;

/** How long a caller is told to wait when no slot is free. */
const BUSY_RETRY_SEC = 30;

/** How long `cancel` waits for the run to stop before it answers, in seconds. */
const CANCEL_SETTLE_SEC = 5;

/**
 * How often running runs are checked against their key: a revoke or a
 * demotion made where `AgentRuns` cannot hear it (the apikeys CLI, the users
 * CLI or `/users`, a db edit) stops the key's runs within this.
 */
const GUARD_INTERVAL_SEC = 5;

/**
 * An API run's slot: the holder's private chat with a negative thread id
 * from the run's row, marked `api`. The mark makes it a slot of its own even
 * where a scheduled task delivered to that chat uses the same numbers
 * (`scheduledRunKey`), and a negative thread is no topic, so the run's file
 * line points at the holder's private chat itself.
 */
export const apiRunKey = (input: {
  runId: number;
  userId: number;
}): RunKey => ({
  chatId: input.userId,
  origin: "api",
  threadId: -input.runId,
  userId: input.userId,
});

/** What a caller asks for. */
export interface RunRequest {
  readonly deliver: ApiRunDelivery;
  readonly input: string | undefined;
  readonly profile: ApiRunProfile;
  readonly prompt: string;
}

/** Who asks: the key and the user it acts as, at their tier now. */
export interface RunRequester {
  readonly keyId: string;
  readonly keyName: string;
  readonly tier: Tier;
  readonly userId: number;
}

/**
 * Why a run was not started. `idempotency`: the idempotency key started a
 * run with another body. `busy`: no run slot is free. `perUser`: the user
 * has `MAX_LIVE_PER_USER` runs going. `budget`: the key started its
 * `RUN_RATE` of runs this hour.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class RunRefused extends Data.TaggedError("RunRefused")<{
  readonly reason: "budget" | "busy" | "idempotency" | "perUser";
  readonly retryAfterSec?: number;
}> {}

/**
 * Why a run was told to stop: `cancel` by `runs.cancel`, `access` because
 * its key was revoked or its holder lost the tier it started at.
 */
type StopCause = "access" | "cancel";

/** A run in this process: what a cancel, a waiter and the guard need. */
interface LiveRun {
  /** A stop came; the run stops once registered, or never starts. */
  cancelRequested: StopCause | undefined;
  readonly keyId: string;
  /** Settles once the run's ending is stored. */
  readonly settled: Promise<void>;
  readonly slot: RunKey;
  /** The run is registered, where a stop reaches it. */
  started: boolean;
  /** The holder's tier when the run was admitted. */
  readonly tier: Tier;
  readonly userId: number;
}

/** Whether `now` is a lower tier than `was` (`TIERS` runs highest first). */
const isLowerTier = (now: Tier, was: Tier) =>
  TIERS.indexOf(now) > TIERS.indexOf(was);

/**
 * Tell a run to stop for `cause`: at once when it is registered, else
 * before it starts. A run already told keeps its first cause.
 */
const stopRun = (run: LiveRun, cause: StopCause) =>
  Effect.suspend(() => {
    if (run.cancelRequested !== undefined) {
      return Effect.void;
    }
    run.cancelRequested = cause;
    return run.started
      ? Effect.asVoid(stopAgent(run.slot, "stopped"))
      : Effect.void;
  });

/** The hash a retried request must match: everything that shapes the run. */
const requestHashOf = (request: RunRequest) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        request.prompt,
        request.input ?? null,
        request.profile,
        request.deliver,
      ])
    )
    .digest("hex");

/** The answer as it is kept: cut where the contract says (`RUN_RESULT_MAX_CHARS`). */
const keptResult = (text: string) =>
  text.length > RUN_RESULT_MAX_CHARS
    ? { text: text.slice(0, RUN_RESULT_MAX_CHARS), truncated: true }
    : { text, truncated: false };

/** What a run is told: the API frame, the prompt, and the fenced input. */
const promptOf = (request: RunRequest, keyName: string) =>
  [
    apiRunPrompt({ deliver: request.deliver, keyName }),
    request.prompt,
    ...(request.input === undefined || request.input.length === 0
      ? []
      : [apiInputPrompt(request.input)]),
  ].join("\n\n");

/** Whether the answer goes to the holder's chat too. */
const delivers = (deliver: ApiRunDelivery, text: string) => {
  if (text.trim().length === 0 || deliver === "never") {
    return false;
  }
  return deliver === "always" || text.trim() !== SKIP_OUTPUT;
};

/**
 * The access a run gets: the holder's private-chat decision (or a guest's
 * for `guest`), low priority, no session kept, and scratch where the
 * decision says so. Never more than that decision.
 */
const accessOf = (request: RunRequest, tier: Tier) => {
  const asTier: Tier = request.profile === "guest" ? "guest" : tier;
  const decision = runAccessFor({ surface: "private", tier: asTier });
  const access: RunAccess = {
    ...decision.agent,
    persistSession: false,
    priority: "low",
  };
  return { access, asTier, scratch: decision.scratch };
};

/** How a run that left no answer ended, from its fold's ending and a cancel. */
const endingOf = (input: {
  cancelled: StopCause | undefined;
  end: RunEnding["value"];
  message: string;
}): Pick<ApiRunEnding, "error" | "status"> => {
  const { end } = input;
  if (
    input.cancelled !== undefined &&
    (end === "stopped" || end === undefined)
  ) {
    return {
      error:
        input.cancelled === "cancel"
          ? "Cancelled with runs.cancel."
          : "Stopped: the API key was revoked or its holder lost access.",
      status: "cancelled",
    };
  }
  if (end === "cut" || (end === "stopped" && isRestarting())) {
    return {
      error: "The bot restarted while the run was working.",
      status: "interrupted",
    };
  }
  if (end === "busy") {
    return {
      error: "No run slot was free when the run started. Try again later.",
      status: "failed",
    };
  }
  return { error: input.message, status: "failed" };
};

/** Why a run failed, as `api_runs` keeps it. */
const failureText = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The run failed.";

/** What a run reports about itself as it goes. */
interface RunFacts {
  costUsd?: number;
  model?: string;
  provider?: string;
}

/** Where a delivered answer landed: its first message. */
interface Delivered {
  readonly chatId: number;
  readonly messageId: number;
}

const make = (deps: {
  readonly pendingWork: PendingWork["Service"];
  readonly projectsDir: string;
}) =>
  Effect.gen(function* makeAgentRuns() {
    const runs = yield* ApiRunsRepo;
    const actions = yield* AccountActionsRepo;
    const keys = yield* ApiKeyService;
    const { allowedUserId: ownerId } = yield* AppConfig;
    const bot = yield* TelegramBot;
    // The bot's own context (logger, tracer, registry): every run is a
    // fiber of its own, outside the request that started it.
    const context = yield* Effect.context<RunRegistry>();
    const live = new Map<number, LiveRun>();
    /** Each key's hourly run budget, spent only by a run that starts. */
    const budgets = bucketsOf(RUN_RATE);
    /** Runs of each user between their admission and their start. */
    const admitting = new Map<number, number>();

    const liveOf = (userId: number) =>
      [...live.values()].filter((run) => run.userId === userId).length +
      (admitting.get(userId) ?? 0);

    /** Stop every running run `match` picks. */
    const stopWhere = (match: (run: LiveRun) => boolean, cause: StopCause) =>
      Effect.forEach(
        [...live.values()].filter(match),
        (run) => stopRun(run, cause),
        { discard: true }
      );

    /** Hold one of the user's places while `self` admits a run. */
    const holdingPlace =
      (userId: number) =>
      <A, E, R>(self: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            admitting.set(userId, (admitting.get(userId) ?? 0) + 1);
          }),
          () => self,
          () =>
            Effect.sync(() => {
              const left = (admitting.get(userId) ?? 1) - 1;
              if (left > 0) {
                admitting.set(userId, left);
              } else {
                admitting.delete(userId);
              }
            })
        );

    /**
     * Send the answer to the holder's private chat, under a line naming the
     * key: the first message's place, or none when Telegram refused.
     */
    const deliver = (input: {
      keyName: string;
      text: string;
      userId: number;
    }) =>
      Effect.gen(function* () {
        const route = { chatId: input.userId, threadId: null };
        const chunks = splitText(
          `${t().apiRuns.delivered(input.keyName)}\n\n${input.text}`
        );
        let first = Option.none<Delivered>();
        for (const chunk of chunks) {
          const sent = yield* sendRichSafe({
            input: { markdown: chunk },
            route,
          });
          if (Option.isNone(first)) {
            first = Option.some({
              chatId: sent.chat.id,
              messageId: sent.message_id,
            });
          }
        }
        return first;
      }).pipe(
        Effect.provideService(TelegramBot, bot),
        Effect.catchTag("TelegramBotError", (error) =>
          Effect.logWarning("api run answer not delivered", error).pipe(
            Effect.as(Option.none<Delivered>())
          )
        )
      );

    /** The run itself, from setup to its stored ending. */
    const execute = (input: {
      readonly request: RunRequest;
      readonly requester: RunRequester;
      readonly row: ApiRunEntry;
      readonly run: LiveRun;
    }) =>
      Effect.gen(function* () {
        const { request, requester, row, run } = input;
        const { userId } = requester;
        const { access, asTier, scratch } = accessOf(request, requester.tier);
        const ran: RunFacts = {};
        const ends: RunEnding = {};
        // A guest-profile run gets an empty directory of its own: the
        // holder's scratch holds their uploads and other runs' files.
        const ownScratch = scratch !== false && request.profile === "guest";
        const outcome = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () => {
            // The provider the holder's private chat would answer on now (the
            // light one for a guest), moved to one that can run.
            const route = await routeProvider({
              access: { surface: "private", tier: asTier },
              readOnly: true,
              state: { chatId: userId, threadId: null, userId },
            });
            const provider = runnableProvider(route.provider);
            ran.provider = provider;
            const prompt = promptOf(request, requester.keyName);
            // A main run is routed as a new conversation of the holder's,
            // from their /settings defaults; a light one takes the owner's
            // light choice.
            const routed =
              access.modelClass === "main"
                ? await taskRunFor({
                    cached: {},
                    choice: {},
                    keep: true,
                    request: {
                      input: { kind: "text", message: request.prompt },
                      provider,
                      userId,
                    },
                  })
                : undefined;
            const picked = routed?.pick;
            const lightChoice =
              access.modelClass === "light"
                ? await readLightChoice()
                : undefined;
            const persona = await loadPersona();
            const stamp = taskStampFor({ tier: asTier, userId });
            if (run.cancelRequested !== undefined) {
              return { cancelledEarly: true, text: "" } as const;
            }
            let projectDir = deps.projectsDir;
            if (ownScratch) {
              projectDir = ensureApiRunScratchDir(row.id);
            } else if (scratch !== false) {
              projectDir = ensureScratchDir(userId);
            }
            const text = await runHeadless({
              ends,
              onModel: (model) => {
                ran.model = model;
              },
              options: {
                ...run.slot,
                access,
                effort: picked?.effort,
                lightChoice,
                model: picked?.model,
                persona,
                projectDir,
                prompt,
                taskAuthor:
                  stamp === undefined
                    ? undefined
                    : { ...stamp, apiRunId: row.id },
                // A park would be resumed into a chat after a restart; an API
                // run ends at its answer instead.
                waitForBackground: false,
              },
              parent: undefined,
              provider,
              registered: Effect.suspend(() => {
                run.started = true;
                return run.cancelRequested === undefined
                  ? Effect.void
                  : Effect.asVoid(stopAgent(run.slot, "stopped"));
              }),
              span: {
                attributes: { "api.key": requester.keyId, "api.run": row.id },
                name: "Api.run",
              },
              tap: (event: AgentEvent) =>
                Effect.sync(() => {
                  if (event.kind === "result" && event.cost !== undefined) {
                    ran.costUsd = (ran.costUsd ?? 0) + event.cost;
                  }
                }),
            });
            return { cancelledEarly: false, text } as const;
          },
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (ownScratch) {
                removeApiRunScratchDir(row.id);
              }
            }).pipe(Effect.catchDefect(() => Effect.void))
          ),
          Effect.result
        );

        const common = {
          costUsd: ran.costUsd,
          model: ran.model,
          provider: ran.provider,
        };
        let ending: ApiRunEnding;
        if (Result.isSuccess(outcome) && !outcome.success.cancelledEarly) {
          const { text } = outcome.success;
          const notified = delivers(request.deliver, text)
            ? yield* deliver({ keyName: requester.keyName, text, userId })
            : Option.none<Delivered>();
          ending = {
            ...common,
            notified: Option.getOrUndefined(notified),
            result: keptResult(text),
            status: "succeeded",
          };
        } else {
          ending = {
            ...common,
            ...endingOf({
              cancelled: run.cancelRequested,
              end: ends.value,
              message: Result.isFailure(outcome)
                ? failureText(outcome.failure)
                : "Cancelled before it started.",
            }),
          };
        }
        yield* runs
          .finish(row.id, ending)
          .pipe(
            Effect.catch((error) =>
              Effect.logError("api run ending not stored", error)
            )
          );
        yield* Effect.log("api run ended").pipe(
          Effect.annotateLogs({ runId: row.id, status: ending.status })
        );
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.logError("api run crashed", defect).pipe(
            Effect.andThen(
              runs
                .finish(input.row.id, {
                  error: "The run failed inside the bot.",
                  status: "failed",
                })
                .pipe(Effect.ignore)
            )
          )
        )
      );

    /**
     * Start a run, or answer the one an `idempotencyKey` already started
     * with the same request (`replayed`). Refused when the key started
     * another request, the user has too many runs going, no slot is free,
     * or the key used its hourly budget: then nothing is stored or spent.
     * Only a run that starts spends the key's budget.
     */
    const submit = Effect.fn("AgentRuns.submit")(function* (input: {
      readonly idempotencyKey: string | undefined;
      readonly request: RunRequest;
      readonly requester: RunRequester;
    }) {
      const { idempotencyKey, request, requester } = input;
      const requestHash = requestHashOf(request);
      const replay = (found: ApiRunEntry) =>
        found.requestHash === requestHash
          ? Effect.succeed({ replayed: true, run: found } as const)
          : Effect.fail(new RunRefused({ reason: "idempotency" }));
      if (idempotencyKey !== undefined) {
        const found = yield* runs.byIdempotencyKey({
          idempotencyKey,
          keyId: requester.keyId,
        });
        if (Option.isSome(found)) {
          return yield* replay(found.value);
        }
      }
      return yield* Effect.gen(function* () {
        // This request holds a place itself, so more than the cap is too many.
        if (liveOf(requester.userId) > MAX_LIVE_PER_USER) {
          return yield* new RunRefused({
            reason: "perUser",
            retryAfterSec: BUSY_RETRY_SEC,
          });
        }
        // Asked before anything is stored or spent: there is no queue, so a
        // run that finds no slot is answered "busy" now.
        if (!(yield* canStartRun("low"))) {
          return yield* new RunRefused({
            reason: "busy",
            retryAfterSec: BUSY_RETRY_SEC,
          });
        }
        // Last, so a refusal above or a replay never spends the budget.
        const waitSec = budgets.take(
          requester.keyId,
          yield* Clock.currentTimeMillis
        );
        if (waitSec !== undefined) {
          return yield* new RunRefused({
            reason: "budget",
            retryAfterSec: waitSec,
          });
        }
        const created = yield* runs
          .create({
            deliver: request.deliver,
            idempotencyKey,
            keyId: requester.keyId,
            profile: request.profile,
            requestHash,
            userId: requester.userId,
          })
          .pipe(Effect.result);
        if (Result.isFailure(created)) {
          // Two requests with one idempotency key at once: the other stored
          // its run first, and this one answers it.
          if (
            created.failure.reason === "UniqueViolation" &&
            idempotencyKey !== undefined
          ) {
            const found = yield* runs.byIdempotencyKey({
              idempotencyKey,
              keyId: requester.keyId,
            });
            if (Option.isSome(found)) {
              return yield* replay(found.value);
            }
          }
          return yield* created.failure;
        }
        const row = created.success;
        const settled = Promise.withResolvers<undefined>();
        const run: LiveRun = {
          cancelRequested: undefined,
          keyId: requester.keyId,
          settled: settled.promise,
          slot: apiRunKey({ runId: row.id, userId: requester.userId }),
          started: false,
          tier: requester.tier,
          userId: requester.userId,
        };
        live.set(row.id, run);
        const work = execute({ request, requester, row, run }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              live.delete(row.id);
              settled.resolve();
            })
          )
        );
        // Pending work, so a shutdown waits for the run instead of cutting it.
        yield* Effect.sync(() => {
          deps.pendingWork
            .track(Effect.runPromiseWith(context)(work))
            .catch(logRejection(`api run ${row.id} crashed`));
        });
        return { replayed: false, run: row } as const;
      }).pipe(holdingPlace(requester.userId));
    });

    /** A run `viewer` may see: their own, or any for the owner. */
    const visible = Effect.fn("AgentRuns.visible")(function* (input: {
      readonly id: number;
      readonly viewer: { readonly tier: Tier; readonly userId: number };
    }) {
      const found = yield* runs.get(input.id);
      return Option.filter(
        found,
        (run) =>
          run.userId === input.viewer.userId || input.viewer.tier === "owner"
      );
    });

    /** Wait up to `waitFor` for a run of this process to end. */
    const settle = (id: number, waitFor: Duration.Duration) => {
      const run = live.get(id);
      return run === undefined || Duration.isZero(waitFor)
        ? Effect.void
        : Effect.promise(async () => {
            await run.settled;
          }).pipe(Effect.timeoutOption(waitFor), Effect.asVoid);
    };

    /**
     * A run as it stands, after waiting up to `waitSec` for a running one to
     * end. None when there is no such run the viewer may see.
     */
    const get = Effect.fn("AgentRuns.get")(function* (input: {
      readonly id: number;
      readonly viewer: { readonly tier: Tier; readonly userId: number };
      readonly waitSec: number;
    }) {
      const found = yield* visible(input);
      if (Option.isNone(found) || found.value.status !== "running") {
        return found;
      }
      yield* settle(input.id, Duration.seconds(input.waitSec));
      return yield* runs.get(input.id);
    });

    /**
     * Stop a running run the viewer may see, and answer it as it stands a
     * few seconds later. A run that already ended is answered as it is.
     */
    const cancel = Effect.fn("AgentRuns.cancel")(function* (input: {
      readonly id: number;
      readonly viewer: { readonly tier: Tier; readonly userId: number };
    }) {
      const found = yield* visible(input);
      if (Option.isNone(found) || found.value.status !== "running") {
        return found;
      }
      const run = live.get(input.id);
      if (run !== undefined) {
        yield* stopRun(run, "cancel");
        yield* settle(input.id, Duration.seconds(CANCEL_SETTLE_SEC));
      }
      return yield* runs.get(input.id);
    });

    /** Stop every running run of a key, as its revoke does. */
    const stopKey = (keyId: string) =>
      stopWhere((run) => run.keyId === keyId, "access");

    /**
     * One guard pass: each running run's key is read again, and the runs
     * of a key that was revoked, moved to someone else, or whose holder
     * dropped below the tier the run started at, are stopped.
     */
    const guardPass = Effect.gen(function* () {
      const keyIds = new Set([...live.values()].map((run) => run.keyId));
      for (const keyId of keyIds) {
        const holder = yield* keys.standing({ keyId, ownerId });
        yield* stopWhere(
          (run) =>
            run.keyId === keyId &&
            (Option.isNone(holder) ||
              holder.value.key.userId !== run.userId ||
              isLowerTier(holder.value.tier, run.tier)),
          "access"
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("api run access check failed", error)
      )
    );
    yield* guardPass.pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(GUARD_INTERVAL_SEC))),
      Effect.forkScoped
    );
    // The `/apikeys` command revokes in this process too: it stops at once.
    const release = setApiRunStopper(async (keyId) => {
      await Effect.runPromiseWith(context)(stopKey(keyId));
    });
    yield* Effect.addFinalizer(() => Effect.sync(release));

    /** The writes a run asked for that still wait for the owner. */
    const pendingActionsOf = (id: number) =>
      actions
        .pendingOfApiRun(id)
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({ id: row.id, kind: row.payload.kind }))
          )
        );

    return {
      cancel,
      get,
      pendingActionsOf,
      stopKey,
      submit,
    } as const;
  });

/**
 * The HTTP API's agent runs. Built where the API is, in the entrypoint's
 * scope, over the bot's one `PendingWork`.
 */
export class AgentRuns extends Context.Service<
  AgentRuns,
  Effect.Success<ReturnType<typeof make>>
>()("@workspace/telegram/AgentRuns") {
  static readonly layer = (deps: Parameters<typeof make>[0]) =>
    Layer.effect(AgentRuns, make(deps));
}

/**
 * At boot, before the API takes a request: a run still `running` in
 * `api_runs` belonged to the process before, so it is `interrupted`.
 */
export const interruptCutApiRuns = ApiRunsRepo.use((repo) =>
  repo.interruptRunning()
).pipe(
  Effect.tap((count) =>
    count > 0
      ? Effect.log(`Marked ${count} API run(s) the restart cut as interrupted`)
      : Effect.void
  ),
  Effect.catch((error) =>
    Effect.logWarning("API runs the restart cut not marked", error)
  )
);
