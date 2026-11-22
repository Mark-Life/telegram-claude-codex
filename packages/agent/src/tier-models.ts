import type { ModelTier, TierModels } from "@workspace/env/bot";

import { MODEL_TIERS } from "./types";

/**
 * The slug for a tier, clamped to the nearest tier the map offers when it is
 * absent; a tie goes to the stronger side, since a run quietly downgraded by
 * a catalogue change is the worse failure of the two. Undefined only for an
 * empty map.
 */
export const clampTier = (tierModels: TierModels, tier: ModelTier) => {
  const wanted = MODEL_TIERS.indexOf(tier);
  // The tiers in the order this pick accepts them: the wanted one, then each
  // step outward with the stronger side of the pair first.
  const preference = MODEL_TIERS.flatMap((_unused, step) =>
    [MODEL_TIERS[wanted + step], MODEL_TIERS[wanted - step]].filter(
      (candidate) => candidate !== undefined
    )
  );
  return preference
    .map((candidate) => tierModels[candidate])
    .find((slug) => slug !== undefined);
};

/** The tiers as `/model` lists them, strongest first. */
export const TIERS_STRONGEST_FIRST = [
  "astra",
  "sol",
  "terra",
  "luna",
] as const satisfies readonly ModelTier[];
