import { loadPiModels, piLightList, piLightModel } from "@workspace/agent";
import type { Choice, PiModelList, ProviderId } from "@workspace/agent";
import { InlineKeyboard } from "grammy";

import { t } from "../i18n";
import { OWN } from "../settings/options";
import type { ChoicePatch, SettingRefused } from "../settings/service";
import type { LightChoice } from "./light-defaults";
import {
  PI_GONE,
  piMarked,
  piPickerRows,
  piPressed,
  piStoredPick,
} from "./pi-model-menu";
import { readPiRecents } from "./pi-recents";

/**
 * What the two light-model screens of `/settings` share, «Группы и гости»
 * (`settings-light.ts`) and «Служебные проходы» (`settings-helpers.ts`): pi's
 * list on a light model, the model picker's pi rows and mark, a picker's
 * keyboard, and storing a press. Each screen keeps its own fields, keys and
 * callback data.
 */

/** The first row of every picker: the bot's own, or the provider's usual. */
export { OWN } from "../settings/options";

/** pi's models as a light-model picker lists them. */
const readPiLists = async () => {
  const full = await loadPiModels();
  return { full, list: piLightList(full), recents: await readPiRecents() };
};

/** pi's models for a light-model picker, read only when `provider` is pi. */
export const readLightPi = async (provider: ProviderId | undefined) =>
  provider === "pi" ? await readPiLists() : undefined;

/** A screen's choice and pi's list in hand, as the model picker reads them. */
interface LightModelView {
  readonly choice: LightChoice;
  readonly pi: Awaited<ReturnType<typeof readLightPi>>;
}

/** The pi model as the picker sees it; «Как обычно» is pi's light model. */
const piStored = (choice: LightChoice, pi: NonNullable<LightModelView["pi"]>) =>
  piStoredPick({
    list: pi.list,
    stored: choice.piStored,
    usual: piLightModel(),
  });

/** pi's rows past «Как обычно»: a gone pick, then the short list. */
export const piChoices = ({ choice, pi }: LightModelView): readonly Choice[] =>
  pi === undefined
    ? []
    : piPickerRows({
        list: pi.list,
        recents: pi.recents,
        separator: "_",
        stored: piStored(choice, pi),
        usual: piLightModel(),
        withCustom: false,
      });

/** The marked model: pi's own pick, else the tier, else the usual. */
export const currentModel = ({ choice, pi }: LightModelView) =>
  pi === undefined
    ? (choice.tier ?? OWN)
    : piMarked({
        list: pi.list,
        separator: "_",
        stored: piStored(choice, pi),
        usual: OWN,
      });

/**
 * A picker's text and keyboard: a row per choice, the current one marked,
 * each carrying `data(id)`, then the way back.
 */
export const renderChoicePicker = (input: {
  back: string;
  choices: readonly Choice[];
  current: string;
  data: (id: string) => string;
  text: string;
}) => {
  const keyboard = new InlineKeyboard();
  for (const choice of input.choices) {
    const mark = choice.id === input.current ? "✓ " : "";
    keyboard.text(`${mark}${choice.label}`, input.data(choice.id)).row();
  }
  keyboard.text(t().settings.defaults.back, input.back);
  return { keyboard, text: input.text };
};

/**
 * Store a press through `SettingsService` (`save`), which checks it against
 * what the setting offers now; else answer the toast to show. `pi` is set on
 * a model picker with pi's list in hand: a button there carries an index into
 * it, read back here into the model's name. The next run reads it; nothing
 * running moves.
 */
export const applyChoice = async (input: {
  field: keyof ChoicePatch;
  pi: PiModelList | undefined;
  save: (patch: ChoicePatch) => Promise<SettingRefused | undefined>;
  value: string;
}) => {
  const { pi, value } = input;
  const pressed =
    pi === undefined ? ({ kind: "none" } as const) : piPressed(pi, value);
  if (pressed.kind === "stale") {
    return { stored: false, toast: t().model.pi.staleSettings } as const;
  }
  if (pi !== undefined && value === PI_GONE) {
    return { stored: false, toast: t().model.pi.goneToast } as const;
  }
  const refused = await input.save({
    [input.field]: pressed.kind === "model" ? pressed.model.key : value,
  });
  return refused === undefined
    ? ({ stored: true } as const)
    : ({ stored: false, toast: t().noSuchOption } as const);
};
