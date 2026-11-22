import {
  decodeProviderId,
  isModelTier,
  isRoutedEffort,
  orderedSnapshots,
  ROUTED_EFFORTS,
  tierModel,
} from "@workspace/agent";
import type { Choice } from "@workspace/agent";
import type { RunChoicePatch, TaskEntry } from "@workspace/db";
import { Option } from "effect";
import { InlineKeyboard } from "grammy";

import { t } from "../i18n";
import { intendedProvider } from "../tasks/prompt-run";
import { escapeHtml } from "../telegram/format";
import { effectiveProviders } from "./agent-bridge";
import { nameOf } from "./provider";
import { addPickRows, pickRows, tierChoices } from "./settings-defaults";

/**
 * The «Модель» screen of one prompt task in `/tasks`: the provider, model
 * tier and effort it runs on, each a row that opens a picker in the same
 * message. Each starts on «Как в настройках», which follows the writer's
 * `/settings` defaults at every fire; a choice here wins over them for this
 * task alone. Callback data is `taskpick:<id>[:<field>[:<value>]]`.
 */

const TASK_PICK_FIELDS = ["effort", "model", "provider"] as const;

type TaskPickField = (typeof TASK_PICK_FIELDS)[number];

export const TASK_PICK_RE =
  /^taskpick:(?<id>\d+)(?::(?<field>back|effort|model|provider)(?::(?<value>[a-z]+))?)?$/u;

/** A picker's field from callback data; anything else is the screen itself. */
export const parseTaskPickField = (raw: string | undefined) =>
  TASK_PICK_FIELDS.find((field) => field === raw);

/** The first row of every picker: follow the writer's defaults. */
const FOLLOW = "auto";

const callbackData = (
  id: number,
  field: TaskPickField | "back",
  value?: string
) =>
  value === undefined
    ? `taskpick:${id}:${field}`
    : `taskpick:${id}:${field}:${value}`;

/** The task as the screen shows it, with the provider its rows describe. */
export const readTaskPickView = async (task: TaskEntry, ownerId: number) => {
  const providers = effectiveProviders();
  return {
    // The provider the model rows are named for: the one the task is meant
    // for, which a fire falls back from while it is down.
    provider: await intendedProvider(task, ownerId),
    providers,
    task,
  };
};

export type TaskPickView = Awaited<ReturnType<typeof readTaskPickView>>;

/** One picker: what it lists, which entry is marked, its prompt, its column. */
interface FieldSpec {
  readonly choices: (view: TaskPickView) => readonly Choice[];
  readonly current: (view: TaskPickView) => string | undefined;
  readonly patch: (value: string | null) => RunChoicePatch;
  readonly text: (view: TaskPickView) => string;
}

const follow = (): Choice => ({ id: FOLLOW, label: t().tasks.pick.follow });

const FIELDS = {
  effort: {
    choices: () => [
      follow(),
      ...ROUTED_EFFORTS.map((id) => ({ id, label: t().model.efforts[id] })),
    ],
    current: ({ task }) =>
      isRoutedEffort(task.effortLevel) ? task.effortLevel : undefined,
    patch: (value) => ({ effortLevel: value }),
    text: (view) => t().tasks.pick.pickEffort(nameOf(view.provider)),
  },
  model: {
    choices: (view) => [follow(), ...tierChoices(view.provider)],
    // The tier the task runs on there: one the provider does not offer is
    // clamped to the nearest it does, as the fire clamps it.
    current: ({ provider, task }) => {
      const slug = isModelTier(task.modelTier)
        ? tierModel(provider, task.modelTier)
        : undefined;
      return slug === undefined
        ? undefined
        : tierChoices(provider).find((tier) => tier.slug === slug)?.id;
    },
    patch: (value) => ({ modelTier: value }),
    text: (view) => t().tasks.pick.pickModel(nameOf(view.provider)),
  },
  provider: {
    // Every ready provider, and the task's own even while it cannot run,
    // marked so.
    choices: (view) => [
      follow(),
      ...orderedSnapshots(view.providers.snapshots)
        .filter(
          ({ id, status }) => status === "ready" || id === view.task.provider
        )
        .map(({ id, status }) => ({
          id,
          label:
            status === "ready"
              ? nameOf(id)
              : t().settings.defaults.down(
                  nameOf(id),
                  t().provider.menu.notReady[status]
                ),
        })),
    ],
    current: ({ task }) =>
      Option.getOrUndefined(decodeProviderId(task.provider)),
    patch: (value) => ({ provider: value }),
    text: () => t().tasks.pick.pickProvider,
  },
} as const satisfies Record<TaskPickField, FieldSpec>;

/** What a row shows: the choice's name, or what following the defaults gives now. */
const rowValue = (field: TaskPickField, view: TaskPickView) => {
  const current = FIELDS[field].current(view);
  if (current === undefined) {
    return field === "provider"
      ? t().tasks.pick.followNow(nameOf(view.provider))
      : t().tasks.pick.follow;
  }
  const tier = tierChoices(view.provider).find(({ id }) => id === current);
  if (field === "model" && tier !== undefined) {
    return tier.name;
  }
  return (
    FIELDS[field].choices(view).find(({ id }) => id === current)?.label ??
    current
  );
};

/** The screen: the task, its three rows and the way back to it. */
export const renderTaskPick = (view: TaskPickView) => {
  const { id } = view.task;
  const keyboard = addPickRows(
    new InlineKeyboard(),
    pickRows({
      callback: (field) => callbackData(id, field),
      value: (field) => rowValue(field, view),
    })
  ).text(t().settings.defaults.back, callbackData(id, "back"));
  return {
    keyboard,
    text: `<b>#${view.task.id} ${escapeHtml(view.task.title)}</b>\n\n${escapeHtml(t().tasks.pick.hint)}`,
  };
};

/** The text and keyboard of the picker for `field`. */
export const renderTaskPicker = (field: TaskPickField, view: TaskPickView) => {
  const spec = FIELDS[field];
  const current = spec.current(view) ?? FOLLOW;
  const keyboard = new InlineKeyboard();
  for (const choice of spec.choices(view)) {
    const mark = choice.id === current ? "✓ " : "";
    keyboard
      .text(
        `${mark}${choice.label}`,
        callbackData(view.task.id, field, choice.id)
      )
      .row();
  }
  keyboard.text(t().settings.defaults.back, `taskpick:${view.task.id}`);
  return { keyboard, text: spec.text(view) };
};

/** The value a field holds on the row, before any clamping. */
const storedValue = (field: TaskPickField, task: TaskEntry) => {
  const stored = {
    effort: task.effortLevel,
    model: task.modelTier,
    provider: task.provider,
  } as const;
  return stored[field];
};

/**
 * The edit a press makes, when its value is one the picker offers now:
 * none for the value already chosen, else the column, which «Как в
 * настройках» clears. The repository drops the routed pick with it, so the
 * next fire decides again.
 */
export const taskPickPatch = (input: {
  field: TaskPickField;
  value: string;
  view: TaskPickView;
}): { patch?: RunChoicePatch } | undefined => {
  const spec = FIELDS[input.field];
  if (!spec.choices(input.view).some(({ id }) => id === input.value)) {
    return undefined;
  }
  // Against what is stored, not what is shown: a tier the provider clamps
  // shows as the one it runs on, and pressing that one still pins it.
  if ((storedValue(input.field, input.view.task) ?? FOLLOW) === input.value) {
    return {};
  }
  return { patch: spec.patch(input.value === FOLLOW ? null : input.value) };
};
