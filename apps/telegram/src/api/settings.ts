import type { ProviderId, TtsVoice } from "@workspace/agent";
import {
  BotApi,
  Conflict,
  CurrentPrincipal,
  Forbidden,
  InvalidInput,
  SETTING_ACCOUNT_WRITES,
  SETTING_LANGUAGES,
  SETTING_VERBOSITIES,
  Unavailable,
} from "@workspace/api";
import type {
  BotSettings,
  HelpersSettingsView,
  LightSettings,
  MySettings,
  ProviderSettings,
  VoiceSettings,
} from "@workspace/api";
import { ACCOUNT_WRITE_MODES } from "@workspace/env/bot";
import type { AccountWriteMode } from "@workspace/env/bot";
import { Effect } from "effect";
import { absurd } from "effect/Function";
import { HttpApiBuilder } from "effect/http-api";

import { isOperator, isOwner } from "../access/tier";
import { LANGUAGES } from "../i18n";
import type { Language } from "../i18n";
import { SettingsService } from "../settings/service";
import type { SettingRefused, SettingsFailure } from "../settings/service";
import { VERBOSITY_LEVELS } from "../telegram/render-policy";
import type { Verbosity } from "../telegram/render-policy";
import { field } from "./views";

/**
 * The bot's settings over HTTP: a door over `SettingsService`, as
 * `/settings` is, with its access rules. Every key holder reads and changes
 * their own new-chat defaults; the rest is the owner's. Every write answers
 * the setting as it now stands.
 */

// The contract's names are exactly the bot's own, checked here at compile
// time both ways: a value the bot gains fails the typecheck, not a read.
SETTING_LANGUAGES satisfies readonly Language[];
SETTING_VERBOSITIES satisfies readonly Verbosity[];
SETTING_ACCOUNT_WRITES satisfies readonly AccountWriteMode[];
LANGUAGES satisfies readonly (typeof SETTING_LANGUAGES)[number][];
VERBOSITY_LEVELS satisfies readonly (typeof SETTING_VERBOSITIES)[number][];
ACCOUNT_WRITE_MODES satisfies readonly (typeof SETTING_ACCOUNT_WRITES)[number][];

/** A list of values as a refusal names them. */
const listOf = (values: readonly string[]) =>
  values.length === 0 ? "nothing" : values.map((v) => `\`${v}\``).join(", ");

/**
 * How a refusal reads over HTTP: in the request's own field names, since a
 * program (or the model behind it) reads it to fix its next call.
 */
const refusalOf = (error: SettingRefused) => {
  const { field: name, value } = error;
  switch (error.reason) {
    case "notOffered": {
      const byName =
        error.byName === true
          ? ", or a pi model by name (`provider/id`) from `options.model`"
          : "";
      return new InvalidInput({
        message: `\`${name}\` cannot be \`${value}\` now. It takes ${listOf(error.offered)}${byName}.`,
      });
    }
    case "unknownSetting": {
      return new InvalidInput({
        message: `\`${name}\` is no setting this provider lets change. It offers ${listOf(error.offered)}.`,
      });
    }
    case "badZone": {
      return new InvalidInput({
        message: `Unknown time zone: \`${value}\`. Send an IANA zone such as \`Europe/Berlin\`, or a city only one zone ends in.`,
      });
    }
    case "noProvider": {
      return new InvalidInput({
        message: `\`${name}\` needs a provider of the pass's own: on Auto (\`provider: default\`) there is none. Send \`provider\` too.`,
      });
    }
    case "providerDown": {
      return new Conflict({
        message: `\`${value}\` cannot run now (not installed or not logged in). Pick another provider, or log in with /login first.`,
      });
    }
    case "accountOff": {
      return new Conflict({
        message:
          "The owner's Telegram account is not set up on this bot, so there is no write mode to set.",
      });
    }
    case "voicesOff": {
      return new Conflict({
        message:
          "Voice replies are not set up: the bot has no ElevenLabs key, so there is no voice to pick.",
      });
    }
    case "voicesFailed": {
      return new Unavailable({
        message:
          "ElevenLabs did not list the account's voices. Nothing was changed; try again later.",
      });
    }
    default: {
      return absurd<InvalidInput>(error.reason);
    }
  }
};

/** A read: a db failure is the server's, never the caller's. */
const readOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

/** A service failure as the API's typed error; a db failure is the server's. */
const asApiError = <A>(effect: Effect.Effect<A, SettingsFailure>) =>
  effect.pipe(
    Effect.catchTag("SettingRefused", (error) => Effect.fail(refusalOf(error))),
    Effect.catchTag("PersistenceError", Effect.die)
  );

/** The principal, when they are the owner. */
const owner = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (!isOwner(principal.tier)) {
    return yield* new Forbidden({
      message:
        "Only the owner reads and changes the bot's settings. Your own new-chat defaults are `settings.getMine` and `settings.updateMine`.",
    });
  }
  return principal;
});

/** The principal, when their tier has «Мои настройки». */
const operator = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (!isOperator(principal.tier)) {
    return yield* new Forbidden({
      message: "Only the owner and executors have settings of their own.",
    });
  }
  return principal;
});

const voiceView = (voice: TtsVoice) => ({
  gender: voice.gender ?? null,
  id: voice.id,
  name: voice.name,
  own: voice.own,
});

export const SettingsLive = HttpApiBuilder.group(
  BotApi,
  "settings",
  Effect.fnUntraced(function* (handlers) {
    const settings = yield* SettingsService;

    const readMine = (viewer: { owner: boolean; userId: number }) =>
      Effect.map(readOf(settings.readMine(viewer)), (mine): MySettings => ({
        effort: mine.effort,
        model: mine.model,
        options: mine.options,
        piModel: mine.piModel ?? null,
        provider: mine.provider,
        startsOn: mine.startsOn,
      }));

    const readBot = Effect.map(
      readOf(settings.readBot()),
      (bot): BotSettings => ({
        account:
          bot.account.kind === "connected"
            ? { name: bot.account.name, status: "connected" }
            : { status: bot.account.kind },
        ...field("accountWrites", bot.accountWrites),
        guests: bot.toggles.guests,
        language: bot.language,
        limits: bot.limits,
        markRead: bot.toggles.markRead,
        maxConcurrentRuns: bot.maxConcurrentRuns,
        options: bot.options,
        steer: bot.toggles.steer,
        timeZone: bot.timeZone,
        verbosity: bot.verbosity,
        voiceTranscript: bot.toggles.voiceTranscript,
        workspace:
          bot.workspace === undefined
            ? null
            : {
                chatId: bot.workspace.chatId,
                threadId: bot.workspace.threadId,
              },
      })
    );

    const readLight = Effect.map(
      readOf(settings.readLight()),
      (light): LightSettings => ({
        detected: light.detected,
        effort: light.effort,
        listed: light.listed,
        model: light.model,
        options: light.options,
        piModel: light.piModel ?? null,
        provider: light.provider,
      })
    );

    const readHelpers = Effect.map(
      readOf(settings.readHelpers()),
      (passes): HelpersSettingsView => {
        const view = (pass: (typeof passes)["format"]) => ({
          effort: pass.effort,
          model: pass.model,
          options: pass.options,
          piModel: pass.piModel ?? null,
          provider: pass.provider,
          runsOn: {
            auto: pass.runsOn.auto,
            model: pass.runsOn.model ?? null,
            provider: pass.runsOn.provider ?? null,
          },
        });
        return {
          format: view(passes.format),
          judge: view(passes.judge),
          title: view(passes.title),
        };
      }
    );

    const readVoice = Effect.map(
      readOf(settings.readVoice()),
      (voice): VoiceSettings => ({
        configured: voice.voices.kind !== "off",
        model: voice.model,
        options: voice.options,
        storedVoiceId: voice.stored ?? null,
        voice: voice.current === undefined ? null : voiceView(voice.current),
        voices:
          voice.voices.kind === "ready"
            ? voice.voices.voices.map(voiceView)
            : [],
        ...field(
          "voicesError",
          voice.voices.kind === "failed" ? voice.voices.reason : undefined
        ),
      })
    );

    const providersView = Effect.map(
      readOf(settings.readProviders()),
      (providers) =>
        providers.map((provider): ProviderSettings => ({
          overridden: provider.overridden,
          provider: provider.provider,
          settings: provider.settings.map((setting) => ({
            key: setting.key,
            kind: setting.control.kind,
            options:
              setting.control.kind === "toggle"
                ? [true, false]
                : setting.control.values,
            value: setting.value ?? null,
          })),
          version: provider.version,
        }))
    );

    const providerView = (id: ProviderId) =>
      Effect.flatMap(providersView, (providers) => {
        const found = providers.find((provider) => provider.provider === id);
        return found === undefined
          ? Effect.die(new Error(`no settings read for ${id}`))
          : Effect.succeed(found);
      });

    return handlers
      .handle("getMine", () =>
        Effect.gen(function* () {
          const principal = yield* operator;
          return yield* readMine({
            owner: isOwner(principal.tier),
            userId: principal.telegramUserId,
          });
        })
      )
      .handle("updateMine", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* operator;
          const viewer = {
            owner: isOwner(principal.tier),
            userId: principal.telegramUserId,
          };
          yield* asApiError(settings.updateMine(viewer, payload));
          return yield* readMine(viewer);
        })
      )
      .handle("getBot", () => Effect.andThen(owner, readBot))
      .handle("updateBot", ({ payload }) =>
        Effect.gen(function* () {
          yield* owner;
          yield* asApiError(settings.updateBot(payload));
          return yield* readBot;
        })
      )
      .handle("getLight", () => Effect.andThen(owner, readLight))
      .handle("updateLight", ({ payload }) =>
        Effect.gen(function* () {
          yield* owner;
          yield* asApiError(settings.updateLight(payload));
          return yield* readLight;
        })
      )
      .handle("getHelpers", () => Effect.andThen(owner, readHelpers))
      .handle("updateHelper", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* owner;
          yield* asApiError(settings.updateHelper(params.use, payload));
          return yield* readHelpers;
        })
      )
      .handle("getVoice", () => Effect.andThen(owner, readVoice))
      .handle("updateVoice", ({ payload }) =>
        Effect.gen(function* () {
          yield* owner;
          yield* asApiError(settings.updateVoice(payload));
          return yield* readVoice;
        })
      )
      .handle("getProviders", () =>
        Effect.gen(function* () {
          yield* owner;
          return { providers: yield* providersView };
        })
      )
      .handle("updateProvider", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* owner;
          yield* asApiError(settings.updateProvider(params.provider, payload));
          return yield* providerView(params.provider);
        })
      );
  })
);
