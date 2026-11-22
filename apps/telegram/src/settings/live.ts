import { ElevenLabs, loadPiModels, resizeRuns } from "@workspace/agent";
import type { RunRegistry } from "@workspace/agent";
import { AppConfig } from "@workspace/env/bot";
import { Effect, Layer, Predicate } from "effect";

import { syncAccessSnapshot } from "../access/audit";
import { noteWritten } from "../bot-settings";
import { nameOf } from "../handlers/account";
import { logRejection } from "../handlers/helpers";
import { switchLanguage } from "../i18n";
import { syncAllCommands } from "../telegram/commands";
import { TelegramAccount } from "../telegram/telegram-account";
import { SettingsPorts, SettingsService } from "./service";
import type { AccountView, VoiceList } from "./service";

/**
 * `SettingsPorts` on the running bot: the account, pi's list and the voices
 * as the process holds them, and what a write sets off (the cache, the
 * language and every command menu, the run registry, the access watcher's
 * baseline). Built only in the entrypoint: it reaches the bot through the
 * runtime.
 */
const make = Effect.gen(function* makeSettingsPorts() {
  const cfg = yield* AppConfig;
  const account = yield* TelegramAccount;
  const elevenLabs = yield* ElevenLabs;
  const registry = yield* Effect.context<RunRegistry>();

  const voices: Effect.Effect<VoiceList> = elevenLabs.configured
    ? elevenLabs.voices().pipe(
        Effect.map((list): VoiceList => ({ kind: "ready", voices: list })),
        Effect.catchTag("ElevenLabsError", (error) =>
          Effect.as(Effect.logWarning("ElevenLabs voices read failed", error), {
            kind: "failed",
            reason: error.message,
          } satisfies VoiceList)
        )
      )
    : Effect.succeed({ kind: "off" });

  return SettingsPorts.of({
    account: Effect.map(account.status, (status): AccountView =>
      Predicate.isTagged(status, "logged-in")
        ? { kind: "connected", name: nameOf(status.self) }
        : { kind: status._tag }
    ),
    languageChanged: (language) =>
      Effect.sync(() => {
        switchLanguage(language);
        // The command descriptions are copy too; every menu is re-registered.
        syncAllCommands(cfg.allowedUserId).catch(
          logRejection("Failed to set bot commands after a language switch")
        );
      }),
    piModels: Effect.promise(loadPiModels),
    runLimitChanged: (limit) =>
      resizeRuns(limit).pipe(Effect.provideContext(registry)),
    voices,
    // The bot's own write is the access watcher's new baseline.
    workspaceCleared: Effect.tryPromise(syncAccessSnapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("access snapshot not re-baselined", error)
      )
    ),
    written: (changes) =>
      Effect.sync(() => {
        noteWritten(changes);
      }),
  });
});

const SettingsPortsLive = Layer.effect(SettingsPorts, make);

/** `SettingsService` with its live ports, over the runtime's services. */
export const SettingsLive = SettingsService.layer.pipe(
  Layer.provideMerge(SettingsPortsLive)
);
