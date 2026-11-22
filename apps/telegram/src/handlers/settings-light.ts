import { decodeProviderId, isRoutedEffort } from "@workspace/agent";
import type { Choice } from "@workspace/agent";
import { Option } from "effect";

import { t } from "../i18n";
import { lightOptions } from "../settings/options";
import type { ChoicePatch, SettingRefused } from "../settings/service";
import { effectiveProviders } from "./agent-bridge";
import { readLightChoice } from "./light-defaults";
import {
  applyChoice,
  currentModel,
  OWN,
  piChoices,
  readLightPi,
  renderChoicePicker,
} from "./light-picker";
import { piPickerNote } from "./pi-model-menu";
import { nameOf } from "./provider";
import { pickRows, tierChoices } from "./settings-defaults";

/**
 * The «Группы и гости» screen of the owner's `/settings`, under «Настройки
 * бота»: what every light run runs on, and the title and format helper
 * passes while they are on Auto (`light-defaults.ts`); where each pass runs
 * now is on «Служебные проходы» (`settings-helpers.ts`). One row
 * per setting, each opening a picker in the same message, every button
 * carrying the value it sets. Callback data is `light:<field>[:<value>]`;
 * on pi a model's value is its index into the list in hand.
 */

const LIGHT_FIELDS = ["effort", "model", "provider"] as const;

type LightField = (typeof LIGHT_FIELDS)[number];

/** A picker's field from callback data; anything else is the way back. */
export const parseLightField = (raw: string | undefined) =>
  LIGHT_FIELDS.find((field) => field === raw);

const callbackOf = (field: LightField | "back", value?: string) =>
  value === undefined ? `light:${field}` : `light:${field}:${value}`;

/** The light choice as the menu shows it, read at once. */
export const readLightView = async () => {
  const choice = await readLightChoice();
  const providers = effectiveProviders();
  // The model and effort lists are the provider light runs go to now.
  const provider = choice.provider ?? providers.light;
  return { choice, pi: await readLightPi(provider), provider, providers };
};

export type LightView = Awaited<ReturnType<typeof readLightView>>;

/** One picker: what it lists and marks, and its prompt. */
interface FieldSpec {
  readonly choices: (view: LightView) => readonly Choice[];
  readonly current: (view: LightView) => string;
  readonly text: (view: LightView) => string;
}

/** The values on offer now (`lightOptions`), for this view. */
const optionsOf = (view: LightView) =>
  lightOptions({ provider: view.provider, providers: view.providers });

const FIELDS = {
  effort: {
    choices: (view) =>
      optionsOf(view).effort.map((id) => ({
        id,
        label: isRoutedEffort(id)
          ? t().model.efforts[id]
          : t().settings.light.usual,
      })),
    current: (view) => view.choice.effort ?? OWN,
    text: (view) => t().settings.light.pickEffort(nameOf(view.provider)),
  },
  model: {
    choices: (view) => {
      const tiers = tierChoices(view.provider);
      return [
        ...optionsOf(view).model.map((id) => ({
          id,
          label:
            tiers.find((tier) => tier.id === id)?.label ??
            t().settings.light.usual,
        })),
        ...piChoices(view),
      ];
    },
    current: currentModel,
    text: (view) => {
      const text = t().settings.light.pickModel(nameOf(view.provider));
      return view.pi === undefined
        ? text
        : `${text}\n\n${piPickerNote(view.pi)}`;
    },
  },
  provider: {
    choices: (view) =>
      optionsOf(view).provider.map((id) => {
        const provider = Option.getOrUndefined(decodeProviderId(id));
        return {
          id,
          label:
            provider === undefined
              ? t().settings.defaults.detected(nameOf(view.providers.light))
              : nameOf(provider),
        };
      }),
    current: (view) => view.choice.provider ?? OWN,
    text: () => t().settings.light.pickProvider,
  },
} as const satisfies Record<LightField, FieldSpec>;

/** What a row shows: the marked choice's name, a tier without its hint. */
const rowValue = (field: LightField, view: LightView) => {
  const spec = FIELDS[field];
  const current = spec.current(view);
  const tier = tierChoices(view.provider).find(({ id }) => id === current);
  if (field === "model" && tier !== undefined) {
    return tier.name;
  }
  return spec.choices(view).find(({ id }) => id === current)?.label ?? current;
};

/** The three rows of light runs. */
export const lightRows = (view: LightView) =>
  pickRows({ callback: callbackOf, value: (field) => rowValue(field, view) });

/** The text and keyboard of the picker for `field`. */
export const renderLightPicker = (field: LightField, view: LightView) => {
  const spec = FIELDS[field];
  return renderChoicePicker({
    back: callbackOf("back"),
    choices: spec.choices(view),
    current: spec.current(view),
    data: (id) => callbackOf(field, id),
    text: spec.text(view),
  });
};

/**
 * Store a press through `SettingsService`; else answer the toast to show
 * (`applyChoice`). The next light run reads it.
 */
export const applyLight = async (input: {
  field: LightField;
  save: (patch: ChoicePatch) => Promise<SettingRefused | undefined>;
  value: string;
  view: LightView;
}) =>
  await applyChoice({
    field: input.field,
    pi: input.field === "model" ? input.view.pi?.list : undefined,
    save: input.save,
    value: input.value,
  });
