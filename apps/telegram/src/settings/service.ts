import {
  decodeOwnerSettings,
  decodeProviderId,
  findPiModel,
  isRunnable,
  pickVoice,
  piLightList,
  PROVIDER_IDS,
  PROVIDER_SETTINGS,
  Providers,
  settingControl,
  settingFields,
  settingValues,
  snapshotOf,
  TTS_MODELS,
  ttsModelOf,
} from "@workspace/agent";
import type {
  EffectiveProviders,
  OneTurnUse,
  PiModelList,
  ProviderId,
  SettingValue,
  TtsVoice,
} from "@workspace/agent";
import { SettingsRepo, UserSettingsRepo } from "@workspace/db";
import type {
  PersistenceError,
  SettingChange,
  SettingKey,
  UserSettingKey,
} from "@workspace/db";
import { ACCOUNT_WRITE_MODES, AppConfig } from "@workspace/env/bot";
import type { AccountWriteMode } from "@workspace/env/bot";
import {
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import { formatLimit, limitLadder, parseLimit } from "../access/rate-limit";
import type { LimitKey } from "../access/rate-limit";
import { envWritesMode, writesModeOf } from "../account/writes-mode";
import type { ToggleKey } from "../bot-settings";
import {
  piModelOf,
  PROVIDER_DEFAULT,
  providerChoiceOf,
  startPickOf,
} from "../handlers/chat-defaults";
import type { StoredSettings } from "../handlers/chat-defaults";
import {
  HELPER_KEYS,
  helperOf,
  LIGHT_KEYS,
  ownModel,
  parseChoice,
} from "../handlers/light-defaults";
import type { ChoiceKeys, LightChoice } from "../handlers/light-defaults";
import { startProviderWith } from "../handlers/route-provider";
import { isLanguage, LANGUAGES, parseLanguage } from "../i18n";
import type { Language } from "../i18n";
import { personaGenderOf } from "../persona";
import { resolveZone } from "../reminders/zone";
import { parseRunLimit, RUN_LIMIT_PRESETS } from "../run-limit";
import { parseVerbosity, VERBOSITY_LEVELS } from "../telegram/render-policy";
import { defaultsOptions, helperOptions, lightOptions, OWN } from "./options";

/**
 * Every setting a person sees and changes in `/settings`, as values: one
 * place that reads them, checks a change against what the setting offers now
 * and stores it with whatever must follow (the language switch, the run
 * limit, the access watcher's baseline, the settings cache). `/settings` and
 * the HTTP API are two doors over it, each wording a refusal its own way, so
 * a value one door takes the other takes too. Who may call what is the
 * door's to check: «Мои настройки» is every operator's own, the rest the
 * owner's.
 *
 * Reads go to the table, never the cache in `bot-settings.ts`, and every
 * write hands its changes to `SettingsPorts.written`, which keeps that cache
 * in step. A change of several fields is checked whole before anything is
 * stored, and stored in one transaction.
 */

/** Why a change was refused; the doors word each one. */
export const SETTING_REFUSALS = [
  // The account feature is off: there is no write mode to set.
  "accountOff",
  // A helper pass on Auto has no model or depth of its own.
  "noProvider",
  // The value is not one the setting offers now.
  "notOffered",
  // The provider is offered but cannot run now.
  "providerDown",
  // No IANA zone or known city by that name.
  "badZone",
  // The provider has no such setting.
  "unknownSetting",
  // No `ELEVENLABS_API_KEY`: there are no voices to pick from.
  "voicesOff",
  // ElevenLabs did not list the voices.
  "voicesFailed",
] as const;

export type SettingRefusalReason = (typeof SETTING_REFUSALS)[number];

// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class SettingRefused extends Schema.TaggedError<SettingRefused>()(
  "SettingRefused",
  {
    /** pi's models are taken by name besides `offered`. */
    byName: Schema.optional(Schema.Boolean),
    /** The setting, in the field names of the service's patches. */
    field: Schema.String,
    /** Every value it offers now; a pi model also by name when `byName`. */
    offered: Schema.Array(Schema.String),
    reason: Schema.Literals(SETTING_REFUSALS),
    value: Schema.String,
  }
) {}

/** The owner's Telegram account as the settings show it. */
export type AccountView =
  | { readonly kind: "connected"; readonly name: string }
  | { readonly kind: "logged-out" }
  | { readonly kind: "off" };

/** The account's voices, or why there are none to show. */
export type VoiceList =
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "off" }
  | { readonly kind: "ready"; readonly voices: readonly TtsVoice[] };

/**
 * What the service needs from the running bot, beyond the tables: the
 * process's own state it reads (pi's models, the voices, the account) and
 * what a write must set off. Built in the entrypoint, never in a test.
 */
export class SettingsPorts extends Context.Service<
  SettingsPorts,
  {
    /** The owner's Telegram account. */
    readonly account: Effect.Effect<AccountView>;
    /** The bot speaks `language` from now on, its command menus included. */
    readonly languageChanged: (language: Language) => Effect.Effect<void>;
    /** pi's models, read once if none arrived yet. */
    readonly piModels: Effect.Effect<PiModelList>;
    /** The next run that starts honours the new limit. */
    readonly runLimitChanged: (limit: number) => Effect.Effect<void>;
    /** The owner's ElevenLabs voices; never fails. */
    readonly voices: Effect.Effect<VoiceList>;
    /** The workspace was forgotten: the access watcher's new baseline. */
    readonly workspaceCleared: Effect.Effect<void>;
    /** Rows just stored, so the settings cache never goes stale. */
    readonly written: (
      changes: readonly SettingChange[]
    ) => Effect.Effect<void>;
  }
>()("@workspace/telegram/SettingsPorts") {}

/** Who «Мои настройки» are read and written for. */
export interface Viewer {
  readonly owner: boolean;
  readonly userId: number;
}

/** A change to «Мои настройки»; an absent field stays as it is. */
export interface MinePatch {
  readonly effort?: string;
  /** A tier, `auto` or `default`; on pi also a model by name. */
  readonly model?: string;
  readonly provider?: string;
}

/** A change to the light choice or a helper pass's; absent stays. */
export interface ChoicePatch {
  readonly effort?: string;
  /** A tier or `default`; on pi also a model by name. */
  readonly model?: string;
  readonly provider?: string;
}

/** The four on/off switches, by the name a patch gives them. */
const TOGGLE_FIELDS = {
  guests: "guests",
  markRead: "mark_read",
  steer: "steer",
  voiceTranscript: "voice_transcript",
} as const satisfies Record<string, ToggleKey>;

export type ToggleField = keyof typeof TOGGLE_FIELDS;

/** The four daily budgets, by the name a patch gives them. */
const LIMIT_FIELDS = {
  groupRunsPerDay: "group_runs_per_day",
  groupRunsPerUser: "group_runs_per_user",
  privateRunsPerDay: "private_runs_per_day",
  privateRunsPerUser: "private_runs_per_user",
} as const satisfies Record<string, LimitKey>;

export type LimitField = keyof typeof LIMIT_FIELDS;

/** A daily budget: a count, or `off` for none. */
export type LimitValue = number | "off";

/** A change to «Настройки бота»; an absent field stays as it is. */
export interface BotPatch {
  readonly accountWrites?: string;
  readonly guests?: boolean;
  readonly language?: string;
  readonly limits?: Partial<Record<LimitField, LimitValue>>;
  readonly markRead?: boolean;
  readonly maxConcurrentRuns?: number;
  readonly steer?: boolean;
  /** An IANA zone or a city only one zone ends in. */
  readonly timeZone?: string;
  readonly verbosity?: string;
  readonly voiceTranscript?: boolean;
  /** `null` forgets the workspace; nothing else sets one. */
  readonly workspace?: null;
}

/** A change to «Голосовые ответы»; an absent field stays as it is. */
export interface VoicePatch {
  readonly model?: string;
  readonly voice?: string;
}

/** A provider's settings to change: a value it offers, or null to unset. */
export type ProviderPatch = Readonly<Record<string, SettingValue | null>>;

const refuse = (input: {
  byName?: boolean;
  field: string;
  offered?: readonly string[];
  reason: SettingRefusalReason;
  value: string;
}) =>
  Effect.fail(
    new SettingRefused({
      byName: input.byName,
      field: input.field,
      offered: input.offered ?? [],
      reason: input.reason,
      value: input.value,
    })
  );

/** `value` when it is one of `offered`, else a `notOffered` refusal. */
const offeredOr = (input: {
  byName?: boolean;
  field: string;
  offered: readonly string[];
  value: string;
}) =>
  input.offered.includes(input.value)
    ? Effect.succeed(input.value)
    : refuse({ ...input, reason: "notOffered" });

/** A budget as the API shows it: a count, or `off`. */
const limitValueOf = (limit: number): LimitValue =>
  Number.isFinite(limit) ? limit : "off";

/** Changes keyed by setting, the last one for a key winning. */
const changeList = (changes: ReadonlyMap<SettingKey, string | null>) =>
  [...changes].map(([key, value]): SettingChange => ({ key, value }));

const runnableIn = (providers: EffectiveProviders) => (id: ProviderId) =>
  isRunnable(snapshotOf(providers.snapshots, id).status);

const piKeys = (list: PiModelList | undefined) =>
  list === undefined ? [] : list.models.map((model) => model.key);

/**
 * A model change on a list of fixed values, or on pi's list by name:
 * the rows it stores, the tier under `keys.model` and the pi model under
 * `keys.pi`. A fixed value on pi forgets the pi model, as the picker's
 * usual row does.
 */
const modelChange = <K extends string>(input: {
  field: string;
  fixed: readonly string[];
  keys: { readonly model: K; readonly pi: K };
  pi: PiModelList | undefined;
  value: string;
}): Effect.Effect<readonly (readonly [K, string])[], SettingRefused> => {
  const { keys, pi, value } = input;
  if (input.fixed.includes(value)) {
    const tier = [keys.model, value] as const;
    return Effect.succeed(
      pi === undefined ? [tier] : [[keys.pi, PROVIDER_DEFAULT] as const, tier]
    );
  }
  const named = pi === undefined ? undefined : findPiModel(pi, value);
  return named === undefined
    ? refuse({
        byName: pi !== undefined,
        field: input.field,
        offered: input.fixed,
        reason: "notOffered",
        value,
      })
    : Effect.succeed([[keys.pi, named.key] as const]);
};

/** A choice as the doors show it: the stored values, `default` for none. */
const choiceView = (choice: LightChoice) => ({
  effort: choice.effort ?? OWN,
  model: choice.tier ?? OWN,
  piModel: choice.piStored,
  provider: choice.provider ?? OWN,
});

type StoredChoice = ReturnType<typeof providerChoiceOf>;

/** A person's provider choice as the doors show it; unset is null. */
const chosenOf = (choice: StoredChoice) =>
  Match.value(choice).pipe(
    Match.when({ kind: "chosen" }, ({ provider }) => provider),
    Match.when({ kind: "detected" }, () => "auto" as const),
    Match.when({ kind: "unset" }, () => null),
    Match.exhaustive
  );

const make = Effect.gen(function* makeSettingsService() {
  const repo = yield* SettingsRepo;
  const users = yield* UserSettingsRepo;
  const providersService = yield* Providers;
  const ports = yield* SettingsPorts;
  const cfg = yield* AppConfig;
  const accountFeature = Option.isSome(cfg.telegramAccount);

  const stored = (key: SettingKey) =>
    repo.get(key).pipe(Effect.map(Option.getOrUndefined));

  /** Store `changes` in one transaction, then keep the cache in step. */
  const write = Effect.fnUntraced(function* (
    changes: ReadonlyMap<SettingKey, string | null>
  ) {
    if (changes.size === 0) {
      return;
    }
    const list = changeList(changes);
    yield* repo.apply(list);
    yield* ports.written(list);
  });

  const readChoice = Effect.fnUntraced(function* (keys: ChoiceKeys) {
    const [provider, model, effort, pi] = yield* Effect.all([
      stored(keys.provider),
      stored(keys.model),
      stored(keys.effort),
      stored(keys.pi),
    ]);
    return parseChoice({ effort, model, pi, provider });
  });

  /** pi's models a light run or helper pass can run, read only for pi. */
  const lightPi = (provider: ProviderId | undefined) =>
    provider === "pi"
      ? Effect.map(ports.piModels, (list): PiModelList | undefined =>
          piLightList(list)
        )
      : Effect.undefined;

  // «Мои настройки» -------------------------------------------------------

  /**
   * One person's defaults as stored (or as `stored` would leave them), and
   * the provider their new chats start on, whose models are listed.
   */
  const mineState = Effect.fnUntraced(function* (
    viewer: Viewer,
    userStored: StoredSettings
  ) {
    const providers = yield* providersService.current;
    const routingOff = (yield* stored("model_routing")) === "off";
    const choice = providerChoiceOf(userStored);
    const ownerChoice = viewer.owner
      ? decodeProviderId(yield* stored("owner_provider"))
      : Option.none<ProviderId>();
    const provider = startProviderWith({
      choice,
      detected: providers.default,
      owner: viewer.owner,
      ownerChoice,
      runnable: runnableIn(providers),
    });
    const options = defaultsOptions({
      chosen: choice.kind === "chosen" ? choice.provider : undefined,
      provider,
      providers,
    });
    return {
      choice,
      options,
      pick: startPickOf({ routingOff, stored: userStored }),
      provider,
      providers,
    };
  });

  const readMine = Effect.fn("SettingsService.readMine")(function* (
    viewer: Viewer
  ) {
    const userStored = yield* users.all(viewer.userId);
    const state = yield* mineState(viewer, userStored);
    const { choice } = state;
    const pi = state.provider === "pi" ? yield* ports.piModels : undefined;
    return {
      effort: state.pick.effort,
      model: state.pick.model,
      options: {
        effort: state.options.effort,
        model: [...state.options.model, ...piKeys(pi)],
        provider: state.options.provider,
      },
      piModel: piModelOf(userStored),
      provider: chosenOf(choice),
      startsOn: state.provider,
    };
  });

  const updateMine = Effect.fn("SettingsService.updateMine")(function* (
    viewer: Viewer,
    patch: MinePatch
  ) {
    const current = yield* users.all(viewer.userId);
    const projected = new Map(current);
    const changes = new Map<UserSettingKey, string>();
    if (patch.provider !== undefined) {
      const state = yield* mineState(viewer, current);
      const id = Option.getOrUndefined(decodeProviderId(patch.provider));
      // A provider that went down says so, offered or not.
      if (id !== undefined && !runnableIn(state.providers)(id)) {
        yield* refuse({
          field: "provider",
          reason: "providerDown",
          value: patch.provider,
        });
      }
      const value = yield* offeredOr({
        field: "provider",
        offered: state.options.provider,
        value: patch.provider,
      });
      changes.set("default_provider", value);
      projected.set("default_provider", value);
    }
    // The model and effort are checked on the provider the new choice
    // starts on.
    const state = yield* mineState(viewer, projected);
    if (patch.model !== undefined) {
      const pi = state.provider === "pi" ? yield* ports.piModels : undefined;
      const rows = yield* modelChange({
        field: "model",
        fixed: state.options.model,
        keys: { model: "default_model", pi: "default_pi_model" } as const,
        pi,
        value: patch.model,
      });
      for (const [key, value] of rows) {
        changes.set(key, value);
      }
    }
    if (patch.effort !== undefined) {
      changes.set(
        "default_effort",
        yield* offeredOr({
          field: "effort",
          offered: state.options.effort,
          value: patch.effort,
        })
      );
    }
    yield* users.apply({
      changes: [...changes].map(([key, value]) => ({ key, value })),
      userId: viewer.userId,
    });
  });

  // «Настройки бота» ------------------------------------------------------

  const readBot = Effect.fn("SettingsService.readBot")(function* () {
    const toggles = yield* Effect.all(
      Rec.map(TOGGLE_FIELDS, (key) =>
        Effect.map(stored(key), (raw) => raw !== "off")
      )
    );
    const limits = yield* Effect.all(
      Rec.map(LIMIT_FIELDS, (key) =>
        Effect.map(stored(key), (raw) => limitValueOf(parseLimit(key, raw)))
      )
    );
    const [language, verbosity, runLimit, zone, writes, workspace, account] =
      yield* Effect.all([
        stored("bot_language"),
        stored("verbosity"),
        stored("max_concurrent_runs"),
        stored("default_tz"),
        stored("account_writes"),
        repo.workspace(),
        ports.account,
      ]);
    const accountWrites: AccountWriteMode | undefined = accountFeature
      ? writesModeOf(writes, envWritesMode(cfg.telegramAccount))
      : undefined;
    return {
      account,
      accountWrites,
      language: parseLanguage(language),
      limits,
      maxConcurrentRuns: parseRunLimit(runLimit) ?? cfg.maxConcurrentRuns,
      options: {
        limits: Rec.map(LIMIT_FIELDS, (key) =>
          limitLadder(key).map(limitValueOf)
        ),
        maxConcurrentRuns: RUN_LIMIT_PRESETS,
      },
      timeZone:
        zone === undefined
          ? cfg.defaultTz
          : (resolveZone(zone) ?? cfg.defaultTz),
      toggles,
      verbosity: parseVerbosity(verbosity),
      workspace: Option.getOrUndefined(workspace),
    };
  });

  const updateBot = Effect.fn("SettingsService.updateBot")(function* (
    patch: BotPatch
  ) {
    const changes = new Map<SettingKey, string | null>();
    for (const [field, key] of Rec.toEntries(TOGGLE_FIELDS)) {
      const on = patch[field];
      if (on !== undefined) {
        changes.set(key, on ? "on" : "off");
      }
    }
    if (patch.language !== undefined) {
      changes.set(
        "bot_language",
        yield* offeredOr({
          field: "language",
          offered: LANGUAGES,
          value: patch.language,
        })
      );
    }
    if (patch.verbosity !== undefined) {
      changes.set(
        "verbosity",
        yield* offeredOr({
          field: "verbosity",
          offered: VERBOSITY_LEVELS,
          value: patch.verbosity,
        })
      );
    }
    for (const [field, key] of Rec.toEntries(LIMIT_FIELDS)) {
      const limit = patch.limits?.[field];
      if (limit !== undefined) {
        changes.set(
          key,
          yield* offeredOr({
            field: `limits.${field}`,
            offered: limitLadder(key).map(formatLimit),
            // A number as written, so `NaN` or a fraction is never read as off.
            value: limit === "off" ? "off" : String(limit),
          })
        );
      }
    }
    const runLimit = patch.maxConcurrentRuns;
    if (runLimit !== undefined) {
      changes.set(
        "max_concurrent_runs",
        yield* offeredOr({
          field: "maxConcurrentRuns",
          offered: RUN_LIMIT_PRESETS.map(String),
          value: String(runLimit),
        })
      );
    }
    if (patch.timeZone !== undefined) {
      const zone = resolveZone(patch.timeZone);
      changes.set(
        "default_tz",
        zone ??
          (yield* refuse({
            field: "timeZone",
            reason: "badZone",
            value: patch.timeZone,
          }))
      );
    }
    if (patch.accountWrites !== undefined) {
      if (!accountFeature) {
        yield* refuse({
          field: "accountWrites",
          reason: "accountOff",
          value: patch.accountWrites,
        });
      }
      changes.set(
        "account_writes",
        yield* offeredOr({
          field: "accountWrites",
          offered: ACCOUNT_WRITE_MODES,
          value: patch.accountWrites,
        })
      );
    }
    if (patch.workspace === null) {
      changes.set("workspace_chat_id", null);
      changes.set("workspace_thread_id", null);
    }
    yield* write(changes);
    const language = changes.get("bot_language") ?? undefined;
    if (isLanguage(language)) {
      yield* ports.languageChanged(language);
    }
    if (runLimit !== undefined) {
      yield* ports.runLimitChanged(runLimit);
    }
    if (patch.workspace === null) {
      yield* ports.workspaceCleared;
    }
  });

  // «Группы и гости» and «Служебные проходы» ------------------------------

  const readLight = Effect.fn("SettingsService.readLight")(function* () {
    const [choice, providers] = yield* Effect.all([
      readChoice(LIGHT_KEYS),
      providersService.current,
    ]);
    const listed = choice.provider ?? providers.light;
    const options = lightOptions({ provider: listed, providers });
    const pi = yield* lightPi(listed);
    return {
      ...choiceView(choice),
      detected: providers.light,
      listed,
      options: { ...options, model: [...options.model, ...piKeys(pi)] },
    };
  });

  const updateLight = Effect.fn("SettingsService.updateLight")(function* (
    patch: ChoicePatch
  ) {
    const [choice, providers] = yield* Effect.all([
      readChoice(LIGHT_KEYS),
      providersService.current,
    ]);
    const changes = new Map<SettingKey, string | null>();
    let { provider } = choice;
    if (patch.provider !== undefined) {
      const value = yield* offeredOr({
        field: "provider",
        offered: lightOptions({
          provider: provider ?? providers.light,
          providers,
        }).provider,
        value: patch.provider,
      });
      changes.set(LIGHT_KEYS.provider, value);
      provider = Option.getOrUndefined(decodeProviderId(value));
    }
    // The model and effort lists are the provider light runs go to then.
    const listed = provider ?? providers.light;
    const options = lightOptions({ provider: listed, providers });
    if (patch.model !== undefined) {
      const rows = yield* modelChange({
        field: "model",
        fixed: options.model,
        keys: LIGHT_KEYS,
        pi: yield* lightPi(listed),
        value: patch.model,
      });
      for (const [key, value] of rows) {
        changes.set(key, value);
      }
    }
    if (patch.effort !== undefined) {
      changes.set(
        LIGHT_KEYS.effort,
        yield* offeredOr({
          field: "effort",
          offered: options.effort,
          value: patch.effort,
        })
      );
    }
    yield* write(changes);
  });

  /** One pass's choice, where it runs now and what it offers. */
  const helperState = Effect.fnUntraced(function* (input: {
    light: LightChoice;
    providers: EffectiveProviders;
    use: OneTurnUse;
  }) {
    const choice = yield* readChoice(HELPER_KEYS[input.use]);
    const own = choice.provider;
    const options = helperOptions({
      model: own === undefined ? undefined : ownModel(own, choice),
      own,
      providers: input.providers,
      use: input.use,
    });
    const pi = yield* lightPi(own);
    const { own: onOwn, pick } = helperOf({ ...input, choice });
    return {
      ...choiceView(choice),
      options: { ...options, model: [...options.model, ...piKeys(pi)] },
      runsOn: { auto: !onOwn, model: pick.model, provider: pick.helper },
    };
  });

  const readHelpers = Effect.fn("SettingsService.readHelpers")(function* () {
    const [light, providers] = yield* Effect.all([
      readChoice(LIGHT_KEYS),
      providersService.current,
    ]);
    return yield* Effect.all({
      format: helperState({ light, providers, use: "format" }),
      judge: helperState({ light, providers, use: "judge" }),
      title: helperState({ light, providers, use: "title" }),
    });
  });

  const updateHelper = Effect.fn("SettingsService.updateHelper")(function* (
    use: OneTurnUse,
    patch: ChoicePatch
  ) {
    const keys = HELPER_KEYS[use];
    const [before, providers] = yield* Effect.all([
      readChoice(keys),
      providersService.current,
    ]);
    let choice = before;
    const changes = new Map<SettingKey, string | null>();
    const optionsOn = (on: LightChoice) =>
      helperOptions({
        model:
          on.provider === undefined ? undefined : ownModel(on.provider, on),
        own: on.provider,
        providers,
        use,
      });
    if (patch.provider !== undefined) {
      const value = yield* offeredOr({
        field: "provider",
        offered: optionsOn(choice).provider,
        value: patch.provider,
      });
      changes.set(keys.provider, value);
      // Another provider, Auto included, forgets the model and depth, which
      // belonged to the one before; the provider already chosen keeps them.
      if (value !== (choice.provider ?? OWN)) {
        for (const key of [keys.model, keys.pi, keys.effort]) {
          changes.set(key, OWN);
        }
        choice = parseChoice({
          effort: OWN,
          model: OWN,
          pi: OWN,
          provider: value,
        });
      }
    }
    const own = choice.provider;
    if (own === undefined) {
      const field = patch.model === undefined ? "effort" : "model";
      const value = patch.model ?? patch.effort;
      if (value !== undefined) {
        yield* refuse({ field, reason: "noProvider", value });
      }
    }
    if (patch.model !== undefined) {
      const rows = yield* modelChange({
        field: "model",
        fixed: optionsOn(choice).model,
        keys,
        pi: yield* lightPi(own),
        value: patch.model,
      });
      for (const [key, value] of rows) {
        changes.set(key, value);
      }
      // The depths on offer are the new model's.
      choice = parseChoice({
        effort: choice.effort,
        model: changes.get(keys.model) ?? choice.tier,
        pi: changes.get(keys.pi) ?? choice.piStored,
        provider: own,
      });
    }
    if (patch.effort !== undefined) {
      changes.set(
        keys.effort,
        yield* offeredOr({
          field: "effort",
          offered: optionsOn(choice).effort,
          value: patch.effort,
        })
      );
    }
    yield* write(changes);
  });

  // «Голосовые ответы» -----------------------------------------------------

  const readVoice = Effect.fn("SettingsService.readVoice")(function* () {
    const [voices, voice, model, gender] = yield* Effect.all([
      ports.voices,
      stored("tts_voice"),
      stored("tts_model"),
      stored("persona_gender"),
    ]);
    const current =
      voices.kind === "ready"
        ? pickVoice({
            gender: personaGenderOf(gender),
            stored: voice,
            voices: voices.voices,
          })
        : undefined;
    return {
      current,
      model: ttsModelOf(model),
      options: { model: TTS_MODELS },
      stored: voice,
      voices,
    };
  });

  const updateVoice = Effect.fn("SettingsService.updateVoice")(function* (
    patch: VoicePatch
  ) {
    const changes = new Map<SettingKey, string | null>();
    if (patch.model !== undefined) {
      changes.set(
        "tts_model",
        yield* offeredOr({
          field: "model",
          offered: TTS_MODELS,
          value: patch.model,
        })
      );
    }
    if (patch.voice !== undefined) {
      const voices = yield* ports.voices;
      const ids =
        voices.kind === "ready"
          ? voices.voices.map(({ id }) => id)
          : yield* refuse({
              field: "voice",
              reason: voices.kind === "off" ? "voicesOff" : "voicesFailed",
              value: patch.voice,
            });
      changes.set(
        "tts_voice",
        yield* offeredOr({ field: "voice", offered: ids, value: patch.voice })
      );
    }
    yield* write(changes);
  });

  // «Провайдеры» -----------------------------------------------------------

  const readProvider = Effect.fnUntraced(function* (provider: ProviderId) {
    const spec = PROVIDER_SETTINGS[provider];
    const values = decodeOwnerSettings(provider, yield* stored(spec.key));
    return {
      overridden: spec.overridden(),
      provider,
      settings: settingFields(provider).map(([key, control]) => ({
        control,
        key,
        value: values[key],
      })),
      values,
      version: spec.version,
    };
  });

  const readProviders = Effect.fn("SettingsService.readProviders")(
    function* () {
      return yield* Effect.forEach(PROVIDER_IDS, readProvider);
    }
  );

  const updateProvider = Effect.fn("SettingsService.updateProvider")(function* (
    provider: ProviderId,
    patch: ProviderPatch
  ) {
    const { settings, values } = yield* readProvider(provider);
    const next = new Map(Object.entries(values));
    for (const [key, value] of Object.entries(patch)) {
      const control =
        settingControl(provider, key) ??
        (yield* refuse({
          field: key,
          offered: settings.map((setting) => setting.key),
          reason: "unknownSetting",
          value: value === null ? "null" : String(value),
        }));
      if (value === null) {
        next.delete(key);
      } else if (settingValues(control).includes(value)) {
        next.set(key, value);
      } else {
        yield* refuse({
          field: key,
          offered: settingValues(control).map(String),
          reason: "notOffered",
          value: Predicate.isString(value) ? value : String(value),
        });
      }
    }
    yield* write(
      new Map([
        [
          PROVIDER_SETTINGS[provider].key,
          JSON.stringify(Object.fromEntries(next)),
        ],
      ])
    );
  });

  return {
    readBot,
    readHelpers,
    readLight,
    readMine,
    readProviders,
    readVoice,
    updateBot,
    updateHelper,
    updateLight,
    updateMine,
    updateProvider,
    updateVoice,
  } as const;
});

/** A failure a settings read or write can end in. */
export type SettingsFailure = PersistenceError | SettingRefused;

/**
 * Run one write for a grammy closure: undefined once stored, else the
 * refusal. A failed read or write rejects, for the caller to log.
 */
export type StoreSetting = (
  write: Effect.Effect<void, SettingsFailure>
) => Promise<SettingRefused | undefined>;

/**
 * The bot's settings, one service for every door (`/settings`, the HTTP
 * API). Built in the entrypoint over the runtime's tables and providers.
 */
export class SettingsService extends Context.Service<
  SettingsService,
  Effect.Success<typeof make>
>()("@workspace/telegram/SettingsService") {
  static readonly layer = Layer.effect(SettingsService, make);
}
