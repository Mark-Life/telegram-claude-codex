import {
  AUTO_MODEL,
  decodeProviderId,
  DEFAULT_MODEL,
  isRoutedEffort,
  MODEL_TIERS,
} from "@workspace/agent";
import type { ModelTier, ProviderId, RoutedEffort } from "@workspace/agent";
import { SettingsRepo, UserSettingsRepo } from "@workspace/db";
import type { UserSettingKey } from "@workspace/db";
import { Effect, Option } from "effect";

import { logPersistenceError } from "../db/bridge";
import { runtime } from "../runtime";

/**
 * What one person's new conversations start on: a provider, a model and an
 * effort. Each person sets their own in `/settings`; a conversation already
 * running keeps what it runs on, and `/provider`, `/model` and `/effort`
 * change only the one they are sent in.
 *
 * The model and effort are the router's own terms, not a provider's: a tier
 * (each provider runs it on its own slug, `tierModel`) and a level of the
 * shared effort scale, so they keep their meaning when the provider changes
 * and never name a slug a provider has since dropped.
 *
 * A person who has set nothing starts where the bot always started: the
 * detected default provider, and the model router while the old bot-wide
 * `model_routing` switch is not `off`.
 */

/** A half left to the router. */
export const AUTO = AUTO_MODEL;

/** A half left to the provider's own default. */
export const PROVIDER_DEFAULT = DEFAULT_MODEL;

type ModelDefault = ModelTier | typeof AUTO | typeof PROVIDER_DEFAULT;

type EffortDefault = RoutedEffort | typeof AUTO | typeof PROVIDER_DEFAULT;

/** What a new conversation starts on, before a provider is known. */
export interface StartPick {
  effort: EffortDefault;
  model: ModelDefault;
  /** A model named outright per provider, which wins over `model` there. */
  models: Partial<Record<ProviderId, string>>;
}

/** The person's own pi model; `default` and anything unset are none. */
export const piModelOf = (stored: StoredSettings) => {
  const raw = stored.get("default_pi_model");
  return raw === undefined || raw === PROVIDER_DEFAULT ? undefined : raw;
};

/** One person's settings by key, as `UserSettingsRepo.all` reads them. */
export type StoredSettings = ReadonlyMap<UserSettingKey, string>;

const isTier = (value: string): value is ModelTier =>
  MODEL_TIERS.some((tier) => tier === value);

const parseModel = (raw: string | undefined): ModelDefault | undefined => {
  if (raw === AUTO || raw === PROVIDER_DEFAULT) {
    return raw;
  }
  return raw !== undefined && isTier(raw) ? raw : undefined;
};

const parseEffort = (raw: string | undefined): EffortDefault | undefined => {
  if (raw === AUTO || raw === PROVIDER_DEFAULT) {
    return raw;
  }
  return isRoutedEffort(raw) ? raw : undefined;
};

/**
 * What a person chose for the provider: nothing (unset: their conversations
 * start where they always did, and `/new` leaves the provider alone), "Авто"
 * (the detected default), or one provider.
 */
type ProviderChoice =
  | { readonly kind: "chosen"; readonly provider: ProviderId }
  | { readonly kind: "detected" }
  | { readonly kind: "unset" };

export const providerChoiceOf = (stored: StoredSettings): ProviderChoice => {
  const raw = stored.get("default_provider");
  if (raw === AUTO) {
    return { kind: "detected" };
  }
  return Option.match(decodeProviderId(raw), {
    onNone: (): ProviderChoice => ({ kind: "unset" }),
    onSome: (provider): ProviderChoice => ({ kind: "chosen", provider }),
  });
};

/**
 * The provider a person's new conversations start on, given the detected
 * default; none when they chose nothing.
 */
export const defaultProviderOf = (
  stored: StoredSettings,
  detected: ProviderId
) => {
  const choice = providerChoiceOf(stored);
  if (choice.kind === "chosen") {
    return choice.provider;
  }
  return choice.kind === "detected" ? detected : undefined;
};

/**
 * The model and effort a new conversation starts on. An unset half follows
 * the old bot-wide switch: `off` meant the provider's defaults, anything else
 * the router.
 */
export const startPickOf = (input: {
  routingOff: boolean;
  stored: StoredSettings;
}): StartPick => {
  const unset = input.routingOff ? PROVIDER_DEFAULT : AUTO;
  const pi = piModelOf(input.stored);
  return {
    effort: parseEffort(input.stored.get("default_effort")) ?? unset,
    model: parseModel(input.stored.get("default_model")) ?? unset,
    models: pi === undefined ? {} : { pi },
  };
};

/**
 * Everything one person has set, inside the runtime. A failed read is logged
 * and reads as nothing set, so a run never fails over a default.
 */
const storedDefaults = (userId: number) =>
  UserSettingsRepo.use((repo) => repo.all(userId)).pipe(
    Effect.tapError(logPersistenceError),
    Effect.orElseSucceed((): StoredSettings => new Map())
  );

/** Whether the old bot-wide switch turned the router off, inside the runtime. */
const legacyRoutingOff = SettingsRepo.use((repo) =>
  repo.get("model_routing")
).pipe(
  Effect.map((stored) => Option.getOrUndefined(stored) === "off"),
  Effect.tapError(logPersistenceError),
  Effect.orElseSucceed(() => false)
);

/**
 * One person's settings and start pick, inside the runtime; never fails.
 */
export const startPickFor = (userId: number) =>
  Effect.all([storedDefaults(userId), legacyRoutingOff]).pipe(
    Effect.map(([stored, routingOff]) => ({
      pick: startPickOf({ routingOff, stored }),
      stored,
    }))
  );

/**
 * `storedDefaults` for a grammy closure: never rejects, a failed read is
 * logged once and reads as nothing set.
 */
export const readUserSettings = async (userId: number) =>
  await runtime.runPromise(storedDefaults(userId));

/** `startPickFor` for a grammy closure; never rejects. */
export const readStartPick = async (userId: number) =>
  await runtime.runPromise(startPickFor(userId));
