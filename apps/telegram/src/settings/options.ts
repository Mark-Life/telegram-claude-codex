import {
  getEffortLevelsFor,
  getModels,
  orderedSnapshots,
  piLightModel,
  ROUTED_EFFORTS,
  servesOneTurn,
} from "@workspace/agent";
import type {
  EffectiveProviders,
  OneTurnUse,
  ProviderId,
} from "@workspace/agent";
import type { ModelTier } from "@workspace/env/bot";

import { AUTO, PROVIDER_DEFAULT } from "../handlers/chat-defaults";
import { isRoutable } from "../handlers/model-route";

/**
 * Which values each model choice of the settings offers now, as values, never
 * labels: «Мои настройки» (a person's new-chat defaults), «Группы и гости»
 * (light runs) and «Служебные проходы» (each helper pass). `SettingsService`
 * checks a write against these, and the `/settings` pickers draw their rows
 * from them, so a value one door takes the other takes too. On pi, which has
 * no tiers, a model is named outright from pi's list instead; that list is
 * the caller's, since the pickers show only a short part of it by index.
 */

/** The first row of a light or helper picker: the bot's own choice. */
export const OWN = "default";

/** The provider row that keeps nothing chosen, in «Мои настройки». */
export const NONE = "none";

/** Each tier `provider` runs, strongest first, as its `/model` lists them. */
export const tierIds = (provider: ProviderId): readonly ModelTier[] =>
  getModels(provider).flatMap((choice) =>
    choice.tier === undefined ? [] : [choice.tier]
  );

/** The providers ready now, in `PROVIDER_IDS` order. */
const readyIds = (providers: EffectiveProviders) =>
  orderedSnapshots(providers.snapshots)
    .filter(({ status }) => status === "ready")
    .map(({ id }) => id);

/** Auto where `provider` can be routed, then its own default. */
const leading = (provider: ProviderId) => [
  ...(isRoutable(provider) ? [AUTO] : []),
  PROVIDER_DEFAULT,
];

/**
 * «Мои настройки»: the provider (the detected one, every ready one and the
 * chosen one even while it cannot run, then nothing chosen), and the model
 * and effort on `provider`, the one new chats start on. A provider that went
 * down is offered but refused on write (`runnableNow`), so the door can say
 * why.
 */
export const defaultsOptions = (input: {
  chosen: ProviderId | undefined;
  provider: ProviderId;
  providers: EffectiveProviders;
}) => ({
  effort: [...leading(input.provider), ...ROUTED_EFFORTS],
  model: [...leading(input.provider), ...tierIds(input.provider)],
  provider: [
    AUTO,
    ...orderedSnapshots(input.providers.snapshots)
      .filter(({ id, status }) => status === "ready" || id === input.chosen)
      .map(({ id }) => id),
    NONE,
  ],
});

/**
 * «Группы и гости»: every ready provider after the bot's own, and the model
 * and effort on `provider`, the one light runs go to now.
 */
export const lightOptions = (input: {
  provider: ProviderId;
  providers: EffectiveProviders;
}) => ({
  effort: [OWN, ...ROUTED_EFFORTS],
  model: [OWN, ...tierIds(input.provider)],
  provider: [OWN, ...readyIds(input.providers)],
});

/**
 * One helper pass: Auto, every ready provider that serves it, and the stored
 * one while it is not ready; on a provider of the owner's own, its model and
 * the depths that model takes (on pi the one that will run, the light one
 * while none is named). On Auto there is no model or depth to pick.
 */
export const helperOptions = (input: {
  /** The model the pass names on `own`, as `ownModel` reads it. */
  model: string | undefined;
  own: ProviderId | undefined;
  providers: EffectiveProviders;
  use: OneTurnUse;
}) => {
  const { own } = input;
  const ready = readyIds(input.providers).filter((id) =>
    servesOneTurn(id, input.use)
  );
  const stored = own === undefined || ready.includes(own) ? [] : [own];
  if (own === undefined) {
    return { effort: [], model: [], provider: [OWN, ...ready] };
  }
  const levels = new Set(
    getEffortLevelsFor(
      own,
      own === "pi" ? piLightModel(input.model) : input.model
    ).map(({ id }) => id)
  );
  return {
    effort: [OWN, ...ROUTED_EFFORTS.filter((id) => levels.has(id))],
    model: [OWN, ...tierIds(own)],
    provider: [OWN, ...ready, ...stored],
  };
};
