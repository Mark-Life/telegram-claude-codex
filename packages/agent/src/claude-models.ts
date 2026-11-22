import { existsSync, readFileSync } from "node:fs";

import { writeJsonAtomic } from "@workspace/core/fs";
import { MODEL_TIERS, parseTierModels } from "@workspace/env/bot";
import type { ModelTier, TierModels } from "@workspace/env/bot";
import { dataPath } from "@workspace/env/paths";
import { Effect, Option, Result, Schema } from "effect";

import { claudeLog } from "./claude-log";
import { withIdleSession } from "./claude-sdk";
import { clampTier, TIERS_STRONGEST_FIRST } from "./tier-models";
import { AUTO_MODEL } from "./types";
import type { Choice, RoutedEffort } from "./types";

/**
 * The models this Claude account offers, as Claude Code itself lists them.
 * The list changes with the CLI, the plan and the org default, without a
 * deploy, so it is read from the CLI in the background (a session that never
 * sends a prompt answers it in about a second, no tokens) and kept in
 * `.data/claude-models.json` for the next boot. Until a list ever arrived,
 * the aliases below stand in. Routed tiers map onto families: Luna is Haiku,
 * Terra Sonnet, Sol Opus, Astra Fable, always as the alias's full id so a
 * stored pick never drifts.
 */

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

type ClaudeEffort = (typeof EFFORTS)[number];

const ModelRow = Schema.Struct({
  displayName: Schema.String,
  resolvedModel: Schema.optional(Schema.String),
  supportedEffortLevels: Schema.optional(
    Schema.Array(Schema.Literals(EFFORTS))
  ),
  supportsAdaptiveThinking: Schema.optional(Schema.Boolean),
  supportsEffort: Schema.optional(Schema.Boolean),
  value: Schema.String,
});

/** One row of the CLI's model list. */
type ClaudeModel = typeof ModelRow.Type;

const Catalogue = Schema.Struct({
  checkedAt: Schema.Number,
  models: Schema.Array(ModelRow),
});

type CatalogueData = typeof Catalogue.Type;

const decodeCatalogue = Schema.decodeUnknownOption(
  Schema.fromJsonString(Catalogue)
);
/** A live row: effort levels as text, since a newer CLI may add one. */
const LiveRow = Schema.Struct({
  ...ModelRow.fields,
  supportedEffortLevels: Schema.optional(Schema.Array(Schema.String)),
});

const decodeLiveRow = Schema.decodeUnknownOption(LiveRow);

const isClaudeEffort = (effort: string): effort is ClaudeEffort =>
  EFFORTS.some((level) => level === effort);

/**
 * A live row with only the effort levels this build knows, so one new level
 * drops the level, not the model. Logs what it dropped.
 */
const knownRow = (live: typeof LiveRow.Type) => {
  const { supportedEffortLevels, ...row } = live;
  if (supportedEffortLevels === undefined) {
    return row;
  }
  const known = supportedEffortLevels.filter(isClaudeEffort);
  if (known.length < supportedEffortLevels.length) {
    claudeLog(
      Effect.logWarning("claude model effort levels dropped").pipe(
        Effect.annotateLogs({
          dropped: supportedEffortLevels.filter(
            (level) => !isClaudeEffort(level)
          ),
          model: row.value,
        })
      )
    );
  }
  return { ...row, supportedEffortLevels: known };
};

const ALL_EFFORTS = [...EFFORTS];

/** The aliases as CLI 2.1.330 lists them; used until a live list arrives. */
const STATIC_MODELS: readonly ClaudeModel[] = [
  ["default", "claude-opus-5-5", "Default (recommended)"],
  ["opus", "claude-opus-5-5", "Opus 5.5"],
  ["fable", "claude-fable-5-2", "Fable 5.2"],
  ["sonnet", "claude-sonnet-5-5", "Sonnet 5.5"],
  ["haiku", "claude-haiku-5-5", "Haiku 5.5"],
].map(([value = "", resolvedModel = "", displayName = ""]) => ({
  displayName,
  resolvedModel,
  supportedEffortLevels: ALL_EFFORTS,
  supportsAdaptiveThinking: true,
  supportsEffort: true,
  value,
}));

/** The alias each routed tier follows. */
const TIER_ALIASES = {
  astra: "fable",
  luna: "haiku",
  sol: "opus",
  terra: "sonnet",
} as const satisfies Record<ModelTier, string>;

const CACHE_FILE = "claude-models.json";

/** How long one list request may take before it counts as failed. */
const PROBE_TIMEOUT_MS = 15_000;

const readCache = (): CatalogueData | undefined => {
  const file = dataPath(CACHE_FILE);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return Option.getOrUndefined(decodeCatalogue(readFileSync(file, "utf-8")));
  } catch {
    return undefined;
  }
};

let current: CatalogueData | undefined;

/** The list as last seen: the cache file on first read, else the aliases. */
const catalogue = () => {
  current ??= readCache() ?? { checkedAt: 0, models: STATIC_MODELS };
  return current;
};

/** The row a model id names, by its own id or by the alias it resolves from. */
export const claudeModelRow = (model: string | undefined) =>
  model === undefined
    ? undefined
    : catalogue().models.find(
        (row) => row.value === model || row.resolvedModel === model
      );

const isListed = (model: string) => claudeModelRow(model) !== undefined;

/** A tier's slug from the live list: its alias's full id. */
const familyTiers = () => {
  const tiers: TierModels = {};
  for (const tier of MODEL_TIERS) {
    const slug = catalogue().models.find(
      (row) => row.value === TIER_ALIASES[tier]
    )?.resolvedModel;
    if (slug !== undefined) {
      tiers[tier] = slug;
    }
  }
  return tiers;
};

const warned = new Set<string>();

/** `CLAUDE_TIER_MODELS` as set, parsed once; `AppConfig` fails boot on bad input. */
const ENV_TIER_MODELS = (() => {
  const parsed = parseTierModels(
    process.env.CLAUDE_TIER_MODELS,
    "CLAUDE_TIER_MODELS"
  );
  return Result.isSuccess(parsed)
    ? Option.getOrElse(parsed.success, (): TierModels => ({}))
    : {};
})();

/**
 * `CLAUDE_TIER_MODELS`, each slug checked against the live list, which can
 * change; one this account does not offer is logged once and dropped. Empty
 * when unset.
 */
const envTiers = () => {
  const tiers: TierModels = {};
  for (const [tier, slug] of Object.entries(ENV_TIER_MODELS)) {
    const known = MODEL_TIERS.find((name) => name === tier);
    if (known !== undefined && isListed(slug)) {
      tiers[known] = slug;
    } else if (!warned.has(slug)) {
      warned.add(slug);
      claudeLog(
        Effect.logWarning("CLAUDE_TIER_MODELS names a model not on offer", {
          slug,
          tier,
        })
      );
    }
  }
  return tiers;
};

/**
 * Each routed tier's slug: `CLAUDE_TIER_MODELS` when anything in it is on
 * offer (a tier it leaves out is absent), else by family.
 */
export const claudeTierModels = () => {
  const fromEnv = envTiers();
  return Object.keys(fromEnv).length === 0 ? familyTiers() : fromEnv;
};

/** The account's own default, as a full id. */
export const claudeDefaultModel = () =>
  catalogue().models.find((row) => row.value === "default")?.resolvedModel;

/**
 * The effort `model` runs at when `effort` is asked for: the level itself
 * when the model offers it, else the nearest lower one, else its lowest.
 * Undefined for a level Claude does not know or a model with no effort
 * setting; a model missing from the list takes the level as asked.
 */
export const claudeEffort = (
  model: string | undefined,
  effort: string | undefined
): ClaudeEffort | undefined => {
  if (effort === undefined || !isClaudeEffort(effort)) {
    return undefined;
  }
  const row = claudeModelRow(model);
  if (row === undefined) {
    return effort;
  }
  const levels = row.supportsEffort === true ? row.supportedEffortLevels : [];
  if (levels === undefined || levels.includes(effort)) {
    return effort;
  }
  const wanted = EFFORTS.indexOf(effort);
  const lower = levels.filter((level) => EFFORTS.indexOf(level) < wanted);
  return lower.at(-1) ?? levels[0];
};

/** The provider's `mapEffort`: a routed level onto what `model` offers. */
export const claudeMapEffort = (
  routed: RoutedEffort,
  model: string | undefined
) => claudeEffort(model, routed) ?? routed;

const FAMILY_RE = /^claude-(?<family>haiku|sonnet|opus|fable)-/u;

/**
 * A stored slug as Claude can run it now: kept while the list offers it,
 * else the current slug of its family's tier, else undefined (the default).
 */
export const claudeResolveStored = (model: string) => {
  if (isListed(model)) {
    return model;
  }
  const family = FAMILY_RE.exec(model)?.groups?.family;
  const tier = MODEL_TIERS.find((name) => TIER_ALIASES[name] === family);
  return tier === undefined ? undefined : claudeTierModels()[tier];
};

/** Light runs and helper turns: the Luna slug at low effort. */
export const claudeLightPick = () => {
  const model = clampTier(claudeTierModels(), "luna") ?? TIER_ALIASES.luna;
  return { effort: claudeEffort(model, "low"), model };
};

/** A tier's name in the menu: its alias row's, never the account default's. */
const tierLabel = (tier: ModelTier, slug: string) =>
  catalogue().models.find((row) => row.value === TIER_ALIASES[tier])
    ?.displayName ?? slug;

/**
 * What `/model` offers: auto, each tier strongest first, then every other
 * full id the account lists.
 */
export const claudeModels = (): readonly Choice[] => {
  const tiers = claudeTierModels();
  const tierChoices = TIERS_STRONGEST_FIRST.flatMap((tier) => {
    const slug = tiers[tier];
    return slug === undefined
      ? []
      : [{ id: slug, label: tierLabel(tier, slug), tier }];
  });
  const taken = new Set(tierChoices.map((choice) => choice.id));
  const others = catalogue()
    .models.filter(
      (row) => row.value.startsWith("claude-") && !taken.has(row.value)
    )
    .map((row) => ({ id: row.value, label: row.displayName }));
  return [{ id: AUTO_MODEL, label: "Auto" }, ...tierChoices, ...others];
};

/** Ask the CLI for its list: a session that is opened and closed unused. */
const fetchModels = async () =>
  await withIdleSession({
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    use: async (session) => {
      const init = await session.initializationResult();
      return init.models.flatMap((raw) => {
        const live = decodeLiveRow(raw);
        if (Option.isNone(live)) {
          claudeLog(Effect.logWarning("claude model row dropped: unreadable"));
          return [];
        }
        return [knownRow(live.value)];
      });
    },
  });

let inFlight: Promise<void> | undefined;

const refresh = async () => {
  try {
    const models = await fetchModels();
    if (models.length === 0) {
      throw new Error("the CLI listed no models");
    }
    const next: CatalogueData = { checkedAt: Date.now(), models };
    current = next;
    writeJsonAtomic(dataPath(CACHE_FILE), next);
    claudeLog(Effect.log("claude.models refreshed", { count: models.length }));
  } catch (error) {
    claudeLog(
      Effect.logWarning("claude.models refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
};

/**
 * Read the list again when the one in hand is older than `maxAgeMs`. A
 * failed read keeps the last good list. Never rejects; a second call while
 * one runs waits for it.
 */
export const refreshClaudeModels = async ({
  maxAgeMs,
}: {
  maxAgeMs: number;
}) => {
  if (Date.now() - catalogue().checkedAt < maxAgeMs) {
    return;
  }
  inFlight ??= (async () => {
    try {
      await refresh();
    } finally {
      inFlight = undefined;
    }
  })();
  await inFlight;
};
