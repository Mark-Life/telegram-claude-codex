import {
  canRun,
  decodeProviderId,
  getProvider,
  isRoutedEffort,
  isRunnable,
  MODEL_TIERS,
  piLightModel,
  piRunsLight,
  servesOneTurn,
  snapshotOf,
  tierModel,
} from "@workspace/agent";
import type {
  EffectiveProviders,
  HelperPick,
  ModelTier,
  OneTurnUse,
  ProviderId,
  RunAccess,
} from "@workspace/agent";
import { Option } from "effect";

import { readCached } from "../bot-settings";
import type { CachedKey } from "../bot-settings";
import { logError } from "../log";
import { effectiveProviders } from "./agent-bridge";

/**
 * What every `light` run (groups, guests, members, Business replies) runs
 * on, the owner's choice in `/settings` («Группы и гости»): a provider, a
 * model tier and an effort level, bot-wide. Unset, `auto` and `default`
 * keep what the bot always did: the detected light provider and its own
 * light pick. The tier and level are the router's terms, so they hold on
 * whichever provider the run lands on; pi, which has no tiers, takes a model
 * by name (`light_pi_model`) instead. The provider and tier also decide
 * where the title and format helper passes run while the owner left them
 * on Auto (`autoHelper`).
 *
 * Each helper pass (`format`, `judge`, `title`) has its own choice too, under
 * «Служебные проходы» (`HELPER_KEYS`): a provider, and on it a model and a
 * depth. `helperFor` reads it first; the judge gets it through the app's
 * bridge (`handlers/address-judge.ts`).
 */

/** Where one choice is kept: its provider, model tier, depth and pi model. */
export type ChoiceKeys = Record<
  "effort" | "model" | "pi" | "provider",
  CachedKey
>;

/** Where each helper pass keeps its choice. */
export const HELPER_KEYS = {
  format: {
    effort: "helper_format_effort",
    model: "helper_format_model",
    pi: "helper_format_pi_model",
    provider: "helper_format_provider",
  },
  judge: {
    effort: "helper_judge_effort",
    model: "helper_judge_model",
    pi: "helper_judge_pi_model",
    provider: "helper_judge_provider",
  },
  title: {
    effort: "helper_title_effort",
    model: "helper_title_model",
    pi: "helper_title_pi_model",
    provider: "helper_title_provider",
  },
} as const satisfies Record<OneTurnUse, ChoiceKeys>;

const isTier = (value: string | undefined): value is ModelTier =>
  MODEL_TIERS.some((tier) => tier === value);

/** A stored choice as the menu and the resolvers read it. */
export const parseChoice = (stored: {
  effort: string | undefined;
  model: string | undefined;
  pi: string | undefined;
  provider: string | undefined;
}) => {
  const piStored =
    stored.pi === undefined || stored.pi === "default" ? undefined : stored.pi;
  const models: Partial<Record<ProviderId, string>> =
    piStored === undefined || !piRunsLight(piStored) ? {} : { pi: piStored };
  return {
    effort: isRoutedEffort(stored.effort) ? stored.effort : undefined,
    models,
    piStored,
    provider: Option.getOrUndefined(decodeProviderId(stored.provider)),
    tier: isTier(stored.model) ? stored.model : undefined,
  };
};

/** A stored choice, light or a helper pass's, as the screens read it. */
export type LightChoice = ReturnType<typeof parseChoice>;

const NO_CHOICE: LightChoice = {
  effort: undefined,
  models: {},
  piStored: undefined,
  provider: undefined,
  tier: undefined,
};

/** Where the light choice is kept, in the shape of `HELPER_KEYS`. */
export const LIGHT_KEYS = {
  effort: "light_effort",
  model: "light_model",
  pi: "light_pi_model",
  provider: "light_provider",
} as const satisfies ChoiceKeys;

/** A choice as stored under `keys` now; a failed read is no choice. */
const readChoice = async (keys: ChoiceKeys, failed: string) => {
  try {
    const [provider, model, effort, pi] = await Promise.all([
      readCached(keys.provider),
      readCached(keys.model),
      readCached(keys.effort),
      readCached(keys.pi),
    ]);
    return parseChoice({ effort, model, pi, provider });
  } catch (error) {
    logError(failed, error);
    return NO_CHOICE;
  }
};

/**
 * The owner's light choice as stored now; a failed read is no choice.
 * `piStored` is the pi model as stored, for the picker; `models` holds it
 * only while light runs can run it (`piRunsLight`), so a model keyed by the
 * owner's env alone falls back to the usual one.
 */
export const readLightChoice = async () =>
  await readChoice(
    LIGHT_KEYS,
    "Light settings read failed, using the bot's own"
  );

/**
 * The owner's choice for one helper pass as stored now, in the light
 * choice's shape; a failed read is no choice, which is Auto.
 */
export const readHelperChoice = async (use: OneTurnUse) =>
  await readChoice(HELPER_KEYS[use], "Helper settings read failed, using Auto");

/**
 * The owner's light provider while it can run and `fits` the work, else
 * undefined, with the owner's model choice.
 */
const ownerLightOf = (input: {
  fits: (id: ProviderId) => boolean;
  light: LightChoice;
  providers: EffectiveProviders;
}) => {
  const { models, provider, tier } = input.light;
  const usable =
    provider !== undefined &&
    isRunnable(snapshotOf(input.providers.snapshots, provider).status) &&
    input.fits(provider);
  return { chosen: usable ? provider : undefined, models, tier };
};

/**
 * The provider a light run with `access` goes to: the owner's choice while
 * it can run and can hold that run's posture (a member's writable scratch
 * needs what a guest's run does not), else the detected light provider. A
 * light run is never refused over this choice.
 */
export const lightProviderFor = async (access: RunAccess) => {
  const providers = effectiveProviders();
  const { chosen } = ownerLightOf({
    fits: (id) => canRun(getProvider(id).capabilities, access),
    light: await readLightChoice(),
    providers,
  });
  return chosen ?? providers.light;
};

/**
 * The model a helper choice names on `provider`: pi's by name, else the
 * tier's slug. Undefined keeps the provider's light model, which on pi is
 * `piLightModel()`.
 */
export const ownModel = (
  provider: ProviderId,
  choice: Pick<LightChoice, "models" | "tier">
) => {
  if (provider === "pi") {
    return choice.models.pi;
  }
  return choice.tier === undefined
    ? undefined
    : tierModel(provider, choice.tier);
};

/**
 * Where a helper pass runs on Auto, given the owner's light choice and the
 * snapshot. Titles and the format pass take the owner's light provider
 * while it can run and serves that pass, else the detected helper; the
 * owner's light model tier goes with them to whichever provider the pass
 * lands on, as it does for a light run, and the effort stays the pass's own,
 * low. The judge never followed the light choice: it stays on the detected
 * helper.
 */
export const autoHelperOf = (input: {
  light: LightChoice;
  providers: EffectiveProviders;
  use: OneTurnUse;
}) => {
  const { providers, use } = input;
  if (use === "judge") {
    return {
      helper: providers.helpers.judge,
      model: undefined,
    } satisfies HelperPick;
  }
  const { chosen, models, tier } = ownerLightOf({
    fits: (id) => servesOneTurn(id, use),
    light: input.light,
    providers,
  });
  const helper = chosen ?? providers.helpers[use];
  const model =
    helper === undefined ? undefined : ownModel(helper, { models, tier });
  return { helper, model } satisfies HelperPick;
};

/** `autoHelperOf` with the light choice stored now and the last snapshot. */
export const autoHelper = async (use: OneTurnUse) =>
  autoHelperOf({
    light: await readLightChoice(),
    providers: effectiveProviders(),
    use,
  });

/**
 * Whether a helper choice is pi with no model a helper can run
 * (`piLightModel`), which sends its pass to Auto.
 */
export const piChoiceStuck = (
  choice: Pick<LightChoice, "models" | "provider">
) => choice.provider === "pi" && piLightModel(choice.models.pi) === undefined;

/**
 * Where a helper pass runs: the owner's provider for it while that can run,
 * serves the pass and, on pi, has a model a helper can run (`piLightModel`),
 * with the owner's model and depth on it. Else Auto (`autoHelperOf`), and the
 * owner's model and depth are dropped with the provider. `own` is false on
 * Auto, which the overview marks.
 */
export const helperOf = (input: {
  choice: LightChoice;
  light: LightChoice;
  providers: EffectiveProviders;
  use: OneTurnUse;
}) => {
  const { choice, providers, use } = input;
  const { provider } = choice;
  const usable =
    provider !== undefined &&
    isRunnable(snapshotOf(providers.snapshots, provider).status) &&
    servesOneTurn(provider, use) &&
    !piChoiceStuck(choice);
  if (!usable) {
    return { own: false, pick: autoHelperOf(input) };
  }
  return {
    own: true,
    pick: {
      effort: choice.effort,
      helper: provider,
      model: ownModel(provider, choice),
    },
  };
};

/** `helperOf` with the choices stored now and the last snapshot. */
export const helperFor = async (use: OneTurnUse) => {
  const [choice, light] = await Promise.all([
    readHelperChoice(use),
    readLightChoice(),
  ]);
  return helperOf({ choice, light, providers: effectiveProviders(), use });
};
