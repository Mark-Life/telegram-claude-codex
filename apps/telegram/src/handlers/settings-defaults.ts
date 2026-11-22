import {
  decodeProviderId,
  getModels,
  isRoutedEffort,
  loadPiModels,
  piDefaultModel,
  snapshotOf,
  tierModel,
} from "@workspace/agent";
import type { Choice, ModelTier, ProviderId } from "@workspace/agent";
import { Option } from "effect";
import { InlineKeyboard } from "grammy";

import { t } from "../i18n";
import { defaultsOptions, NONE } from "../settings/options";
import type { MinePatch, SettingRefused } from "../settings/service";
import { escapeHtml } from "../telegram/format";
import { effectiveProviders } from "./agent-bridge";
import {
  AUTO,
  piModelOf,
  providerChoiceOf,
  PROVIDER_DEFAULT,
  readStartPick,
} from "./chat-defaults";
import { modelLabel } from "./model-effort";
import {
  PI_GONE,
  piMarked,
  piPickerNote,
  piPickerRows,
  piPressed,
  piStoredPick,
} from "./pi-model-menu";
import { readPiRecents } from "./pi-recents";
import { nameOf } from "./provider";
import { startProviderOf } from "./route-provider";

/**
 * The "New chats" part of `/settings`, on its «Мои настройки» screen: one row
 * per default (provider, model, effort), each opening a picker in the same
 * message. Every button carries
 * the value it sets, so a press on a picker drawn before another change
 * still sets what its label promised. Callback data is
 * `defaults:new:<field>[:<value>]`; every value is a short word, or on pi a
 * model's index into the list in hand (`<version>_<index>`).
 */

const DEFAULTS_FIELDS = ["effort", "model", "provider"] as const;

type DefaultsField = (typeof DEFAULTS_FIELDS)[number];

/** A picker's field from callback data; anything else is the way back. */
export const parseDefaultsField = (raw: string | undefined) =>
  DEFAULTS_FIELDS.find((field) => field === raw);

/** The value of the provider picker's first row: the detected provider. */
const DETECTED = AUTO;

const callbackOf = (field: DefaultsField | "back", value?: string) =>
  value === undefined
    ? `defaults:new:${field}`
    : `defaults:new:${field}:${value}`;

/** One person's defaults as the menu shows them, read at once. */
export const readDefaultsView = async (viewer: {
  owner: boolean;
  userId: number;
}) => {
  const { pick, stored } = await readStartPick(viewer.userId);
  const providers = effectiveProviders();
  const choice = providerChoiceOf(stored);
  const provider = await startProviderOf({
    choice,
    detected: providers.default,
    owner: viewer.owner,
  });
  return {
    choice,
    chosen: choice.kind === "chosen" ? choice.provider : undefined,
    detected: providers.default,
    pi:
      provider === "pi"
        ? {
            list: await loadPiModels(),
            model: piModelOf(stored),
            recents: await readPiRecents(),
          }
        : undefined,
    pick,
    provider,
    providers,
    userId: viewer.userId,
  };
};

export type DefaultsView = Awaited<ReturnType<typeof readDefaultsView>>;

/** A tier's entry: its name in the picker, with what it is good for. */
interface TierChoice extends Choice {
  readonly name: string;
  readonly slug: string;
}

/** Each tier `provider` runs, strongest first, as its `/model` names it. */
export const tierChoices = (provider: ProviderId): readonly TierChoice[] =>
  getModels(provider).flatMap((choice) =>
    choice.tier === undefined
      ? []
      : [
          {
            id: choice.tier,
            label: modelLabel(choice),
            name: choice.label,
            slug: choice.id,
          },
        ]
  );

/** The values on offer now (`defaultsOptions`), for this view. */
const optionsOf = (view: DefaultsView) =>
  defaultsOptions({
    chosen: view.chosen,
    provider: view.provider,
    providers: view.providers,
  });

/** The name of Auto or the provider's own default, else undefined. */
const leadingLabel = (provider: ProviderId, id: string) => {
  const copy = t().settings.defaults;
  if (id === AUTO) {
    return copy.auto;
  }
  return id === PROVIDER_DEFAULT
    ? copy.providerDefault(nameOf(provider))
    : undefined;
};

/** The new-chats pi model as the picker sees it; «Как обычно» is pi's default. */
const piStored = (pi: NonNullable<DefaultsView["pi"]>) =>
  piStoredPick({ list: pi.list, stored: pi.model, usual: piDefaultModel() });

/** pi's picker rows past the default: a gone pick, then the short list. */
const piChoices = (pi: DefaultsView["pi"]): readonly Choice[] =>
  pi === undefined
    ? []
    : piPickerRows({
        list: pi.list,
        recents: pi.recents,
        separator: "_",
        stored: piStored(pi),
        usual: piDefaultModel(),
        withCustom: false,
      });

const modelChoices = (view: DefaultsView): readonly Choice[] => {
  const tiers = tierChoices(view.provider);
  return [
    ...optionsOf(view).model.map((id) => ({
      id,
      label:
        leadingLabel(view.provider, id) ??
        tiers.find((tier) => tier.id === id)?.label ??
        id,
    })),
    ...piChoices(view.pi),
  ];
};

const effortChoices = (view: DefaultsView): readonly Choice[] =>
  optionsOf(view).effort.map((id) => ({
    id,
    label:
      leadingLabel(view.provider, id) ??
      (isRoutedEffort(id) ? t().model.efforts[id] : id),
  }));

/** Why a provider cannot run now, in the provider menu's own words. */
const downReason = (view: DefaultsView, id: ProviderId) =>
  t().provider.menu.notReady[snapshotOf(view.providers.snapshots, id).status];

/**
 * The providers the provider picker offers: the detected one, then every
 * ready provider, and the chosen one even while it cannot run, marked so;
 * last, no choice at all.
 */
const providerChoices = (view: DefaultsView): readonly Choice[] =>
  optionsOf(view).provider.map((id) => {
    const copy = t().settings.defaults;
    if (id === AUTO) {
      return { id, label: copy.detected(nameOf(view.detected)) };
    }
    const provider = Option.getOrUndefined(decodeProviderId(id));
    if (provider === undefined) {
      return { id, label: copy.unsetRow };
    }
    const ready =
      snapshotOf(view.providers.snapshots, provider).status === "ready";
    return {
      id,
      label: ready
        ? nameOf(provider)
        : copy.down(nameOf(provider), downReason(view, provider)),
    };
  });

/**
 * The value a stored tier runs as: a tier the provider lacks runs on the
 * nearest one it has (`tierModel`), so that one is marked and named.
 */
const shownModel = (view: DefaultsView) => {
  const { model } = view.pick;
  if (view.pi !== undefined) {
    return piMarked({
      list: view.pi.list,
      separator: "_",
      stored: piStored(view.pi),
      usual: PROVIDER_DEFAULT,
    });
  }
  const tiers = tierChoices(view.provider);
  if (model === AUTO || model === PROVIDER_DEFAULT) {
    return model;
  }
  const slug = tierModel(view.provider, model satisfies ModelTier);
  return tiers.find((tier) => tier.slug === slug)?.id ?? PROVIDER_DEFAULT;
};

/** One picker: what it lists and marks, and its prompt. */
interface FieldSpec {
  readonly choices: (view: DefaultsView) => readonly Choice[];
  readonly current: (view: DefaultsView) => string;
  readonly text: (view: DefaultsView) => string;
}

const FIELDS = {
  effort: {
    choices: effortChoices,
    current: (view) => view.pick.effort,
    text: (view) => t().settings.defaults.pickEffort(nameOf(view.provider)),
  },
  model: {
    choices: modelChoices,
    current: shownModel,
    text: (view) => {
      const text = t().settings.defaults.pickModel(nameOf(view.provider));
      return view.pi === undefined
        ? text
        : `${text}\n\n${piPickerNote(view.pi)}`;
    },
  },
  provider: {
    choices: providerChoices,
    // Nothing chosen is its own row, not "Авто": `/new` then leaves the
    // provider alone.
    current: (view) =>
      view.chosen ?? (view.choice.kind === "detected" ? DETECTED : NONE),
    text: () => t().settings.defaults.pickProvider,
  },
} as const satisfies Record<DefaultsField, FieldSpec>;

/**
 * What a row shows for its current value: a tier by its model's plain name
 * (the hint stays in the picker), Auto on a provider that cannot be routed
 * as the provider's default it runs on.
 */
const rowValue = (field: DefaultsField, view: DefaultsView) => {
  if (field === "provider" && view.choice.kind === "unset") {
    return t().settings.defaults.unset;
  }
  const spec = FIELDS[field];
  const current = spec.current(view);
  const tier = tierChoices(view.provider).find(({ id }) => id === current);
  if (field === "model" && tier !== undefined) {
    return tier.name;
  }
  const choices = spec.choices(view);
  const shown = choices.some(({ id }) => id === current)
    ? current
    : PROVIDER_DEFAULT;
  return choices.find(({ id }) => id === shown)?.label ?? current;
};

/**
 * The provider, model and effort rows a settings screen shows (Новые беседы,
 * «Группы и гости»): each one's `Label: value` and the callback that opens
 * its picker.
 */
export const pickRows = (input: {
  callback: (field: DefaultsField) => string;
  value: (field: DefaultsField) => string;
}) => {
  const copy = t().settings.defaults;
  const rows = [
    ["provider", copy.provider],
    ["model", copy.model],
    ["effort", copy.effort],
  ] as const satisfies readonly (readonly [DefaultsField, string])[];
  return rows.map(([field, label]) => ({
    callback: input.callback(field),
    line: `${label}: ${input.value(field)}`,
  }));
};

/** `rows` added to `keyboard`, one per line. */
export const addPickRows = (
  keyboard: InlineKeyboard,
  rows: ReturnType<typeof pickRows>
) => {
  for (const { callback, line } of rows) {
    keyboard.text(line, callback).row();
  }
  return keyboard;
};

/** This person's three rows. */
export const defaultsRows = (view: DefaultsView) =>
  pickRows({ callback: callbackOf, value: (field) => rowValue(field, view) });

/**
 * What the rows do, told the way it works for the reader (an executor's
 * private chat outside a topic is shared and keeps its provider), as HTML.
 */
export const defaultsHint = (owner: boolean) => {
  const copy = t().settings.defaults;
  return escapeHtml(owner ? copy.hint : copy.hintExecutor);
};

/** The text and keyboard of the picker for `field`. */
export const renderPicker = (field: DefaultsField, view: DefaultsView) => {
  const spec = FIELDS[field];
  const current = spec.current(view);
  const keyboard = new InlineKeyboard();
  for (const choice of spec.choices(view)) {
    const mark = choice.id === current ? "✓ " : "";
    keyboard.text(`${mark}${choice.label}`, callbackOf(field, choice.id)).row();
  }
  keyboard.text(t().settings.defaults.back, callbackOf("back"));
  return { keyboard, text: spec.text(view) };
};

/**
 * Store a press on a picker through `SettingsService` (`save`), which checks
 * the value against what it offers now; else answer the toast to show. A
 * provider that went down since the picker was drawn says so. On pi a
 * button carries an index into the list in hand, read back here into the
 * model's name. Nothing running moves: a default is read only when a
 * conversation starts.
 */
export const applyDefault = async (input: {
  field: DefaultsField;
  save: (patch: MinePatch) => Promise<SettingRefused | undefined>;
  value: string;
  view: DefaultsView;
}) => {
  const { field, value, view } = input;
  const onPi = field === "model" && view.pi !== undefined;
  const pressed =
    onPi && view.pi !== undefined
      ? piPressed(view.pi.list, value)
      : ({ kind: "none" } as const);
  if (pressed.kind === "stale") {
    return { stored: false, toast: t().model.pi.staleSettings } as const;
  }
  if (onPi && value === PI_GONE) {
    return { stored: false, toast: t().model.pi.goneToast } as const;
  }
  const refused = await input.save({
    [field]: pressed.kind === "model" ? pressed.model.key : value,
  });
  if (refused === undefined) {
    return { stored: true } as const;
  }
  const down = decodeProviderId(refused.value);
  return {
    stored: false,
    toast:
      refused.reason === "providerDown" && Option.isSome(down)
        ? t().provider.unavailable(nameOf(down.value))
        : t().noSuchOption,
  } as const;
};
