import {
  AUTO_MODEL,
  findPiModel,
  PI_BIG_PROVIDER,
  piCustomModels,
  piFavourites,
  searchPiModels,
} from "@workspace/agent";
import type { PiModel, PiModelList } from "@workspace/agent";
import { InlineKeyboard } from "grammy";

import { t } from "../i18n";
import { escapeHtml } from "../telegram/format";

/**
 * pi's models in a chat. pi lists hundreds (OpenRouter alone is ~400) and a
 * `provider/id` outgrows a button's 64 bytes, so a button carries an index
 * into the list in hand and the list's version (`<version>:<index>`, or
 * `<version>_<index>` where a callback allows no colon), a press on an
 * older list is refused, and only a short list gets buttons: the current
 * pick, the default, the owner's favourites (pi's `enabledModels`), the
 * recent picks and the small providers of `models.json`. Everything else is
 * found by `/model <words>` or read in «Все модели», one message of ids.
 */

/** One button as plain data: its label and its callback data. */
export interface MenuButton {
  readonly data: string;
  readonly label: string;
}

/** A message with buttons, its text as HTML. */
export interface MenuScreen {
  readonly rows: readonly (readonly MenuButton[])[];
  readonly text: string;
}

/** Most model buttons a screen shows, the default's included. */
export const PI_BUTTON_CAP = 8;

/** Rows the recent picks keep however many favourites there are. */
const RECENT_ROWS = 3;

/** Telegram's longest message. */
const MESSAGE_LIMIT = 4096;

const INDEX_RE = /^(?<version>[a-z0-9]+)[:_](?<index>\d+)$/u;

/** A model's button value on `list`. */
export const piIndexValue = (
  list: PiModelList,
  model: PiModel,
  separator: ":" | "_"
) => `${list.version}${separator}${list.models.indexOf(model)}`;

/**
 * The model a pressed value names: `none` when the value is no index,
 * `stale` when it was drawn from another list.
 */
export const piPressed = (list: PiModelList, value: string) => {
  const groups = INDEX_RE.exec(value)?.groups;
  if (groups === undefined) {
    return { kind: "none" } as const;
  }
  const model = list.models[Number(groups.index)];
  return groups.version === list.version && model !== undefined
    ? ({ kind: "model", model } as const)
    : ({ kind: "stale" } as const);
};

/**
 * The models worth a button, in order and once each: `first` (the current
 * pick), the favourites, the recent picks, the small providers' models;
 * never `skip` (the default, which has its own row), at most `cap`.
 */
export const piShortList = (input: {
  cap: number;
  first?: string;
  list: PiModelList;
  recents: readonly string[];
  skip?: string;
  withCustom: boolean;
}) => {
  const { list } = input;
  const found = (key: string | undefined) => {
    const model = findPiModel(list, key);
    return model === undefined ? [] : [model];
  };
  const skip = input.skip?.toLowerCase();
  const first = found(input.first);
  const recents = input.recents.flatMap(found);
  // A glob in `enabledModels` can match dozens, recent picks among them:
  // the first few recent picks keep rows of their own whatever the
  // favourites are, and the favourites fill the rest.
  const kept = recents
    .filter(
      (model) => !first.includes(model) && model.key.toLowerCase() !== skip
    )
    .slice(0, RECENT_ROWS);
  const favourites = piFavourites(list).filter(
    (model) =>
      model.key.toLowerCase() !== skip &&
      !first.includes(model) &&
      !kept.includes(model)
  );
  const candidates = [
    ...first,
    ...favourites.slice(0, Math.max(0, input.cap - first.length - kept.length)),
    ...kept,
    ...recents,
    ...(input.withCustom ? piCustomModels(list) : []),
  ];
  const seen = new Set<string>();
  return candidates
    .filter((model) => {
      const key = model.key.toLowerCase();
      if (key === skip || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, input.cap);
};

const mark = (on: boolean) => (on ? "✓ " : "");

/** The value of the row a stored pick the list lacks shows as. */
export const PI_GONE = "gone";

/**
 * A stored pi pick as a picker shows it: `usual` when there is none or it
 * is the model the usual row stands for, `listed` when the list has it,
 * `gone` when it does not, though runs still start on it.
 */
export type PiStoredPick =
  | { readonly kind: "gone"; readonly key: string }
  | { readonly kind: "listed"; readonly model: PiModel }
  | { readonly kind: "usual" };

export const piStoredPick = (input: {
  list: PiModelList;
  stored: string | undefined;
  usual: string | undefined;
}): PiStoredPick => {
  const { list, stored } = input;
  if (
    stored === undefined ||
    stored.toLowerCase() === input.usual?.toLowerCase()
  ) {
    return { kind: "usual" };
  }
  const model = findPiModel(list, stored);
  return model === undefined
    ? { key: stored, kind: "gone" }
    : { kind: "listed", model };
};

/**
 * The gone pick's row label: with a note, unless no list arrived yet and
 * nothing can be said about it.
 */
export const piGoneLabel = (list: PiModelList, key: string) =>
  list.models.length === 0 ? key : t().model.pi.gone(key);

/**
 * The picker rows past the usual one: the gone pick first, then the short
 * list (its first entry the listed pick), all under `PI_BUTTON_CAP` with the
 * usual row. Each value is `gone` or an index.
 */
export const piPickerRows = (input: {
  list: PiModelList;
  recents: readonly string[];
  separator: ":" | "_";
  stored: PiStoredPick;
  usual: string | undefined;
  withCustom: boolean;
}) => {
  const { list, stored } = input;
  const gone =
    stored.kind === "gone"
      ? [{ id: PI_GONE, label: piGoneLabel(list, stored.key) }]
      : [];
  const models = piShortList({
    cap: PI_BUTTON_CAP - 1 - gone.length,
    first: stored.kind === "listed" ? stored.model.key : undefined,
    list,
    recents: input.recents,
    skip: input.usual,
    withCustom: input.withCustom,
  });
  return [
    ...gone,
    ...models.map((model) => ({
      id: piIndexValue(list, model, input.separator),
      label: model.key,
    })),
  ];
};

/**
 * A /settings pi picker's note: how to add a model, that no list arrived
 * yet, or that one did and `list`, the part of `full` the picker offers,
 * is empty (the light picker, when no model has a key light runs get).
 */
export const piPickerNote = (pi: { full?: PiModelList; list: PiModelList }) => {
  if ((pi.full ?? pi.list).models.length === 0) {
    return t().model.pi.loading;
  }
  return pi.list.models.length === 0
    ? t().model.pi.noLight
    : t().model.pi.pickerHint;
};

/** The value a picker marks for `stored`: `usual`'s, `gone`, or an index. */
export const piMarked = (input: {
  list: PiModelList;
  separator: ":" | "_";
  stored: PiStoredPick;
  usual: string;
}) => {
  const { stored } = input;
  if (stored.kind === "listed") {
    return piIndexValue(input.list, stored.model, input.separator);
  }
  return stored.kind === "gone" ? PI_GONE : input.usual;
};

/**
 * The default row's label: noted as gone when a list arrived and lacks the
 * model, which a run then refuses (a local default, say), so the owner
 * picks another.
 */
const defaultLabel = (list: PiModelList, fallback: string | undefined) => {
  const label = t().model.pi.byDefault(fallback ?? "");
  return fallback === undefined ||
    list.models.length === 0 ||
    findPiModel(list, fallback) !== undefined
    ? label
    : t().model.pi.gone(label);
};

/**
 * `/model` on pi: the header, the default, the short list and «Все модели».
 * `current` is the conversation's own pick, `fallback` what it runs on
 * without one. An own pick the list lacks keeps a marked row, so the
 * screen never claims the default runs.
 */
export const piModelScreen = (input: {
  current: string | undefined;
  fallback: string | undefined;
  list: PiModelList;
  recents: readonly string[];
}): MenuScreen => {
  const copy = t().model;
  const { list } = input;
  const stored = piStoredPick({
    list,
    stored: input.current,
    usual: input.fallback,
  });
  const marked = piMarked({ list, separator: ":", stored, usual: AUTO_MODEL });
  const rows = piPickerRows({
    list,
    recents: input.recents,
    separator: ":",
    stored,
    usual: input.fallback,
    withCustom: true,
  });
  return {
    rows: [
      [
        {
          data: `model:${AUTO_MODEL}`,
          label: `${mark(marked === AUTO_MODEL)}${defaultLabel(list, input.fallback)}`,
        },
      ],
      ...rows.map((row) => [
        {
          data: `model:${row.id}`,
          label: `${mark(row.id === marked)}${row.label}`,
        },
      ]),
      [{ data: "model:all", label: copy.pi.all(list.models.length) }],
    ],
    text: `${escapeHtml(copy.modelHeader)}\n${escapeHtml(copy.pi.manual)}`,
  };
};

/** `/model <words>` on pi when no single model is named: what matches. */
export const piSearchScreen = (input: {
  current: string | undefined;
  list: PiModelList;
  query: string;
}): MenuScreen => {
  const copy = t().model.pi;
  const query = escapeHtml(input.query);
  const found = searchPiModels(input.list, input.query);
  if (found.length === 0) {
    return { rows: [], text: copy.none(query) };
  }
  const shown = found.slice(0, PI_BUTTON_CAP);
  const current = input.current?.toLowerCase();
  const rest = found.length - shown.length;
  return {
    rows: shown.map((model) => [
      {
        data: `model:${piIndexValue(input.list, model, ":")}`,
        label: `${mark(model.key.toLowerCase() === current)}${model.key}`,
      },
    ]),
    text: [copy.found(query), ...(rest > 0 ? [copy.more(rest)] : [])].join(
      "\n"
    ),
  };
};

/** The word a provider's search hint offers: its most common vendor. */
const sampleWord = (models: readonly PiModel[]) => {
  const counts = new Map<string, number>();
  for (const model of models) {
    const id = model.key.slice(model.provider.length + 1);
    const vendor = id.includes("/") ? id.split("/")[0] : id.split("-")[0];
    if (vendor !== undefined && vendor.length > 0) {
      counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
    }
  }
  let best = "";
  for (const [vendor, count] of counts) {
    if (count > (counts.get(best) ?? 0)) {
      best = vendor;
    }
  }
  return best;
};

/** One provider's lines in «Все модели». */
const providerLines = (provider: string, models: readonly PiModel[]) => {
  const name = escapeHtml(provider);
  if (models.length > PI_BIG_PROVIDER) {
    const search = `<code>/model ${name} ${escapeHtml(sampleWord(models))}</code>`;
    return [t().model.pi.bigProvider(`<b>${name}</b>`, models.length, search)];
  }
  return [
    `<b>${name}</b>`,
    ...models.map((model) => `<code>${escapeHtml(model.key)}</code>`),
  ];
};

/**
 * «Все модели»: every id, grouped by provider in pi's order, each in
 * `<code>` so a tap copies it; a provider too big to list says how to search
 * it. Split into messages Telegram takes, at line boundaries.
 */
export const piAllModelsMessages = (list: PiModelList) => {
  const groups = new Map<string, PiModel[]>();
  for (const model of list.models) {
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  }
  const blocks = [
    escapeHtml(t().model.pi.allHeader(list.models.length)),
    ...[...groups].map(([provider, models]) =>
      providerLines(provider, models).join("\n")
    ),
  ];
  const messages: string[] = [];
  for (const line of blocks.join("\n\n").split("\n")) {
    const last = messages.at(-1);
    if (last !== undefined && last.length + line.length + 1 <= MESSAGE_LIMIT) {
      messages[messages.length - 1] = `${last}\n${line}`;
    } else {
      messages.push(line);
    }
  }
  return messages;
};

/** A screen's buttons as a grammy keyboard. */
export const keyboardOf = (screen: Pick<MenuScreen, "rows">) => {
  const keyboard = new InlineKeyboard();
  for (const row of screen.rows) {
    for (const button of row) {
      keyboard.text(button.label, button.data);
    }
    keyboard.row();
  }
  return keyboard;
};
