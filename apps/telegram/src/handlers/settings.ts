import { decodeProviderId, settingControl } from "@workspace/agent";
import { AppConfig } from "@workspace/env/bot";
import { Effect, Option } from "effect";
import type { InlineKeyboard } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { isLimitKey, NO_LIMIT } from "../access/rate-limit";
import type { LimitKey } from "../access/rate-limit";
import { isOperator, isOwner } from "../access/tier";
import { WritesMode } from "../account/writes-mode";
import { isToggleKey } from "../bot-settings";
import type { ToggleKey } from "../bot-settings";
import { t } from "../i18n";
import { readHomeTz } from "../reminders/home-tz";
import { SettingsPorts, SettingsService } from "../settings/service";
import type {
  BotPatch,
  LimitField,
  SettingRefused,
  StoreSetting,
  ToggleField,
} from "../settings/service";
import { tgBestEffort } from "../telegram/bridge";
import type { HandlerDeps } from "./deps";
import {
  DEFAULTS_CALLBACK_RE,
  getUserId,
  HELPER_CALLBACK_RE,
  LIGHT_CALLBACK_RE,
  logRejection,
  MENU_CALLBACK_RE,
  PROVIDER_SETTING_CALLBACK_RE,
  SETTINGS_CALLBACK_RE,
  VOICE_CALLBACK_RE,
} from "./helpers";
import {
  applyDefault,
  parseDefaultsField,
  readDefaultsView,
  renderPicker,
} from "./settings-defaults";
import {
  applyHelper,
  parseHelperField,
  parseHelperUse,
  readHelperView,
  renderHelperPicker,
} from "./settings-helpers";
import {
  applyLight,
  parseLightField,
  readLightView,
  renderLightPicker,
} from "./settings-light";
import {
  BOT,
  HOME,
  LANGUAGE_KEY,
  LIGHT,
  MY,
  ownerOnly,
  parseScreen,
  renderScreen,
  TZ_ASK,
  TZ_CANCEL,
  VOICE,
  WORKSPACE_KEY,
} from "./settings-menu";
import type { MenuSources, Screen, Viewer } from "./settings-menu";
import {
  applyProviderSetting,
  renderSettingPicker,
} from "./settings-providers";
import { registerZoneInput } from "./settings-zone";

/**
 * `/settings`: a home screen and one screen per area (`settings-menu.ts`),
 * all in one message. A press stores the value its button carries and
 * redraws the screen it was made on; every row applies at once, without a
 * restart. The time zone row asks for the zone as the next message
 * (`settings-zone.ts`). Private chat only. An executor opens it too and sees
 * only their own «Мои настройки» (`settings-defaults.ts`); every screen
 * press is checked against the tier again, so a forged one opens nothing.
 */

const isOwnerCtx = (ctx: BotContext) => isOwner(accessOf(ctx).tier);

const isOperatorCtx = (ctx: BotContext) => isOperator(accessOf(ctx).tier);

/** Who the menu is drawn for: the owner sees all of it. */
const viewerOf = (ctx: BotContext): Viewer => ({
  owner: isOwnerCtx(ctx),
  userId: getUserId(ctx),
});

/**
 * The menu shows the owner's Telegram account and work chat, so like
 * `/login` it opens only in a private chat.
 */
const isPrivate = (ctx: BotContext) => ctx.chat?.type === "private";

type Press =
  | { readonly stored: false; readonly toast: string }
  | { readonly stored: true; readonly toast?: string };

const STORED: Press = { stored: true };

/** The toggle switches by the setting each writes. */
const TOGGLE_FIELD_OF = {
  guests: "guests",
  mark_read: "markRead",
  steer: "steer",
  voice_transcript: "voiceTranscript",
} as const satisfies Record<ToggleKey, ToggleField>;

/** The daily budgets by the setting each writes. */
const LIMIT_FIELD_OF = {
  group_runs_per_day: "groupRunsPerDay",
  group_runs_per_user: "groupRunsPerUser",
  private_runs_per_day: "privateRunsPerDay",
  private_runs_per_user: "privateRunsPerUser",
} as const satisfies Record<LimitKey, LimitField>;

const DIGITS_RE = /^\d+$/u;

/** A press's count, digits only: anything else is `NaN`, which no row offers. */
const countOf = (value: string) =>
  DIGITS_RE.test(value) ? Number(value) : Number.NaN;

/**
 * The change one `settings:<key>:<value>` press asks for, or undefined for
 * a key no row writes. The service checks the value.
 */
const patchOf = (key: string, value: string): BotPatch | undefined => {
  if (isToggleKey(key)) {
    return { [TOGGLE_FIELD_OF[key]]: value === "on" };
  }
  if (isLimitKey(key)) {
    return {
      limits: {
        [LIMIT_FIELD_OF[key]]: value === NO_LIMIT ? NO_LIMIT : countOf(value),
      },
    };
  }
  switch (key) {
    case LANGUAGE_KEY: {
      return { language: value };
    }
    case "verbosity": {
      return { verbosity: value };
    }
    case "account_writes": {
      return { accountWrites: value };
    }
    case "max_concurrent_runs": {
      return { maxConcurrentRuns: Number(value) };
    }
    case WORKSPACE_KEY: {
      return value === "clear" ? { workspace: null } : undefined;
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Apply one press that writes a value: stored, or refused with the toast to
 * show. A write that fails is logged here.
 */
const applyPress = async (input: {
  key: string;
  store: (patch: BotPatch) => Promise<SettingRefused | undefined>;
  value: string;
}): Promise<Press> => {
  const copy = t().settings;
  const patch = patchOf(input.key, input.value);
  if (patch === undefined) {
    return { stored: false, toast: copy.unknown };
  }
  try {
    const refused = await input.store(patch);
    if (refused !== undefined) {
      return { stored: false, toast: copy.unknown };
    }
    return patch.workspace === null
      ? { stored: true, toast: copy.workspace.cleared }
      : STORED;
  } catch (error) {
    logRejection("Settings write failed")(error);
    return { stored: false, toast: copy.writeFailed };
  }
};

/** Draw `menu` over a message; a double tap's "not modified" is dropped. */
const show = async (
  target: { chatId: number; messageId: number },
  menu: { keyboard: InlineKeyboard; text: string }
) => {
  await tgBestEffort(
    "editMessageText",
    async (api) =>
      await api.editMessageText(target.chatId, target.messageId, menu.text, {
        parse_mode: "HTML",
        reply_markup: menu.keyboard,
      }),
    { retry: false }
  );
};

/**
 * The message an owner-only picker press was made on, when the owner made
 * it in a private chat; else the refusal is answered and it is null.
 */
const ownerPickerTarget = async (ctx: BotContext) => {
  const message = ctx.callbackQuery?.message;
  if (isOwnerCtx(ctx) && isPrivate(ctx) && message) {
    return { chatId: message.chat.id, messageId: message.message_id };
  }
  await ctx.answerCallbackQuery({
    text: isOwnerCtx(ctx) ? t().settings.privateOnly : t().settings.notOwner,
  });
  return null;
};

export const registerSettingsHandlers = Effect.fnUntraced(function* (
  deps: HandlerDeps
) {
  const { bot, ownerId } = deps;
  const cfg = yield* AppConfig;
  const settings = yield* SettingsService;
  const ports = yield* SettingsPorts;
  const writesMode = (yield* WritesMode).current;
  const context = yield* Effect.context();
  const accountFeature = Option.isSome(cfg.telegramAccount);
  const run = Effect.runPromiseWith(context);

  const readAccount = Effect.gen(function* () {
    const view = yield* ports.account;
    const writes = accountFeature ? yield* writesMode : undefined;
    return { view, writes };
  });

  /** The account's voices, never a rejection: a failure is shown instead. */
  const readVoices = async () => await run(ports.voices);

  const store: StoreSetting = async (write) =>
    await run(
      write.pipe(
        Effect.andThen(Effect.undefined),
        Effect.catchTag("SettingRefused", Effect.succeed)
      )
    );

  const sources: MenuSources = {
    account: async () => await Effect.runPromiseWith(context)(readAccount),
    envRunLimit: cfg.maxConcurrentRuns,
    envTz: deps.defaultTz,
    voices: readVoices,
  };

  /**
   * Redraw `screen` in a message, for the owner unless `viewer` says
   * otherwise.
   */
  const redraw = async (
    target: { chatId: number; messageId: number },
    screen: Screen,
    viewer?: Viewer
  ) => {
    try {
      await show(
        target,
        await renderScreen({
          screen,
          sources,
          viewer: viewer ?? { owner: true, userId: ownerId },
        })
      );
    } catch (error) {
      logRejection("Settings menu read failed")(error);
    }
  };

  const zone = registerZoneInput({
    bot,
    isOwner: (ctx) => isOwnerCtx(ctx) && isPrivate(ctx),
    readZone: async () => await readHomeTz(deps.defaultTz),
    redraw: async (target) => {
      await redraw(target, BOT);
    },
    // `resolveZone` took it already, so the service stores it as it is.
    writeZone: async (typed) => {
      const refused = await store(settings.updateBot({ timeZone: typed }));
      if (refused !== undefined) {
        throw new Error(`time zone refused: ${refused.reason}`);
      }
    },
  });

  bot.command("settings", async (ctx) => {
    if (!isOperatorCtx(ctx)) {
      await ctx.reply(t().settings.notOwner);
      return;
    }
    if (!isPrivate(ctx)) {
      await ctx.reply(t().settings.privateOnly);
      return;
    }
    try {
      const menu = await renderScreen({
        screen: HOME,
        sources,
        viewer: viewerOf(ctx),
      });
      await ctx.reply(menu.text, {
        parse_mode: "HTML",
        reply_markup: menu.keyboard,
      });
    } catch (error) {
      logRejection("Settings menu read failed")(error);
      await ctx.reply(t().settings.readFailed);
    }
  });

  bot.callbackQuery(SETTINGS_CALLBACK_RE, async (ctx) => {
    if (!isOwnerCtx(ctx)) {
      await ctx.answerCallbackQuery({ text: t().settings.notOwner });
      return;
    }
    if (!isPrivate(ctx)) {
      await ctx.answerCallbackQuery({ text: t().settings.privateOnly });
      return;
    }
    const groups = SETTINGS_CALLBACK_RE.exec(ctx.callbackQuery.data)?.groups;
    const key = groups?.key ?? "";
    const value = groups?.value ?? "";
    const { message } = ctx.callbackQuery;
    if (key === "default_tz" && value === TZ_ASK && message) {
      await ctx.answerCallbackQuery();
      await zone.ask(ctx, {
        chatId: message.chat.id,
        menuId: message.message_id,
        threadId: message.message_thread_id,
      });
      return;
    }
    if (key === "default_tz" && value === TZ_CANCEL) {
      await ctx.answerCallbackQuery();
      await zone.cancel(message?.chat.id);
      return;
    }
    const press = await applyPress({
      key,
      store: async (patch) => await store(settings.updateBot(patch)),
      value,
    });
    await ctx.answerCallbackQuery(
      press.toast === undefined ? undefined : { text: press.toast }
    );
    if (press.stored && message) {
      await redraw(
        { chatId: message.chat.id, messageId: message.message_id },
        BOT
      );
    }
  });

  // "New chats": each operator's own defaults, so an executor may press too.
  bot.callbackQuery(DEFAULTS_CALLBACK_RE, async (ctx) => {
    if (!isOperatorCtx(ctx)) {
      await ctx.answerCallbackQuery({ text: t().settings.notOwner });
      return;
    }
    if (!isPrivate(ctx)) {
      await ctx.answerCallbackQuery({ text: t().settings.privateOnly });
      return;
    }
    const { message } = ctx.callbackQuery;
    if (!message) {
      await ctx.answerCallbackQuery();
      return;
    }
    const groups = DEFAULTS_CALLBACK_RE.exec(ctx.callbackQuery.data)?.groups;
    const field = parseDefaultsField(groups?.field);
    const value = groups?.value;
    const target = { chatId: message.chat.id, messageId: message.message_id };
    const viewer = viewerOf(ctx);
    if (field === undefined) {
      await ctx.answerCallbackQuery();
      await redraw(target, MY, viewer);
      return;
    }
    try {
      const view = await readDefaultsView(viewer);
      if (value === undefined) {
        await ctx.answerCallbackQuery();
        const picker = renderPicker(field, view);
        // A double tap redraws the same picker; "not modified" is dropped.
        await tgBestEffort(
          "editMessageText",
          async (api) =>
            await api.editMessageText(
              target.chatId,
              target.messageId,
              picker.text,
              { reply_markup: picker.keyboard }
            ),
          { retry: false }
        );
        return;
      }
      const press = await applyDefault({
        field,
        save: async (patch) => await store(settings.updateMine(viewer, patch)),
        value,
        view,
      });
      await ctx.answerCallbackQuery(
        press.stored ? undefined : { text: press.toast }
      );
      if (press.stored) {
        await redraw(target, MY, viewer);
      }
    } catch (error) {
      logRejection("Defaults press failed")(error);
      await tgBestEffort(
        "answerCallbackQuery",
        async () =>
          await ctx.answerCallbackQuery({ text: t().settings.writeFailed })
      );
    }
  });

  /**
   * One press on an owner-only picker screen: no field is the way back to
   * `screen`, a field alone opens its picker, a value is stored and redraws
   * `screen`. `closed` refuses a field the view does not offer now.
   */
  const pickerPress = async <F extends string, V>(
    ctx: BotContext,
    input: {
      apply: (press: { field: F; value: string; view: V }) => Promise<Press>;
      closed?: (field: F, view: V) => boolean;
      field: F | undefined;
      label: string;
      read: () => Promise<V>;
      render: (field: F, view: V) => { keyboard: InlineKeyboard; text: string };
      screen: Screen;
      target: { chatId: number; messageId: number };
      value: string | undefined;
    }
  ) => {
    const { field, screen, target, value } = input;
    if (field === undefined) {
      await ctx.answerCallbackQuery();
      await redraw(target, screen);
      return;
    }
    try {
      const view = await input.read();
      if (input.closed?.(field, view) === true) {
        await ctx.answerCallbackQuery({ text: t().noSuchOption });
        await redraw(target, screen);
        return;
      }
      if (value === undefined) {
        await ctx.answerCallbackQuery();
        const picker = input.render(field, view);
        await tgBestEffort(
          "editMessageText",
          async (api) =>
            await api.editMessageText(
              target.chatId,
              target.messageId,
              picker.text,
              { reply_markup: picker.keyboard }
            ),
          { retry: false }
        );
        return;
      }
      const press = await input.apply({ field, value, view });
      await ctx.answerCallbackQuery(
        press.stored ? undefined : { text: press.toast }
      );
      if (press.stored) {
        await redraw(target, screen);
      }
    } catch (error) {
      logRejection(input.label)(error);
      await tgBestEffort(
        "answerCallbackQuery",
        async () =>
          await ctx.answerCallbackQuery({ text: t().settings.writeFailed })
      );
    }
  };

  // «Группы и гости»: the owner's bot-wide choice for light runs.
  bot.callbackQuery(LIGHT_CALLBACK_RE, async (ctx) => {
    const target = await ownerPickerTarget(ctx);
    if (target === null) {
      return;
    }
    const groups = LIGHT_CALLBACK_RE.exec(ctx.callbackQuery.data)?.groups;
    await pickerPress(ctx, {
      apply: async (press) =>
        await applyLight({
          ...press,
          save: async (patch) => await store(settings.updateLight(patch)),
        }),
      field: parseLightField(groups?.field),
      label: "Light settings press failed",
      read: readLightView,
      render: renderLightPicker,
      screen: LIGHT,
      target,
      value: groups?.value,
    });
  });
  // «Служебные проходы»: the owner's choice for one helper pass.
  bot.callbackQuery(HELPER_CALLBACK_RE, async (ctx) => {
    const target = await ownerPickerTarget(ctx);
    if (target === null) {
      return;
    }
    const groups = HELPER_CALLBACK_RE.exec(ctx.callbackQuery.data)?.groups;
    const use = parseHelperUse(groups?.use);
    if (use === undefined) {
      await ctx.answerCallbackQuery({ text: t().settings.unknown });
      return;
    }
    await pickerPress(ctx, {
      apply: async (press) =>
        await applyHelper({
          ...press,
          save: async (patch) => await store(settings.updateHelper(use, patch)),
        }),
      // On Auto the pass has no model or depth of its own to pick.
      closed: (field, view) =>
        field !== "provider" && view.choice.provider === undefined,
      field: parseHelperField(groups?.field),
      label: "Helper settings press failed",
      read: async () => await readHelperView(use),
      render: renderHelperPicker,
      screen: { kind: "helper", use },
      target,
      value: groups?.value,
    });
  });
  // A screen: home and «Мои настройки» for every operator, the rest for the
  // owner alone.
  bot.callbackQuery(MENU_CALLBACK_RE, async (ctx) => {
    if (!isOperatorCtx(ctx)) {
      await ctx.answerCallbackQuery({ text: t().settings.notOwner });
      return;
    }
    const { message } = ctx.callbackQuery;
    if (!isPrivate(ctx) || !message) {
      await ctx.answerCallbackQuery({ text: t().settings.privateOnly });
      return;
    }
    const groups = MENU_CALLBACK_RE.exec(ctx.callbackQuery.data)?.groups;
    const screen = parseScreen(groups?.screen, groups?.arg);
    const viewer = viewerOf(ctx);
    if (screen === undefined || (ownerOnly(screen) && !viewer.owner)) {
      await ctx.answerCallbackQuery({ text: t().settings.unknown });
      return;
    }
    await ctx.answerCallbackQuery();
    await redraw(
      { chatId: message.chat.id, messageId: message.message_id },
      screen,
      viewer
    );
  });

  // «Голосовые ответы»: the voice and model a voice reply is spoken with.
  bot.callbackQuery(VOICE_CALLBACK_RE, async (ctx) => {
    const target = await ownerPickerTarget(ctx);
    if (target === null) {
      return;
    }
    const groups = VOICE_CALLBACK_RE.exec(ctx.callbackQuery.data)?.groups;
    const field = groups?.field === "model" ? "model" : "voice";
    // Answered first: a voice is checked against the account's list, a
    // network call that may outlast Telegram's window for an answer. The
    // redraw shows what is stored either way, a refused press included.
    await ctx.answerCallbackQuery();
    try {
      await store(
        settings.updateVoice(
          field === "model"
            ? { model: groups?.value ?? "" }
            : { voice: groups?.value ?? "" }
        )
      );
    } catch (error) {
      logRejection("Voice settings press failed")(error);
      await ctx.reply(t().settings.writeFailed);
      return;
    }
    await redraw(target, VOICE);
  });

  // «Провайдеры»: the owner's settings for each provider's own CLI.
  bot.callbackQuery(PROVIDER_SETTING_CALLBACK_RE, async (ctx) => {
    if (!isOwnerCtx(ctx)) {
      await ctx.answerCallbackQuery({ text: t().settings.notOwner });
      return;
    }
    const { message } = ctx.callbackQuery;
    if (!isPrivate(ctx) || !message) {
      await ctx.answerCallbackQuery({ text: t().settings.privateOnly });
      return;
    }
    const groups = PROVIDER_SETTING_CALLBACK_RE.exec(
      ctx.callbackQuery.data
    )?.groups;
    const provider = Option.getOrUndefined(decodeProviderId(groups?.provider));
    const key = groups?.key ?? "";
    const raw = groups?.value;
    const target = { chatId: message.chat.id, messageId: message.message_id };
    if (provider === undefined) {
      await ctx.answerCallbackQuery({ text: t().settings.unknown });
      return;
    }
    try {
      const control = settingControl(provider, key);
      if (control === undefined) {
        await ctx.answerCallbackQuery({ text: t().settings.unknown });
        return;
      }
      if (raw === undefined) {
        await ctx.answerCallbackQuery();
        await show(
          target,
          await renderSettingPicker({ control, key, provider })
        );
        return;
      }
      const stored = await applyProviderSetting({
        control,
        key,
        raw,
        save: async (patch) =>
          await store(settings.updateProvider(provider, patch)),
      });
      await ctx.answerCallbackQuery(
        stored ? undefined : { text: t().noSuchOption }
      );
      if (stored) {
        await redraw(target, { kind: "provider", provider });
      }
    } catch (error) {
      logRejection("Provider settings press failed")(error);
      await tgBestEffort(
        "answerCallbackQuery",
        async () =>
          await ctx.answerCallbackQuery({ text: t().settings.writeFailed })
      );
    }
  });
});
