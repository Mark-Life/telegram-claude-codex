import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import { RunRegistry } from "./agent/run-registry";
import { SessionStore } from "./agent/session-store";
import { AppConfig } from "./config";
import { loggerLayer } from "./logger";
import { Observability } from "./observability";
import { BotService } from "./telegram/bot-service";
import { telemetryLayer } from "./telemetry";

/**
 * Console logging + the optional OTLP forwarder as ONE composed layer.
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
 * Bun platform services (FileSystem, Path, etc.) that later phases build on.
 * These are the dependencies BotService and future services are provided.
 */
const infraLayer = Layer.mergeAll(
  AppConfig.layer,
  loggingLayer,
  BunServices.layer
);

/**
 * Composition root. BotService and RunRegistry requirements are satisfied by
 * infraLayer; provideMerge keeps every service reachable, yielding a
 * self-contained layer suitable for ManagedRuntime.make. Later phases add
 * services here.
 */
const appLayer = Layer.mergeAll(
  BotService.layer,
  RunRegistry.layer,
  Observability.layer,
  SessionStore.layer
).pipe(Layer.provideMerge(infraLayer));

/**
 * Long-lived runtime owning the appLayer scope. grammy keeps the process loop;
 * this bridges the bot into Effect via runPromise and is disposed on shutdown.
 */
export const runtime = ManagedRuntime.make(appLayer);
export const runPromise = runtime.runPromise;
export const runFork = runtime.runFork;
