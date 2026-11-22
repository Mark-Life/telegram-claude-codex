import { decodeProviderId } from "@workspace/agent";
import type { OneTurnUse, ProviderId } from "@workspace/agent";
import type { AccountWriteMode } from "@workspace/env/bot";
import { Option } from "effect";
import { InlineKeyboard } from "grammy";

import {
  formatLimit,
  isLimited,
  LIMIT_KEYS,
  limitLadder,
  readLimit,
} from "../access/rate-limit";
import { readToggle, TOGGLE_KEYS } from "../bot-settings";
import { currentLanguage, LANGUAGES, t } from "../i18n";
import { readHomeTz } from "../reminders/home-tz";
import { readRunLimit, RUN_LIMIT_PRESETS } from "../run-limit";
import type { AccountView, VoiceList } from "../settings/service";
import { escapeHtml } from "../telegram/format";
import { VERBOSITY_LEVELS } from "../telegram/render-policy";
import type { Verbosity } from "../telegram/render-policy";
import {
  addPickRows,
  defaultsRows,
  defaultsHint,
  readDefaultsView,
} from "./settings-defaults";
import {
  helperRows,
  helpersOverview,
  parseHelperUse,
  readHelperView,
} from "./settings-helpers";
import { lightRows, readLightView } from "./settings-light";
import {
  providerLines,
  renderProvider,
  renderProviders,
} from "./settings-providers";
import { renderVoice } from "./settings-voice";
import { currentVerbosity } from "./verbosity";
import { workspaceLabel } from "./workspace";

/**
 * `/settings` as screens in one message: a home screen with a summary of
 * what is in force and a button per area, «Мои настройки» (anyone who may
 * open the menu), «Настройки бота» with «Группы и гости» and «Служебные
 * проходы» (a screen per helper pass) under it, and «Провайдеры» (the
 * owner's alone, never drawn for anyone else). A press edits the same
 * message, text and keyboard both, and every screen has a way back. Every
 * button that sets something carries the value it sets, never "next", so a
 * press on a screen drawn before another change still sets what its label
 * promised. Screens are `menu:<screen>[:<arg>]`, the bot's own settings
 * `settings:<key>:<value>`, all well under Telegram's 64 bytes.
 */

/** One screen of the menu. */
export type Screen =
  | {
      readonly kind:
        | "bot"
        | "helpers"
        | "home"
        | "light"
        | "my"
        | "providers"
        | "voice";
    }
  | { readonly kind: "helper"; readonly use: OneTurnUse }
  | { readonly kind: "provider"; readonly provider: ProviderId };

export const HOME: Screen = { kind: "home" };
export const BOT: Screen = { kind: "bot" };
export const HELPERS: Screen = { kind: "helpers" };
export const LIGHT: Screen = { kind: "light" };
export const MY: Screen = { kind: "my" };
export const VOICE: Screen = { kind: "voice" };

/** Whether only the owner may see `screen`. */
export const ownerOnly = (screen: Screen) =>
  screen.kind !== "home" && screen.kind !== "my";

const SCREEN_NAMES = {
  bot: BOT,
  home: HOME,
  light: LIGHT,
  my: MY,
  voice: VOICE,
} as const satisfies Record<string, Screen>;

/** A screen from `menu:` callback data, or undefined for anything else. */
export const parseScreen = (
  name: string | undefined,
  arg: string | undefined
): Screen | undefined => {
  if (name === "prov") {
    return arg === undefined
      ? { kind: "providers" }
      : Option.getOrUndefined(
          Option.map(decodeProviderId(arg), (id): Screen => ({
            kind: "provider",
            provider: id,
          }))
        );
  }
  if (name === "help") {
    if (arg === undefined) {
      return HELPERS;
    }
    const use = parseHelperUse(arg);
    return use === undefined ? undefined : { kind: "helper", use };
  }
  return arg === undefined
    ? Object.entries(SCREEN_NAMES).find(([known]) => known === name)?.[1]
    : undefined;
};

/** What the menu needs from outside the settings table. */
export interface MenuSources {
  /** The account and, while the feature is on, the write mode in force. */
  readonly account: () => Promise<{
    readonly view: AccountView;
    readonly writes: AccountWriteMode | undefined;
  }>;
  /** `MAX_CONCURRENT_RUNS`, the limit while the owner has set none. */
  readonly envRunLimit: number;
  /** `DEFAULT_TZ`, the zone while the owner has set none. */
  readonly envTz: string;
  /** The owner's ElevenLabs voices, for «Голосовые ответы». */
  readonly voices: () => Promise<VoiceList>;
}

/** Who a screen is drawn for. */
export interface Viewer {
  readonly owner: boolean;
  readonly userId: number;
}

/** The key the language row writes. */
export const LANGUAGE_KEY = "bot_language";

/** The pseudo-key of the workspace row; its one value forgets the workspace. */
export const WORKSPACE_KEY = "workspace";

/** The values of the time zone row: ask for a zone, or stop asking. */
export const TZ_ASK = "ask";
export const TZ_CANCEL = "cancel";

/** The value a press moves to: the next larger one, wrapping to the first. */
const nextUp = (ladder: readonly number[], current: number) =>
  ladder.find((value) => value > current) ?? ladder[0] ?? current;

/** The language a press on the language row switches to. */
const nextLanguage = () => {
  const index = LANGUAGES.indexOf(currentLanguage());
  return LANGUAGES[(index + 1) % LANGUAGES.length] ?? currentLanguage();
};

const nextVerbosity = (current: Verbosity) => {
  const index = VERBOSITY_LEVELS.indexOf(current);
  return VERBOSITY_LEVELS[(index + 1) % VERBOSITY_LEVELS.length] ?? current;
};

const limitText = (limit: number) =>
  isLimited(limit) ? String(limit) : t().settings.limits.none;

const accountLine = (view: AccountView) => {
  const copy = t().settings.account;
  switch (view.kind) {
    case "connected": {
      return copy.connected(view.name);
    }
    case "logged-out": {
      return copy.loggedOut;
    }
    case "off": {
      return copy.off;
    }
    default: {
      return copy.off;
    }
  }
};

/** A setting's block of text: its value in bold, then what it does. */
const block = (heading: string, lines: readonly string[]) =>
  [`<b>${escapeHtml(heading)}</b>`, ...lines.map(escapeHtml)].join("\n");

const title = (text: string) => `<b>${escapeHtml(text)}</b>`;

/** Everything the bot screen shows, read at once. */
const readState = async (sources: MenuSources) => {
  const [toggles, verbosity, limits, account, workspace, tz, runLimit] =
    await Promise.all([
      Promise.all(
        TOGGLE_KEYS.map(async (key) => ({ key, on: await readToggle(key) }))
      ),
      currentVerbosity(),
      Promise.all(
        LIMIT_KEYS.map(async (key) => ({ key, limit: await readLimit(key) }))
      ),
      sources.account(),
      workspaceLabel(),
      readHomeTz(sources.envTz),
      readRunLimit(sources.envRunLimit),
    ]);
  return { account, limits, runLimit, toggles, tz, verbosity, workspace };
};

type MenuState = Awaited<ReturnType<typeof readState>>;

const onOff = (on: boolean) => (on ? t().settings.on : t().settings.off);

const botKeyboard = (state: MenuState) => {
  const copy = t().settings;
  const keyboard = new InlineKeyboard();
  const row = (label: string, key: string, value: string) =>
    keyboard.text(label, `settings:${key}:${value}`).row();

  for (const { key, on } of state.toggles) {
    row(`${copy.toggles[key].label}: ${onOff(on)}`, key, on ? "off" : "on");
  }
  row(
    `${copy.language.label}: ${t().languageName}`,
    LANGUAGE_KEY,
    nextLanguage()
  );
  row(
    `${copy.verbosity.label}: ${copy.verbosity.values[state.verbosity]}`,
    "verbosity",
    nextVerbosity(state.verbosity)
  );
  for (const { key, limit } of state.limits) {
    row(
      `${copy.limits.labels[key]}: ${limitText(limit)}`,
      key,
      formatLimit(nextUp(limitLadder(key), limit))
    );
  }
  const { writes } = state.account;
  if (writes !== undefined) {
    const confirming = writes === "confirm";
    row(
      `${copy.account.confirm.label}: ${onOff(confirming)}`,
      "account_writes",
      confirming ? "direct" : "confirm"
    );
  }
  if (state.workspace !== undefined) {
    row(copy.workspace.clear, WORKSPACE_KEY, "clear");
  }
  row(`${copy.timeZone.label}: ${state.tz}`, "default_tz", TZ_ASK);
  row(
    `${copy.runLimit.label}: ${state.runLimit}`,
    "max_concurrent_runs",
    String(nextUp(RUN_LIMIT_PRESETS, state.runLimit))
  );
  return keyboard
    .text(copy.menu.open(copy.voice.label), "menu:voice")
    .row()
    .text(copy.menu.open(copy.sections.light), "menu:light")
    .row()
    .text(copy.menu.open(copy.sections.helpers), "menu:help")
    .row()
    .text(copy.defaults.back, "menu:home");
};

/** The bot screen's text: each setting's value, then what it does. */
const botText = (state: MenuState) => {
  const copy = t().settings;
  const { writes } = state.account;
  return [
    title(copy.title),
    ...state.toggles.map(({ key, on }) =>
      block(`${copy.toggles[key].label}: ${onOff(on)}`, [
        copy.toggles[key].hint,
      ])
    ),
    block(`${copy.language.label}: ${t().languageName}`, [copy.language.hint]),
    block(
      `${copy.verbosity.label}: ${copy.verbosity.values[state.verbosity]}`,
      [copy.verbosity.hint]
    ),
    block(copy.sections.limits, [
      ...state.limits.map(
        ({ key, limit }) => `${copy.limits.labels[key]}: ${limitText(limit)}`
      ),
      copy.limits.hint,
    ]),
    block(copy.sections.account, [accountLine(state.account.view)]),
    ...(writes === undefined
      ? []
      : [
          block(
            `${copy.account.confirm.label}: ${onOff(writes === "confirm")}`,
            [copy.account.confirm.hint]
          ),
        ]),
    block(copy.sections.workspace, [
      copy.workspace.line(state.workspace ?? copy.workspace.none),
      copy.workspace.hint,
    ]),
    block(`${copy.timeZone.label}: ${state.tz}`, [copy.timeZone.hint]),
    block(`${copy.runLimit.label}: ${state.runLimit}`, [copy.runLimit.hint]),
  ].join("\n\n");
};

const renderBot = async (sources: MenuSources) => {
  const state = await readState(sources);
  return { keyboard: botKeyboard(state), text: botText(state) };
};

/** A screen of three picker rows: its heading, hint, rows and way back. */
const pickScreen = (input: {
  back: string;
  heading: string;
  hint: string;
  rows: ReturnType<typeof defaultsRows>;
}) => ({
  keyboard: addPickRows(new InlineKeyboard(), input.rows).text(
    t().settings.defaults.back,
    input.back
  ),
  text: [
    title(input.heading),
    input.hint,
    escapeHtml(input.rows.map(({ line }) => line).join("\n")),
  ].join("\n\n"),
});

const renderMy = async (viewer: Viewer) =>
  pickScreen({
    back: "menu:home",
    heading: t().settings.defaults.title,
    hint: defaultsHint(viewer.owner),
    rows: defaultsRows(await readDefaultsView(viewer)),
  });

const renderLight = async () =>
  pickScreen({
    back: "menu:bot",
    heading: t().settings.sections.light,
    hint: escapeHtml(
      `${t().settings.light.hint}\n\n${t().settings.light.helpers}`
    ),
    rows: lightRows(await readLightView()),
  });

/** «Служебные проходы»: where each helper pass runs now, a row per pass. */
const renderHelpers = async () => {
  const copy = t().settings;
  const overview = await helpersOverview();
  return {
    keyboard: addPickRows(new InlineKeyboard(), overview.rows).text(
      copy.defaults.back,
      "menu:bot"
    ),
    text: [
      title(copy.sections.helpers),
      escapeHtml(copy.helpers.hint),
      escapeHtml(overview.text),
    ].join("\n\n"),
  };
};

/** One helper pass's screen: its provider, and on it the model and depth. */
const renderHelper = async (use: OneTurnUse) =>
  pickScreen({
    back: "menu:help",
    heading: t().settings.helpers.uses[use],
    hint: escapeHtml(t().settings.helpers.useHints[use]),
    rows: helperRows(await readHelperView(use)),
  });

/**
 * The home screen: what is in force, in short, and a button per area the
 * viewer may open.
 */
const renderHome = async (sources: MenuSources, viewer: Viewer) => {
  const copy = t().settings;
  const defaults = await readDefaultsView(viewer);
  const keyboard = new InlineKeyboard()
    .text(copy.menu.open(copy.defaults.title), "menu:my")
    .row();
  const blocks = [
    title(copy.menu.title),
    block(
      copy.defaults.title,
      defaultsRows(defaults).map(({ line }) => line)
    ),
  ];
  if (viewer.owner) {
    keyboard
      .text(copy.menu.open(copy.title), "menu:bot")
      .row()
      .text(copy.menu.open(copy.providers.title), "menu:prov")
      .row();
    const [verbosity, tz, runLimit, providers] = await Promise.all([
      currentVerbosity(),
      readHomeTz(sources.envTz),
      readRunLimit(sources.envRunLimit),
      providerLines(),
    ]);
    blocks.push(
      block(copy.title, [
        `${copy.language.label}: ${t().languageName}`,
        `${copy.verbosity.label}: ${copy.verbosity.values[verbosity]}`,
        `${copy.timeZone.label}: ${tz}`,
        `${copy.runLimit.label}: ${runLimit}`,
      ]),
      block(copy.providers.title, providers)
    );
  }
  return {
    keyboard,
    text: [...blocks, escapeHtml(copy.menu.hint)].join("\n\n"),
  };
};

/** A screen as it is drawn. */
interface Drawn {
  readonly keyboard: InlineKeyboard;
  readonly text: string;
}

/**
 * One screen's text (HTML) and keyboard, as stored now. The caller has
 * checked that the viewer may see it (`ownerOnly`).
 */
export const renderScreen = async (input: {
  screen: Screen;
  sources: MenuSources;
  viewer: Viewer;
}): Promise<Drawn> => {
  const { screen, sources, viewer } = input;
  if (screen.kind === "provider") {
    return await renderProvider(screen.provider);
  }
  if (screen.kind === "helper") {
    return await renderHelper(screen.use);
  }
  const screens = {
    bot: async () => await renderBot(sources),
    helpers: renderHelpers,
    home: async () => await renderHome(sources, viewer),
    light: renderLight,
    my: async () => await renderMy(viewer),
    providers: renderProviders,
    voice: async () => await renderVoice(sources.voices),
  } as const satisfies Record<(typeof screen)["kind"], () => Promise<Drawn>>;
  return await screens[screen.kind]();
};
