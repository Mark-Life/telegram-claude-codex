import { BunRuntime } from "@effect/platform-bun";
import {
  getProvider,
  isInstalled,
  isRunnable,
  orderedSnapshots,
  pinLogSink,
} from "@workspace/agent";
import type { EffectiveProviders, ProviderId } from "@workspace/agent";
import { decodeProviderId } from "@workspace/agent/registry";
import { AppConfig } from "@workspace/env/bot";
import { runsSnapshotPath } from "@workspace/env/paths";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Runtime,
  Schedule,
} from "effect";
import type { Bot } from "grammy";

import type { BotContext } from "./access/context";
import { pruneGroupFiles } from "./access/scratch";
import { serveApi } from "./api/server";
import { startTokenMessageSweep } from "./api/token-messages";
import { loadLanguage } from "./bot-settings";
import { cleanupBusinessMessages, getSetting } from "./db/bridge";
import {
  backfillGroupRegistry,
  cleanupStaleState,
  registerHandlers,
  sendToNotifyRoute,
} from "./handlers";
import {
  effectiveProviders,
  refreshModelsInBackground,
} from "./handlers/agent-bridge";
import type { RunPipeline } from "./handlers/deps";
import { logRejection, logUnlessTelegram } from "./handlers/helpers";
import { t } from "./i18n";
import { PendingWork } from "./pending-work";
import { loadRunLimit } from "./run-limit";
import { resumeParkedRuns } from "./runs/continuation";
import { runtime } from "./runtime";
import { pinHostSandbox } from "./sandbox";
import { importPastSessions } from "./session-history";
import { SettingsLive } from "./settings/live";
import { drainOrStop, logShutdownStart } from "./shutdown";
import { installAccessPipeline } from "./telegram/access-pipeline";
import { warnBotFatherSettings } from "./telegram/botfather-check";
import { syncAllCommands } from "./telegram/commands";
import { TelegramBot } from "./telegram/telegram-bot";
import { watchAgentTurns } from "./turn-watch";
import { pinWorkDir } from "./work-dir";

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const CLEANUP_INTERVAL_HOURS = 3;
const CLEANUP_INTERVAL_MS = CLEANUP_INTERVAL_HOURS * MS_PER_HOUR;
/** A live model list older than this is read again by the cleanup pass. */
const DAILY_MODEL_LIST_MAX_AGE_MS = HOURS_PER_DAY * MS_PER_HOUR;
const BUSINESS_RETENTION_DAYS = 365;
const BUSINESS_RETENTION_MS =
  BUSINESS_RETENTION_DAYS * HOURS_PER_DAY * MS_PER_HOUR;
/** How long a file sent in a group stays readable to the group's runs. */
const GROUP_FILES_RETENTION_DAYS = 7;
const GROUP_FILES_RETENTION_MS =
  GROUP_FILES_RETENTION_DAYS * HOURS_PER_DAY * MS_PER_HOUR;

/** Polling ended without a shutdown asking for it. */
class PollingStopped extends Data.TaggedError("PollingStopped")<{
  readonly cause?: unknown;
}> {
  // Logged through the app logger where it happens; runMain must not repeat it.
  override readonly [Runtime.errorReported] = false;
}

/** Main failed; already logged through the app logger before teardown. */
class MainFailed extends Data.TaggedError("MainFailed")<{
  readonly cause: Cause.Cause<unknown>;
}> {
  override readonly [Runtime.errorReported] = false;
}

/**
 * Log a failure of `main` while the app logger (and OTLP) still runs, before
 * its finalizers dispose the runtime. Interrupts pass through untouched: they
 * are a signal, and `teardown` makes them exit 0.
 */
const reportFailure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.catchCause(self, (cause): Effect.Effect<never, E | MainFailed> => {
    if (Cause.hasInterruptsOnly(cause)) {
      return Effect.failCause(cause);
    }
    const logged =
      Cause.squash(cause) instanceof PollingStopped
        ? Effect.void
        : Effect.logError("Bot process failed", cause);
    return Effect.andThen(logged, Effect.fail(new MainFailed({ cause })));
  });

/**
 * Drop stale chat state, Business messages and group files past their
 * retention.
 */
const cleanupPass = Effect.gen(function* () {
  // Not cleanup, but on the same slow clock: a day-old model list is read
  // again in the background.
  refreshModelsInBackground(DAILY_MODEL_LIST_MAX_AGE_MS);
  const stats = yield* Effect.try(cleanupStaleState);
  yield* Effect.log(`[cleanup] ${stats}`);
  const removed = yield* Effect.tryPromise(
    async () =>
      await cleanupBusinessMessages(Date.now() - BUSINESS_RETENTION_MS)
  );
  if (removed > 0) {
    yield* Effect.log(`Expired Business messages removed: ${removed}`);
  }
  const groupFiles = yield* Effect.try(() =>
    pruneGroupFiles(Date.now() - GROUP_FILES_RETENTION_MS)
  );
  if (groupFiles > 0) {
    yield* Effect.log(`Expired group files removed: ${groupFiles}`);
  }
}).pipe(
  Effect.catch((error) =>
    Effect.logError("Runtime data cleanup failed", error)
  ),
  Effect.withSpan("Cleanup.pass")
);

/**
 * What the owner reads at boot: the bot is back, plus the one thing they can
 * act on — a provider that is installed but cannot run, and where new
 * conversations go instead, or one whose check did not answer. The provider
 * the owner chose for their private chat (`owner`) never falls back: when it
 * cannot run, the notice says that chat waits for a login or a /provider
 * switch. With nothing runnable, /login is suggested only when an installed
 * provider can be connected from the chat.
 */
const announceText = (
  providers: EffectiveProviders,
  owner: ProviderId | undefined
) => {
  const copy = t().startup;
  const installed = orderedSnapshots(providers.snapshots).filter(isInstalled);
  // A check that timed out reads `unknown` and still runs.
  if (!installed.some(({ status }) => isRunnable(status))) {
    const canLogin = installed.some(
      ({ id }) => getProvider(id).deviceLogin !== undefined
    );
    return [
      copy.back,
      copy.noAccount,
      ...(canLogin ? [copy.sendLogin] : []),
    ].join(" ");
  }
  const target = getProvider(providers.default).displayName;
  const idle = installed
    .filter(({ id, status }) => !isRunnable(status) && id !== providers.default)
    .map(({ id, status }) => {
      // `unsupported` is a CLI that will not start here, not a missing login.
      const fault =
        status === "unsupported" ? copy.wontStart : copy.notConnected;
      const next = id === owner ? copy.ownerWaits : copy.goesTo(target);
      return `${getProvider(id).displayName} ${fault} — ${next}.`;
    });
  const unchecked = installed
    .filter(({ status }) => status === "unknown")
    .map(({ id }) => copy.unchecked(getProvider(id).displayName));
  return [copy.back, ...idle, ...unchecked].join("\n");
};

/** How many parked conversations the boot resumed, and how many it could not. */
const resumedText = (counts: { notResumed: number; resumed: number }) => {
  const copy = t().startup;
  return [
    ...(counts.resumed > 0 ? [copy.resumed(counts.resumed)] : []),
    ...(counts.notResumed > 0 ? [copy.notResumed(counts.notResumed)] : []),
  ];
};

/**
 * Tell the owner the bot is back, what of it cannot run, and which parked
 * conversations it picked up again.
 */
const announce = async (
  ownerId: number,
  counts: { notResumed: number; resumed: number }
) => {
  const owner = decodeProviderId(await getSetting("owner_provider"));
  const text = [
    announceText(effectiveProviders(), Option.getOrUndefined(owner)),
    ...resumedText(counts),
  ].join("\n");
  await sendToNotifyRoute({
    opts: { reply_markup: { remove_keyboard: true } },
    ownerId,
    text,
  });
};

/** One-shot boot work that must not hold up anything else. */
const kickStartupWork = (ownerId: number, pipeline: RunPipeline) => {
  backfillGroupRegistry().catch(
    logRejection("Failed to backfill group registry")
  );
  syncAllCommands(ownerId).catch(logRejection("Failed to set bot commands"));
  // Sessions from before `/history` read the db, once per provider.
  runtime.runFork(importPastSessions);
  // The profile itself is not synced here on purpose: setMyName is
  // rate-limited and this process restarts after every self-update. It is
  // changed on request through scripts/profile-cli.ts. What is checked is
  // only what no API can set — see the module for why.
  warnBotFatherSettings().catch(
    logUnlessTelegram("Failed to check BotFather settings")
  );
  // The owner's user id doubles as their private chat id; once the owner has
  // set a workspace, the notice goes to that chat and topic instead.
  // Conversations a restart cut while they waited on background work go on
  // first, so the notice can say how many did.
  resumeParkedRuns({ ownerId, pipeline })
    .then(async (counts) => {
      await announce(ownerId, counts);
    })
    .catch(logUnlessTelegram("Failed to send startup message"));
};

/** Fails once polling ends: with its error, or because it stopped at all. */
const pollingEnded = (polling: Promise<void>) =>
  Effect.tryPromise({
    catch: (cause) => new PollingStopped({ cause }),
    try: async () => {
      await polling;
    },
  }).pipe(
    Effect.andThen(Effect.fail(new PollingStopped({}))),
    Effect.tapError((error) =>
      error.cause === undefined
        ? Effect.logError("Bot polling stopped without a shutdown")
        : Effect.logError("Bot polling stopped", error.cause)
    )
  );

/**
 * Start long polling as a scoped resource. Its release stops fetching updates
 * and waits for the last batch: Telegram retains anything newer while the
 * accepted work finishes and systemd keeps this process in "stopping".
 */
const startPolling = (bot: Bot<BotContext>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const started = Promise.withResolvers<undefined>();
      const done = bot.start({
        onStart: () => {
          started.resolve();
        },
      });
      // Observed by `pollingEnded` and the release; never unhandled.
      void Promise.allSettled([done]);
      return { done, started: started.promise };
    }),
    ({ done }) =>
      Effect.promise(async () => {
        await bot.stop().catch(logRejection("Failed to stop polling"));
        // A failure before the shutdown was logged by `pollingEnded`.
        await Promise.allSettled([done]);
      })
  );

/**
 * The bot process. Finalizers run in reverse order of registration when the
 * program is interrupted (SIGTERM/SIGINT) or polling fails: the loops stop,
 * polling stops, accepted work and agent turns drain, what is left is
 * interrupted, the turn ledger closes, and last the runtime is disposed.
 */
const main = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => runtime.disposeEffect);

  // Fails fast on missing or invalid env. Secrets stay redacted.
  const cfg = yield* AppConfig;
  const { bot, botId } = yield* TelegramBot;
  // Access control goes in before any handler: it decides whether an update
  // reaches them at all.
  installAccessPipeline(bot, { botId, ownerId: cfg.allowedUserId });

  // WORK_DIR, when set, is the one directory every run works in — pinned
  // before any handler can read a conversation's project.
  const workDir = Option.getOrUndefined(cfg.workDir);
  pinWorkDir(workDir);
  // Every reply, menu and notice reads the language; it is known before the
  // first update arrives.
  yield* Effect.promise(loadLanguage);
  // The owner's limit on runs at once, applied before the first run starts.
  yield* Effect.promise(async () => {
    await loadRunLimit(cfg.maxConcurrentRuns);
  });
  // Log lines the agent package writes outside an Effect go to this runtime.
  yield* pinLogSink;
  // The bwrap view light runs start in, pinned before any run can start.
  yield* pinHostSandbox;

  // Every agent turn the bot starts is registered in @workspace/agent; this
  // writes each start and end to the ledger and keeps `.data/runs.json`
  // current.
  const turnWatch = watchAgentTurns(runsSnapshotPath());
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await turnWatch.close();
    })
  );

  // Built in main's scope on purpose, before the drain finalizer, so its
  // FiberSet closes only after the drain. Moving it to `Effect.provide` or
  // the app layer changes the shutdown order.
  const pendingWork = Context.get(
    yield* Layer.build(PendingWork.layer),
    PendingWork
  );
  // One settings service for `/settings` and the HTTP API, over the
  // runtime's tables; its ports reach the running bot.
  const settings = yield* Layer.build(SettingsLive);
  const { accessWatcher, pipeline, reminderScheduler, scheduler } =
    yield* registerHandlers({
      bot,
      botId,
      defaultTz: cfg.defaultTz,
      ownerId: cfg.allowedUserId,
      pendingWork,
      projectsDir: workDir ?? cfg.projectsDir,
      token: Redacted.value(cfg.botToken),
    }).pipe(Effect.provideContext(settings));

  bot.catch(({ ctx, error }) => {
    const reason = error instanceof Error ? error.message : String(error);
    // A BotError contains the entire update context. Business updates may
    // carry private correspondence, so log only the update id and the safe
    // summary.
    runtime.runFork(
      Effect.logError(`Bot update ${ctx.update.update_id} failed: ${reason}`)
    );
  });

  yield* Effect.addFinalizer(() => drainOrStop(pendingWork));
  // The HTTP API, when on, is built after the drain finalizer on purpose:
  // finalizers run last-in, first-out, so at shutdown it stops taking
  // requests before accepted work drains, the agent runs it started
  // included. Its task writes reload the same scheduler the chat's do.
  yield* serveApi({
    pendingWork,
    projectsDir: workDir ?? cfg.projectsDir,
    scheduler,
  }).pipe(Effect.provideContext(settings));
  const polling = yield* startPolling(bot);
  yield* Effect.raceFirst(
    Effect.promise(async () => {
      await polling.started;
    }),
    pollingEnded(polling.done)
  );
  yield* Effect.log("Bot started");

  yield* cleanupPass.pipe(
    Effect.repeat(Schedule.fixed(CLEANUP_INTERVAL_MS)),
    Effect.forkScoped
  );
  kickStartupWork(cfg.allowedUserId, pipeline);
  // The task loop is registered before the reminder poll starts.
  const taskCount = yield* scheduler.start;
  if (Option.isSome(taskCount)) {
    yield* Effect.log(`Recurring tasks scheduled: ${taskCount.value}`);
  }
  yield* reminderScheduler.start;
  yield* Effect.log("Reminder scheduler started");
  // Trusted groups, the workspace and the stored tiers are sqlite rows any run
  // with this machine can write; the watcher tells the owner when they change
  // without a command of theirs behind it.
  yield* accessWatcher.start;
  // Token DMs of new API keys are deleted after a while, from here whether
  // the key came from /apikeys or from the CLI.
  yield* startTokenMessageSweep;

  yield* Effect.addFinalizer(() => logShutdownStart);
  return yield* pollingEnded(polling.done);
});

/**
 * A signal interrupts the program; after its graceful drain that is a clean
 * exit, so systemd's `Restart=on-failure` restarts only a real failure.
 */
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    onExit(0);
    return;
  }
  Runtime.defaultTeardown(exit, onExit);
};

// The program runs on the services of the one ManagedRuntime the grammy
// closures use, so the app layer (and the db client in it) is built once.
BunRuntime.runMain(
  runtime.contextEffect.pipe(
    Effect.flatMap((context) =>
      Effect.scoped(reportFailure(main)).pipe(Effect.provideContext(context))
    )
  ),
  { teardown }
);
