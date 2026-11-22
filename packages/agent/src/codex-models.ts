import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { MODEL_TIERS, parseTierModels } from "@workspace/env/bot";
import type { ModelTier, TierModels } from "@workspace/env/bot";
import { Option, Result, Schema } from "effect";

import { codexHome } from "./state-roots";
import { clampTier, TIERS_STRONGEST_FIRST } from "./tier-models";
import { AUTO_MODEL, ROUTED_EFFORTS } from "./types";
import type { Choice } from "./types";

/**
 * The slugs each routed tier may run on when `CODEX_TIER_MODELS` is unset,
 * newest first. A tier runs on the first one the account offers in
 * `~/.codex/models_cache.json`, since accounts differ: a ChatGPT Go login
 * lists no Sol or Astra and only GPT-5.6 Terra, while another account may
 * list GPT-6.2 Sol and Astra and GPT-6.1 Terra, or, on an older list, GPT-6.1
 * Sol and GPT-6 Astra. There is no Luna newer than GPT-6. Checked against
 * Codex 0.171's bundled catalog.
 */
export const DEFAULT_TIER_CANDIDATES = {
  astra: ["gpt-6.2-astra", "gpt-6-astra"],
  luna: ["gpt-6-luna"],
  sol: ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"],
  terra: ["gpt-6.1-terra", "gpt-5.6-terra"],
} as const satisfies Record<ModelTier, readonly [string, ...string[]]>;

/** Each tier's newest candidate: the map when there is no list to check. */
export const DEFAULT_TIER_MODELS = {
  astra: DEFAULT_TIER_CANDIDATES.astra[0],
  luna: DEFAULT_TIER_CANDIDATES.luna[0],
  sol: DEFAULT_TIER_CANDIDATES.sol[0],
  terra: DEFAULT_TIER_CANDIDATES.terra[0],
} as const satisfies Record<ModelTier, string>;

/**
 * `CODEX_TIER_MODELS` as a tier map, one slug per tier, or undefined when it
 * is unset or blank. A tier left out of it is absent, not defaulted. Read at
 * import like the rest of the codex module constants; a malformed value
 * throws here and fails `AppConfig` at boot with the same message.
 */
export const envTierModels = (raw?: string): TierModels | undefined => {
  const parsed = parseTierModels(raw, "CODEX_TIER_MODELS");
  if (Result.isFailure(parsed)) {
    throw new Error(parsed.failure);
  }
  return Option.getOrUndefined(parsed.success);
};

const ENV_TIER_MODELS = envTierModels(process.env.CODEX_TIER_MODELS);

/** The part of `models_cache.json` this module reads. */
const ModelsCache = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(Schema.Struct({ slug: Schema.String })),
  })
);

const decodeModelsCache = Schema.decodeUnknownOption(ModelsCache);

let slugsRead: { mtimeMs: number; slugs: ReadonlySet<string> } | undefined;

/**
 * The slugs the logged-in account offers, as Codex last cached them in
 * `$CODEX_HOME/models_cache.json`; reread when the file changes. Undefined
 * when the file is missing, unreadable or lists nothing: then nothing is
 * filtered, as before the list was read.
 */
export const offeredSlugs = (
  file = path.join(codexHome(), "models_cache.json")
): ReadonlySet<string> | undefined => {
  try {
    const { mtimeMs } = statSync(file);
    if (slugsRead?.mtimeMs !== mtimeMs) {
      const slugs = Option.match(
        decodeModelsCache(readFileSync(file, "utf-8")),
        {
          onNone: () => new Set<string>(),
          onSome: (cache) => new Set(cache.models.map(({ slug }) => slug)),
        }
      );
      slugsRead = { mtimeMs, slugs };
    }
    return slugsRead.slugs.size === 0 ? undefined : slugsRead.slugs;
  } catch {
    return undefined;
  }
};

/**
 * `tierMap` narrowed to the slugs `offered` lists, so a tier the account
 * does not run is absent and `clampTier` moves a pick to one it does. With
 * no list, or when none of the map is on it, the map stays whole: a stale
 * list must not leave the router with nothing to name.
 */
export const offeredTiers = (
  tierMap: TierModels,
  offered: ReadonlySet<string> | undefined
): TierModels => {
  if (offered === undefined) {
    return tierMap;
  }
  const kept: TierModels = {};
  for (const tier of MODEL_TIERS) {
    const slug = tierMap[tier];
    if (slug !== undefined && offered.has(slug)) {
      kept[tier] = slug;
    }
  }
  return Object.keys(kept).length === 0 ? tierMap : kept;
};

/**
 * The defaults against the account's list `offered`: each tier on its first
 * candidate the list offers, absent when it offers none. With no list, or
 * none of the candidates on it, each tier's newest candidate, for the same
 * reason as in `offeredTiers`.
 */
export const defaultTierModels = (
  offered?: ReadonlySet<string>
): TierModels => {
  if (offered === undefined) {
    return DEFAULT_TIER_MODELS;
  }
  const picked: TierModels = {};
  for (const tier of MODEL_TIERS) {
    const slug = DEFAULT_TIER_CANDIDATES[tier].find((candidate) =>
      offered.has(candidate)
    );
    if (slug !== undefined) {
      picked[tier] = slug;
    }
  }
  return Object.keys(picked).length === 0 ? DEFAULT_TIER_MODELS : picked;
};

/**
 * The tier map for the account's list `offered`: the env map narrowed to it
 * when `CODEX_TIER_MODELS` is set (`env`), the defaults' pick otherwise.
 */
export const tierModelsFor = (
  offered: ReadonlySet<string> | undefined,
  env: TierModels | undefined = ENV_TIER_MODELS
): TierModels =>
  env === undefined ? defaultTierModels(offered) : offeredTiers(env, offered);

/**
 * The Codex provider's `tierModels`: the tier map for the logged-in
 * account's list. A ChatGPT login lists no Sol or Astra, so the router never
 * stores a slug every fire would fail on.
 */
export const codexTierModels = () => tierModelsFor(offeredSlugs());

/**
 * The cheapest slug on offer: light runs unless the owner picked another
 * light tier, and the judge, the formatter and topic titles unless the
 * owner picked a model for that pass (or, for the last two on Auto, a light
 * tier). The parser rejects an empty map, and neither `offeredTiers` nor
 * `defaultTierModels` empties one, so the fallback never fires.
 */
export const lunaModel = () =>
  clampTier(codexTierModels(), "luna") ?? DEFAULT_TIER_MODELS.luna;

/**
 * The reasoning efforts the bot offers, lightest first: the router's own
 * scale, typed against the SDK union so a level the SDK drops fails to
 * compile instead of being asserted through at runtime. `minimal` is gone: no
 * model this account offers accepts it any more. The order is what "one level
 * up" means to the router.
 */
export const EFFORT_LEVELS =
  ROUTED_EFFORTS satisfies readonly ModelReasoningEffort[];

/**
 * What every `light` run uses, whatever operators chose with /model: groups,
 * guests, members and Business replies need a quick answer, and the main model
 * costs the shared plan limit many times more per token. The model is
 * `lunaModel()`.
 */
export const LIGHT_EFFORT = "low" satisfies ModelReasoningEffort;

/** The Codex provider's `lightPick`: the light model at the light effort. */
export const codexLightPick = () =>
  ({ effort: LIGHT_EFFORT, model: lunaModel() }) as const;

/**
 * A tier's /model entry, named after the tier; a tier the account does not
 * offer gets none.
 */
const tierEntry = (tierMap: TierModels) => (tier: ModelTier) => {
  const id = tierMap[tier];
  const name = `${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
  return id === undefined ? [] : [{ id, label: name, tier }];
};

/** What `/model` offers on Codex: auto, then each tier this account runs. */
export const codexModels = (): readonly Choice[] => [
  { id: AUTO_MODEL, label: "Auto" },
  ...TIERS_STRONGEST_FIRST.flatMap(tierEntry(codexTierModels())),
];

/**
 * No slug of its own: a run with no pick leaves Codex's config default in
 * place, as it always has.
 */
export const codexDefaultModel = (): string | undefined => undefined;

/**
 * The tier a slug stands for: its slug in the env map, or any of its
 * built-in candidates, so a stored pick of an older candidate still counts.
 */
const tierOfSlug = (model: string) =>
  MODEL_TIERS.find(
    (tier) =>
      ENV_TIER_MODELS?.[tier] === model ||
      DEFAULT_TIER_CANDIDATES[tier].some((candidate) => candidate === model)
  );

/**
 * A stored slug as Codex runs it, against the account's list `offered`:
 * kept while the list offers it, and kept as stored with no list, since
 * Codex still serves retired tier slugs and reports an unknown one as a plain
 * run error. A tier's slug the account does not offer moves to the nearest
 * tier it does, any other one to the default. An empty slug is the default.
 */
export const resolveOffered = (
  model: string,
  offered: ReadonlySet<string> | undefined
) => {
  const tier = tierOfSlug(model);
  if (model === "" || offered === undefined || offered.has(model)) {
    return model === "" ? undefined : model;
  }
  return tier === undefined
    ? undefined
    : clampTier(tierModelsFor(offered), tier);
};

/** The Codex provider's `resolveStored`, against the account's list now. */
export const codexResolveStored = (model: string) =>
  resolveOffered(model, offeredSlugs());
