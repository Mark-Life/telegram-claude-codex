import { BunServices } from "@effect/platform-bun";
import { ElevenLabs, RunRegistry, TypeSafeAi } from "@workspace/agent";
import { loggerLayer } from "@workspace/core/logger";
import { telemetryLayer } from "@workspace/core/telemetry";
import { AppConfig } from "@workspace/env/bot";
import { Layer, ManagedRuntime } from "effect";

import { AccountActions } from "./account/actions";
import { LocalTools } from "./account/local-tools";
import { MarkRead } from "./account/mark-read";
import { AccountMcpServerLive } from "./account/mcp-server";
import { RawSchema } from "./account/raw-schema";
import { RawTools } from "./account/raw-tools";
import { ReadTools } from "./account/read-tools";
import { ToolCalls } from "./account/tool-calls";
import { WriteTools } from "./account/write-tools";
import { WritesMode } from "./account/writes-mode";
import { DbLive } from "./db/layer";
import { Observability } from "./observability";
import { ProvidersLive } from "./provider-availability";
import { NotifyService } from "./telegram/notify";
import { TelegramAccount } from "./telegram/telegram-account";
import { TelegramBot } from "./telegram/telegram-bot";
import { TranscribeService } from "./transcribe";

/**
 * Console logging + the optional OTLP forwarder (logs and traces) as ONE
 * composed layer.
 *
 * telemetryLayer's OtlpLogger merges with whatever loggers exist in ITS build
 * scope, so it must be built on top of loggerLayer to merge with the configured
 * LOG_FORMAT console logger (rather than Effect's default). Because both set
 * CurrentLoggers, telemetry is placed last so its merged [console, otlp] set
 * wins; loggerLayer alone stays exposed for the endpoint-unset case where
 * telemetryLayer is Layer.empty.
 */
const loggingLayer = Layer.mergeAll(
  loggerLayer,
  telemetryLayer.pipe(Layer.provide(loggerLayer))
);

/**
 * Infrastructure layer: config, logging (+ optional OTLP forwarder), and the
 * Bun platform services (FileSystem, Path, etc.) the rest builds on.
 */
const infraLayer = Layer.mergeAll(
  AppConfig.layer,
  loggingLayer,
  BunServices.layer
);

/**
 * The services everything else is built on: the one db client, the bot, the
 * ledger, and the process-wide agent helpers.
 */
const coreLayer = Layer.mergeAll(
  // Which providers this host can run, and which one each kind of work runs
  // on: every provider's CLI is checked while the layer builds.
  ProvidersLive,
  // Opens and migrates `.data/bot.db` on the first runtime call, before
  // polling; disposing the runtime closes it and checkpoints the WAL. Also
  // provides `SessionStore`, which sits on the same client.
  DbLive,
  TelegramBot.layer,
  Observability.layer,
  TranscribeService.layer,
  // One client per process: this is the only ManagedRuntime, so every judgment
  // the bot makes on Jev shares the layer built in its scope.
  TypeSafeAi.layer,
  // Voices for `/settings` → «Голосовые ответы»; a no-op without a key.
  ElevenLabs.layer
);

/**
 * The owner's own Telegram account: the client, the write mode, the write
 * path with its confirmation and expiry, and the loopback MCP server runs
 * reach it through, with the tool calls and read marks it serves. With the
 * env keys absent each is a no-op and nothing listens.
 */
const accountLayer = AccountMcpServerLive.pipe(
  Layer.provide(
    ToolCalls.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ReadTools.layer,
          LocalTools.layer,
          WriteTools.layer,
          RawTools.layer
        )
      ),
      Layer.provide(MarkRead.layer)
    )
  ),
  Layer.provideMerge(AccountActions.layer),
  Layer.provideMerge(RawSchema.layer),
  Layer.provideMerge(WritesMode.layer),
  Layer.provideMerge(TelegramAccount.layer)
);

/**
 * Composition root. Each layer is provided to the ones above it and kept
 * reachable (provideMerge), so the result is self-contained for
 * ManagedRuntime.make. RunRegistry reads the account server's endpoint from
 * the account layer below it.
 */
const appLayer = RunRegistry.layer.pipe(
  Layer.provideMerge(accountLayer),
  // Notices to a target, over the bot and the settings it reads them from.
  Layer.provideMerge(NotifyService.layer),
  Layer.provideMerge(coreLayer),
  Layer.provideMerge(infraLayer)
);

/**
 * Long-lived runtime owning the appLayer scope: the one build per process.
 * The entrypoint's main program runs on its context, grammy closures reach it
 * through runPromise, and the main program disposes it as its last finalizer.
 */
export const runtime = ManagedRuntime.make(appLayer);
export const { runPromise } = runtime;
export const { runFork } = runtime;
