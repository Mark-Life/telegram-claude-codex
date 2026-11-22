import {
  decodeProviderId,
  isRoutedEffort,
  ONE_TURN_USES,
  piLightModel,
  ROUTED_EFFORTS,
  snapshotOf,
} from "@workspace/agent";
import type { Choice, HelperPick, OneTurnUse } from "@workspace/agent";
import { Option } from "effect";

import { t } from "../i18n";
import { helperOptions } from "../settings/options";
import type { ChoicePatch, SettingRefused } from "../settings/service";
import { effectiveProviders } from "./agent-bridge";
import {
  autoHelper,
  helperFor,
  ownModel,
  piChoiceStuck,
  readHelperChoice,
} from "./light-defaults";
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
 * The «Служебные проходы» screens of the owner's `/settings`, under
 * «Настройки бота»: an overview of where each helper pass (`format`,
 * `judge`, `title`) runs now, and one screen per pass with what it runs on
 * (`light-defaults.ts`). On Auto a pass's screen has the provider row
 * alone: the model and depth apply only on the owner's own provider. Every
 * button carries the value it sets. Callback data is
 * `help:<use>:<field>[:<value>]`; on pi a model's value is its index into
 * the list in hand.
 */

const HELPER_FIELDS = ["effort", "model", "provider"] as const;

type HelperField = (typeof HELPER_FIELDS)[number];

/** A picker's field from callback data; anything else is the way back. */
export const parseHelperField = (raw: string | undefined) =>
  HELPER_FIELDS.find((field) => field === raw);

/** A helper pass from callback data, or undefined. */
export const parseHelperUse = (raw: string | undefined) =>
  ONE_TURN_USES.find((use) => use === raw);

const callbackOf =
  (use: OneTurnUse) => (field: HelperField | "back", value?: string) =>
    value === undefined
      ? `help:${use}:${field}`
      : `help:${use}:${field}:${value}`;

/** Where a helper pass runs, as the screens name it. */
const helperName = ({ helper, model }: HelperPick) => {
  if (helper === undefined) {
    return t().settings.light.noHelper;
  }
  return model === undefined ? nameOf(helper) : `${nameOf(helper)} (${model})`;
};

/** Whether a helper pass on pi has no model it can run (`piLightModel`). */
const piHelperStuck = ({ helper, model }: HelperPick) =>
  helper === "pi" && piLightModel(model) === undefined;

/**
 * One pass's choice as its screen shows it, read at once. The model and
 * depth lists belong to the owner's own provider alone.
 */
export const readHelperView = async (use: OneTurnUse) => {
  const [choice, auto] = await Promise.all([
    readHelperChoice(use),
    autoHelper(use),
  ]);
  return {
    auto,
    choice,
    pi: await readLightPi(choice.provider),
    providers: effectiveProviders(),
    use,
  };
};

type HelperView = Awaited<ReturnType<typeof readHelperView>>;

/** The values on offer now (`helperOptions`), for this view. */
const optionsOf = ({ choice, providers, use }: HelperView) =>
  helperOptions({
    model:
      choice.provider === undefined
        ? undefined
        : ownModel(choice.provider, choice),
    own: choice.provider,
    providers,
    use,
  });

/** The depths the owner's provider offers on the pass's model. */
const effortChoices = (view: HelperView): readonly Choice[] =>
  optionsOf(view).effort.map((id) => ({
    id,
    label: isRoutedEffort(id)
      ? t().model.efforts[id]
      : t().settings.light.usual,
  }));

/**
 * The providers on offer: Auto, every ready one that serves the pass, and
 * the stored one when it is not ready, saying why. A stored pi with no model
 * a helper can run says so too: the pass runs on Auto.
 */
const providerChoices = (view: HelperView): readonly Choice[] =>
  optionsOf(view).provider.map((id) => {
    const provider = Option.getOrUndefined(decodeProviderId(id));
    if (provider === undefined) {
      return {
        id,
        label: t().settings.helpers.auto(helperName(view.auto)),
      };
    }
    const { status } = snapshotOf(view.providers.snapshots, provider);
    if (status !== "ready") {
      return {
        id,
        label: t().settings.defaults.down(
          nameOf(provider),
          t().provider.menu.notReady[status]
        ),
      };
    }
    return {
      id,
      label:
        provider === view.choice.provider && piChoiceStuck(view.choice)
          ? t().settings.defaults.down(
              nameOf(provider),
              t().settings.helpers.noPiModel
            )
          : nameOf(provider),
    };
  });

/** One picker: what it lists and marks, and its prompt. */
interface FieldSpec {
  readonly choices: (view: HelperView) => readonly Choice[];
  readonly current: (view: HelperView) => string;
  readonly text: (view: HelperView) => string;
}

const useName = (view: HelperView) => t().settings.helpers.uses[view.use];

/** The owner's provider by name; the model and depth open only with one. */
const ownName = ({ choice: { provider: own } }: HelperView) =>
  own === undefined ? t().settings.light.noHelper : nameOf(own);

const FIELDS = {
  effort: {
    choices: effortChoices,
    current: (view) => view.choice.effort ?? OWN,
    text: (view) => {
      const text = t().settings.helpers.pickEffort(
        useName(view),
        ownName(view)
      );
      return effortChoices(view).length > 1
        ? text
        : `${text}\n\n${t().settings.helpers.noEffort}`;
    },
  },
  model: {
    choices: (view) => {
      const own = view.choice.provider;
      if (own === undefined) {
        return [];
      }
      const tiers = tierChoices(own);
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
      const text = t().settings.helpers.pickModel(useName(view), ownName(view));
      return view.pi === undefined
        ? text
        : `${text}\n\n${piPickerNote(view.pi)}`;
    },
  },
  provider: {
    choices: providerChoices,
    current: (view) => view.choice.provider ?? OWN,
    text: (view) => t().settings.helpers.pickProvider(useName(view)),
  },
} as const satisfies Record<HelperField, FieldSpec>;

/** What a row shows: the marked choice's name, a tier without its hint. */
const rowValue = (field: HelperField, view: HelperView) => {
  const spec = FIELDS[field];
  const current = spec.current(view);
  const own = view.choice.provider;
  const tier =
    own === undefined
      ? undefined
      : tierChoices(own).find(({ id }) => id === current);
  if (field === "model" && tier !== undefined) {
    return tier.name;
  }
  const effort = ROUTED_EFFORTS.find((id) => id === current);
  return (
    spec.choices(view).find(({ id }) => id === current)?.label ??
    (field === "effort" && effort !== undefined
      ? t().model.efforts[effort]
      : current)
  );
};

/** A pass's rows: the provider alone on Auto, else all three. */
export const helperRows = (view: HelperView) => {
  const dataOf = callbackOf(view.use);
  return pickRows({
    callback: dataOf,
    value: (field) => rowValue(field, view),
  }).filter(
    ({ callback }) =>
      view.choice.provider !== undefined || callback === dataOf("provider")
  );
};

/** The text and keyboard of the picker for `field`. */
export const renderHelperPicker = (field: HelperField, view: HelperView) => {
  const spec = FIELDS[field];
  const dataOf = callbackOf(view.use);
  return renderChoicePicker({
    back: dataOf("back"),
    choices: spec.choices(view),
    current: spec.current(view),
    data: (id) => dataOf(field, id),
    text: spec.text(view),
  });
};

/**
 * Store a press through `SettingsService`; else answer the toast to show
 * (`applyChoice`). On Auto the model and depth are not on offer. A press on
 * another provider, Auto included, forgets the pass's model and depth,
 * which belonged to the provider before; the provider already chosen keeps
 * them (the service does both). The next pass reads it; nothing running
 * moves.
 */
export const applyHelper = async (input: {
  field: HelperField;
  save: (patch: ChoicePatch) => Promise<SettingRefused | undefined>;
  value: string;
  view: HelperView;
}) =>
  await applyChoice({
    field: input.field,
    pi: input.field === "model" ? input.view.pi?.list : undefined,
    save: input.save,
    value: input.value,
  });

/**
 * Where each pass runs now: the overview's text, and a row per pass that
 * opens its screen. A pass on Auto says so, and one stuck on pi with no
 * model it can run says why, whether pi is the owner's pick or Auto's.
 */
export const helpersOverview = async () => {
  const copy = t().settings.helpers;
  const picks = await Promise.all(
    ONE_TURN_USES.map(async (use) => ({
      choice: await readHelperChoice(use),
      use,
      ...(await helperFor(use)),
    }))
  );
  const named = picks.map(({ own, pick, use }) => ({
    name: own ? helperName(pick) : `${helperName(pick)} (${copy.autoMark})`,
    use,
  }));
  const lines = [
    copy.now,
    ...named.map(({ name, use }) => `${copy.uses[use]} — ${name}`),
  ].join("\n");
  return {
    rows: named.map(({ name, use }) => ({
      callback: `menu:help:${use}`,
      line: `${copy.uses[use]}: ${name}`,
    })),
    text: picks.some(
      ({ choice, pick }) => piChoiceStuck(choice) || piHelperStuck(pick)
    )
      ? `${lines}\n\n${t().model.pi.noLight}`
      : lines,
  };
};
