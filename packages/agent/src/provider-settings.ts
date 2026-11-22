import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { SettingsRepo } from "@workspace/db";
import type { SettingKey } from "@workspace/db";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { claudeBinOverridden } from "./claude-account";
import { PI_PINNED_VERSION } from "./pi-account";
import { PINNED_VERSIONS } from "./provider-settings.generated";
import type { CodexConfig } from "./provider-settings.generated";
import type { ProviderId } from "./types";

/**
 * The provider settings the owner may change from `/settings`: a curated
 * allowlist per provider, each key with the control that picks it, typed
 * against the pinned provider version (the Claude SDK's own `Settings`, the
 * generated `CodexConfig`). A key the next version drops or retypes fails
 * the typecheck right here, once `bun run provider-settings:sync` has
 * regenerated the types; until then the package's typecheck fails on the
 * stale versions (`--check`). Stored as one JSON object per provider in
 * `settings`, read per run and merged under what the bot forces, never over
 * it. Unset keeps the provider's own default.
 */

/** An on/off setting. */
interface Toggle {
  readonly kind: "toggle";
}

/** A setting with a few named values, one button each. */
interface Choice<V extends string> {
  readonly kind: "choice";
  readonly values: readonly V[];
}

/** A number picked from a ladder of presets, smallest first. */
interface Ladder<V extends number> {
  readonly kind: "ladder";
  readonly values: readonly V[];
}

/** The controls a value type allows: a boolean is a toggle, and so on. */
type ControlFor<V> =
  | (boolean extends V ? Toggle : never)
  | ([Extract<V, string>] extends [never] ? never : Choice<Extract<V, string>>)
  | ([Extract<V, number>] extends [never] ? never : Ladder<Extract<V, number>>);

export type SettingControl = Choice<string> | Ladder<number> | Toggle;

export type SettingValue = boolean | number | string;

const TOGGLE = { kind: "toggle" } as const satisfies Toggle;

/**
 * Claude settings the bot forces on every child (`claude-sdk.ts`): no hooks,
 * connectors, bundled skills, remote control, artifacts or auto memory, its
 * own deny list and workflows, transcripts kept for years, the model and
 * effort from the chat's own defaults. `settingSources: []`,
 * `strictMcpConfig`, the skills filter, the MCP servers and the sandbox are
 * options, not settings, and are just as fixed.
 */
const CLAUDE_LOCKED = [
  "autoDreamEnabled",
  "autoMemoryEnabled",
  "cleanupPeriodDays",
  "disableAllHooks",
  "disableArtifact",
  "disableBundledSkills",
  "disableClaudeAiConnectors",
  "disableRemoteControl",
  "effortLevel",
  "enableWorkflows",
  "model",
  "permissions",
  "sandbox",
] as const satisfies readonly NamedKeys<Settings>[];

/**
 * Codex keys the bot forces (`codex-thread.ts`, `codex-launch.ts`): the
 * sandbox (the run's posture), web search (the run's access), the model and
 * effort (the chat's own defaults). What else it writes holds no single
 * scalar and is never offered: `approval_policy` (always `never`),
 * `features`, `mcp_servers`, `skills` and `shell_environment_policy`.
 */
const CODEX_LOCKED = [
  "model",
  "model_reasoning_effort",
  "sandbox_mode",
  "web_search",
] as const satisfies readonly (keyof CodexConfig)[];

/**
 * The keys a type names, without its index signature: `Settings` has one,
 * which would let any key through and hide a key the SDK dropped.
 */
type NamedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : K]: T[K];
};

type ClaudeOpen = Exclude<NamedKeys<Settings>, (typeof CLAUDE_LOCKED)[number]>;

type CodexOpen = Exclude<keyof CodexConfig, (typeof CODEX_LOCKED)[number]>;

/**
 * Claude's allowlist. `outputStyle` names the built-in
 * styles of the pinned CLI (`Learning` asks the reader to write code, which
 * a chat cannot do); re-check them on a bump. Left out: `fastMode`, which
 * bills extra usage on every run, a guest's included; the thinking
 * switches, which the run's own `thinking` option overrides
 * (`claude-options.ts`); and `autoCompactEnabled`, since a kept session
 * would then grow until its context is full.
 */
/* oxlint-disable eslint/no-magic-numbers -- the ladders are menu data */
const CLAUDE_SETTINGS = {
  attribution: TOGGLE,
  autoCompactWindow: {
    kind: "ladder",
    values: [100_000, 200_000, 400_000, 1_000_000],
  },
  bashOutputMaxChars: {
    kind: "ladder",
    values: [4000, 30_000, 64_000, 128_000],
  },
  includeGitInstructions: TOGGLE,
  outputStyle: {
    kind: "choice",
    values: ["Concise", "Explanatory", "Proactive"],
  },
  promptCacheTtl: { kind: "choice", values: ["5m", "1h"] },
  subagentPromptCacheTtl: { kind: "choice", values: ["5m", "1h"] },
} as const satisfies {
  readonly [K in ClaudeOpen]?: ControlFor<NonNullable<Settings[K]>>;
};

/**
 * Codex's allowlist. Left out: `service_tier`, billed; `personality`, which
 * no longer selects a style since 0.162 (its feature is removed).
 */
const CODEX_SETTINGS = {
  model_auto_compact_token_limit: {
    kind: "ladder",
    values: [100_000, 150_000, 200_000, 300_000],
  },
  model_reasoning_summary: {
    kind: "choice",
    values: ["auto", "concise", "detailed", "none"],
  },
  model_verbosity: { kind: "choice", values: ["low", "medium", "high"] },
} as const satisfies {
  readonly [K in CodexOpen]?: ControlFor<NonNullable<CodexConfig[K]>>;
};

/**
 * Each provider's allowlist, the `settings` row it is stored in, and the CLI
 * version it was typed against. `overridden` says when runs start another
 * binary than that one (`CLAUDE_BIN`, `claudeExecutable`), whose settings
 * may differ; Codex runs always start the vendored one (`vendoredCodex`).
 */
export const PROVIDER_SETTINGS = {
  claude: {
    fields: CLAUDE_SETTINGS,
    key: "claude_settings",
    overridden: claudeBinOverridden,
    version: PINNED_VERSIONS.claudeCli,
  },
  codex: {
    fields: CODEX_SETTINGS,
    key: "codex_settings",
    overridden: () => false,
    version: PINNED_VERSIONS.codex,
  },
  // None offered yet: the menu leaves pi out.
  pi: {
    fields: {},
    key: "pi_settings",
    overridden: () => false,
    version: PI_PINNED_VERSION,
  },
} as const satisfies Record<
  ProviderId,
  {
    readonly fields: Readonly<Record<string, SettingControl>>;
    readonly key: SettingKey;
    readonly overridden: () => boolean;
    readonly version: string;
  }
>;

/**
 * The owner's values for one provider, keyed by setting. Only a value its
 * setting's control offers ever gets in (`decodeOwnerSettings`), so they
 * spread into `Settings` or Codex's config as they are.
 */
export type OwnerSettings = Readonly<Record<string, SettingValue>>;

/** One provider's settings as the menu lists them, in order. */
export const settingFields = (provider: ProviderId) => {
  const fields: Readonly<Record<string, SettingControl>> =
    PROVIDER_SETTINGS[provider].fields;
  return Object.entries(fields);
};

/** The control of `key` for `provider`, or undefined when it is not offered. */
export const settingControl = (provider: ProviderId, key: string) =>
  settingFields(provider).find(([known]) => known === key)?.[1];

/** Every value `control` offers, in order. */
export const settingValues = (
  control: SettingControl
): readonly SettingValue[] =>
  control.kind === "toggle" ? [true, false] : control.values;

/** Whether `value` is one `control` offers now. */
const offers = (control: SettingControl, value: SettingValue) =>
  settingValues(control).includes(value);

/** A stored row: a JSON object of scalars; anything else reads as empty. */
const decodeRow = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

const decodeValue = Schema.decodeUnknownOption(
  Schema.Union([Schema.Boolean, Schema.Number, Schema.String])
);

/**
 * The stored row of `provider` as values the allowlist offers now. A row
 * that is not a JSON object reads as empty; an unknown or locked key, or a
 * value its control no longer offers, is dropped on its own, so a stale row
 * never breaks a run.
 */
export const decodeOwnerSettings = (
  provider: ProviderId,
  raw: string | undefined
): OwnerSettings => {
  const row = Option.getOrElse(decodeRow(raw), () => ({}));
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, stored]) => {
      const control = settingControl(provider, key);
      const value = Option.getOrUndefined(decodeValue(stored));
      return control !== undefined &&
        value !== undefined &&
        offers(control, value)
        ? [[key, value] as const]
        : [];
    })
  );
};

const make = Effect.gen(function* make() {
  const repo = yield* Effect.serviceOption(SettingsRepo);
  const read = Effect.fnUntraced(function* (provider: ProviderId) {
    const stored = Option.isNone(repo)
      ? Option.none()
      : yield* repo.value
          .get(PROVIDER_SETTINGS[provider].key)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Provider settings read failed", error).pipe(
                Effect.as(Option.none())
              )
            )
          );
    return decodeOwnerSettings(provider, Option.getOrUndefined(stored));
  });
  return { read } as const;
});

/**
 * A reader of the owner's settings, built with the settings table the
 * runtime holds. Each `read` reads `provider`'s row for one run. With no table
 * (a test runtime) or a failed read, the provider's defaults: a run is never
 * refused over them.
 */
export class OwnerSettingsReader extends Context.Service<
  OwnerSettingsReader,
  Effect.Success<typeof make>
>()("@workspace/agent/OwnerSettingsReader") {
  static readonly layer = Layer.effect(OwnerSettingsReader, make);
}
