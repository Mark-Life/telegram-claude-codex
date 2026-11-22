import {
  decodeOwnerSettings,
  PROVIDER_IDS,
  PROVIDER_SETTINGS,
  settingFields,
  settingValues,
} from "@workspace/agent";
import type {
  ProviderId,
  SettingControl,
  SettingValue,
} from "@workspace/agent";
import { Predicate } from "effect";
import { InlineKeyboard } from "grammy";

import { getSetting } from "../db/bridge";
import { t } from "../i18n";
import type { ProviderPatch, SettingRefused } from "../settings/service";
import { escapeHtml } from "../telegram/format";
import { nameOf } from "./provider";

/**
 * «Провайдеры» in the owner's `/settings`: Claude Code's and Codex's own
 * settings, from the allowlist in `@workspace/agent` (`provider-settings.ts`).
 * A provider's screen lists each setting with its value and what it does; a
 * row opens its picker in the same message: the provider's own default, then
 * every value the setting offers, each button carrying the value it sets.
 * Callback data is `pset:<provider>:<key>[:<value>]`, at most about 50
 * bytes; the screens themselves are `menu:prov[:<provider>]`.
 */

/** The value of a picker's first row: forget the setting. */
const UNSET = "unset";

/** The copy one control needs: a choice names each value, a ladder formats. */
type CopyFor<C> = C extends { readonly kind: "toggle" }
  ? { readonly hint: string; readonly label: string }
  : C extends {
        readonly kind: "choice";
        readonly values: readonly (infer V extends string)[];
      }
    ? {
        readonly hint: string;
        readonly label: string;
        readonly values: Readonly<Record<V, string>>;
      }
    : C extends { readonly kind: "ladder" }
      ? {
          readonly hint: string;
          readonly label: string;
          readonly value: (count: number) => string;
        }
      : never;

type Fields<P extends ProviderId> = (typeof PROVIDER_SETTINGS)[P]["fields"];

/** A locale's copy of one provider's settings, a key for each it offers. */
export type SettingsCopy<P extends ProviderId> = {
  readonly [K in keyof Fields<P>]: CopyFor<Fields<P>[K]>;
};

/** Any setting's copy, as the code reads it by key. */
interface AnyCopy {
  readonly hint: string;
  readonly label: string;
  readonly value?: (count: number) => string;
  readonly values?: Readonly<Record<string, string>>;
}

const copyOf = (provider: ProviderId, key: string): AnyCopy | undefined => {
  const all: Readonly<Record<string, AnyCopy>> =
    t().settings.providers[provider];
  return all[key];
};

const menuOf = (provider?: ProviderId) =>
  provider === undefined ? "menu:prov" : `menu:prov:${provider}`;

const callbackOf = (provider: ProviderId, key: string, value?: string) =>
  value === undefined
    ? `pset:${provider}:${key}`
    : `pset:${provider}:${key}:${value}`;

/** A value as its button carries it. */
const encode = (value: SettingValue) => {
  if (Predicate.isBoolean(value)) {
    return value ? "on" : "off";
  }
  return String(value);
};

/** One provider's stored settings, as the allowlist offers them now. */
const readStored = async (provider: ProviderId) =>
  decodeOwnerSettings(
    provider,
    await getSetting(PROVIDER_SETTINGS[provider].key)
  );

/** A value in the menu's words; unset is the provider's own default. */
const valueLabel = (input: {
  key: string;
  provider: ProviderId;
  value: SettingValue | undefined;
}) => {
  const copy = t().settings;
  const { value } = input;
  if (value === undefined) {
    return copy.providers.usual;
  }
  if (Predicate.isBoolean(value)) {
    return value ? copy.on : copy.off;
  }
  const own = copyOf(input.provider, input.key);
  if (Predicate.isNumber(value)) {
    return own?.value?.(value) ?? String(value);
  }
  return own?.values?.[value] ?? value;
};

/** The providers that offer any setting; one with none has no screen. */
const withSettings = () =>
  PROVIDER_IDS.filter((id) => settingFields(id).length > 0);

/** One line per provider: how many of its settings the owner changed. */
export const providerLines = async () =>
  await Promise.all(
    withSettings().map(async (id) =>
      t().settings.menu.providerLine(
        nameOf(id),
        Object.keys(await readStored(id)).length
      )
    )
  );

/** The providers screen: one row per provider, with what is changed. */
export const renderProviders = async () => {
  const copy = t().settings;
  const lines = await providerLines();
  const keyboard = new InlineKeyboard();
  for (const id of withSettings()) {
    keyboard.text(copy.menu.open(nameOf(id)), menuOf(id)).row();
  }
  keyboard.text(copy.defaults.back, "menu:home");
  return {
    keyboard,
    text: [
      `<b>${escapeHtml(copy.providers.title)}</b>`,
      escapeHtml(copy.providers.hint),
      escapeHtml(lines.join("\n")),
    ].join("\n\n"),
  };
};

/**
 * One provider's screen: the CLI version runs start, each setting with its
 * value and what it does, and what the bot never lets change.
 */
export const renderProvider = async (provider: ProviderId) => {
  const copy = t().settings;
  const spec = PROVIDER_SETTINGS[provider];
  const stored = await readStored(provider);
  const keyboard = new InlineKeyboard();
  const blocks: string[] = [];
  for (const [key] of settingFields(provider)) {
    const own = copyOf(provider, key);
    const label = own?.label ?? key;
    const value = valueLabel({ key, provider, value: stored[key] });
    keyboard.text(`${label}: ${value}`, callbackOf(provider, key)).row();
    blocks.push(
      `<b>${escapeHtml(`${label}: ${value}`)}</b>\n${escapeHtml(own?.hint ?? "")}`
    );
  }
  keyboard.text(copy.defaults.back, menuOf());
  const head = escapeHtml(
    copy.providers.version(nameOf(provider), spec.version)
  );
  return {
    keyboard,
    text: [
      `<b>${head}</b>`,
      ...(spec.overridden() ? [escapeHtml(copy.providers.overridden)] : []),
      escapeHtml(copy.providers.hint),
      ...blocks,
      escapeHtml(copy.providers.usualNote[provider]),
      escapeHtml(copy.providers.locked),
    ].join("\n\n"),
  };
};

/** The mark of the value in force. */
const mark = (on: boolean) => (on ? "✓ " : "");

/** The picker of one setting: its own default, then each value it offers. */
export const renderSettingPicker = async (input: {
  control: SettingControl;
  key: string;
  provider: ProviderId;
}) => {
  const { control, key, provider } = input;
  const copy = t().settings;
  const own = copyOf(provider, key);
  const stored = await readStored(provider);
  const current = stored[key];
  const keyboard = new InlineKeyboard()
    .text(
      `${mark(current === undefined)}${copy.providers.usualRow}`,
      callbackOf(provider, key, UNSET)
    )
    .row();
  for (const value of settingValues(control)) {
    keyboard
      .text(
        `${mark(current === value)}${valueLabel({ key, provider, value })}`,
        callbackOf(provider, key, encode(value))
      )
      .row();
  }
  keyboard.text(copy.defaults.back, menuOf(provider));
  return {
    keyboard,
    text: `<b>${escapeHtml(own?.label ?? key)}</b>\n\n${escapeHtml(own?.hint ?? "")}`,
  };
};

/** The value a button carries, read back; undefined when it is no value. */
const decode = (control: SettingControl, raw: string) => {
  const value = settingValues(control).find((known) => encode(known) === raw);
  return value === undefined ? undefined : { value };
};

/**
 * Store a press through `SettingsService` (`save`) when the setting offers
 * its value; `unset` forgets the setting. The next run of that provider
 * reads it; nothing running moves.
 */
export const applyProviderSetting = async (input: {
  control: SettingControl;
  key: string;
  raw: string;
  save: (patch: ProviderPatch) => Promise<SettingRefused | undefined>;
}) => {
  const { key, raw } = input;
  const picked = raw === UNSET ? { value: null } : decode(input.control, raw);
  if (picked === undefined) {
    return false;
  }
  return (await input.save({ [key]: picked.value })) === undefined;
};
