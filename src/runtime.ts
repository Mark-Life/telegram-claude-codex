import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import { RunRegistry } from "./agent/run-registry";
import { AppConfig } from "./config";
import { loggerLayer } from "./logger";
import { Observability } from "./observability";
import { BotService } from "./telegram/bot-service";

/**
 * Infrastructure layer: config, logger, and the Bun platform services
 * (FileSystem, Path, etc.) that later phases build on. These are the
 * dependencies BotService and future services are provided.
 */
const infraLayer = Layer.mergeAll(
  AppConfig.layer,
  loggerLayer,
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
  Observability.layer
).pipe(Layer.provideMerge(infraLayer));

/**
 * Long-lived runtime owning the appLayer scope. grammy keeps the process loop;
 * this bridges the bot into Effect via runPromise and is disposed on shutdown.
 */
export const runtime = ManagedRuntime.make(appLayer);
export const runPromise = runtime.runPromise;
export const runFork = runtime.runFork;
