import {
  AUTO_MODEL,
  DEFAULT_MODEL,
  exactPiModel,
  getEffortLevelsFor,
  getModels,
  isRoutedEffort,
  loadPiModels,
  piDefaultModel,
} from "@workspace/agent";
import type { Choice, ProviderId } from "@workspace/agent";
import { InlineKeyboard } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { isOperator } from "../access/tier";
import { t } from "../i18n";
import { refreshModelsInBackground, retireRun } from "./agent-bridge";
import { AUTO, readStartPick } from "./chat-defaults";
import type { HandlerDeps } from "./deps";
import {
  EFFORT_CALLBACK_RE,
  MODEL_CALLBACK_RE,
  MODEL_ROUTING_CALLBACK_RE,
} from "./helpers";
import { isRoutable } from "./model-route";
import {
  keyboardOf,
  PI_GONE,
  piAllModelsMessages,
  piModelScreen,
  piPressed,
  piSearchScreen,
} from "./pi-model-menu";
import { readPiRecents, rememberPiPick } from "./pi-recents";
import { routeStateFor } from "./route-provider";
import { rememberThreadPick, resolveThreadPick } from "./session-routing";
import { getState } from "./user-state";

/** A live model list older than this is read again when `/model` opens. */
const MENU_MODEL_LIST_MAX_AGE_MS = 3_600_000;

/**
 * Model and effort belong to one conversation. The first message of a thread
 * decides them from the defaults of whoever sends it (`/settings`) and the
 * choice is kept for the rest of it, so these two commands only override that
 * choice, here, until the thread ends. Owner and executor only — nobody else
 * runs on the main model.
 */
const mayChooseModel = (ctx: BotContext) => isOperator(accessOf(ctx).tier);

/** The auto entry has no stored value: an unset half is what "routed" means. */
const AUTO_EFFORT = "auto";

/**
 * The row with no override. When the caller's default leaves that half to
 * the router and the provider can be routed it is "Auto"; otherwise a cleared
 * choice starts on their default, and the row says so.
 */
const noOverrideLabel = (routed: boolean) =>
  routed ? t().model.auto : t().model.default;

/** A model row: its name, then what its tier is good for. */
export const modelLabel = (choice: Choice) =>
  choice.tier === undefined
    ? choice.label
    : `${choice.label} (${t().model.tierHints[choice.tier]})`;

/** An effort row: the router's levels are named in the language in use. */
const effortLabel = (choice: Choice) =>
  isRoutedEffort(choice.id) ? t().model.efforts[choice.id] : choice.label;

/**
 * Whether a cleared half on `provider` goes back to the router: the caller's
 * own default for it is auto and the provider can be routed.
 */
const routedFor = async (input: {
  half: "effort" | "model";
  provider: ProviderId;
  userId: number;
}) => {
  const { pick } = await readStartPick(input.userId);
  return pick[input.half] === AUTO && isRoutable(input.provider);
};

/** A thread's own pick, when it holds one; the sentinels are none. */
const ownPick = (model: string | undefined) =>
  model === undefined || model === DEFAULT_MODEL || model === AUTO_MODEL
    ? undefined
    : model;

/**
 * What a pi conversation runs on with no pick of its own: pi's default once
 * it stored `DEFAULT_MODEL`, else what its next message starts on.
 */
const piFallback = async (state: {
  model: string | undefined;
  userId: number;
}) => {
  if (state.model === DEFAULT_MODEL) {
    return piDefaultModel();
  }
  const { pick } = await readStartPick(state.userId);
  return pick.models.pi ?? piDefaultModel();
};

type RouteState = Awaited<ReturnType<typeof routeStateFor>>;

/** Store a pi model as the conversation's pick, and as a recent one. */
const setPiPick = async (state: RouteState, model: string | undefined) => {
  const pick = await resolveThreadPick(state);
  if (model !== pick.model) {
    retireRun(state);
  }
  await rememberThreadPick(state, { ...pick, model });
  if (model !== undefined) {
    await rememberPiPick(model);
  }
};

/**
 * `/model` on pi: the short list, or with words after it, the model they
 * name outright (set at once) or the ones they match.
 */
const piModelCommand = async (
  ctx: BotContext,
  state: RouteState,
  query: string
) => {
  const list = await loadPiModels();
  if (list.models.length === 0) {
    await ctx.reply(t().model.pi.noList);
    return;
  }
  const { model } = await resolveThreadPick(state);
  const current = ownPick(model);
  const exact = query.length === 0 ? undefined : exactPiModel(list, query);
  if (exact !== undefined) {
    await setPiPick(state, exact.key);
    await ctx.reply(t().model.modelSet(exact.key));
    return;
  }
  const screen =
    query.length === 0
      ? piModelScreen({
          current,
          fallback: await piFallback({ model, userId: state.userId }),
          list,
          recents: await readPiRecents(),
        })
      : piSearchScreen({ current, list, query });
  await ctx.reply(screen.text, {
    parse_mode: "HTML",
    reply_markup: keyboardOf(screen),
  });
};

/** A press on pi's `/model`: a model by index, the default, or «Все модели». */
const piModelPress = async (
  ctx: BotContext,
  state: RouteState,
  chosen: string
) => {
  const list = await loadPiModels();
  if (chosen === "all") {
    await ctx.answerCallbackQuery();
    for (const text of piAllModelsMessages(list)) {
      // oxlint-disable-next-line no-await-in-loop -- the parts go out in order
      await ctx.reply(text, { parse_mode: "HTML" });
    }
    return;
  }
  if (chosen === AUTO_MODEL) {
    await setPiPick(state, undefined);
    const label = t().model.pi.byDefault(
      (await piFallback({ model: undefined, userId: state.userId })) ?? ""
    );
    await ctx.answerCallbackQuery({ text: t().model.modelToast(label) });
    await ctx.editMessageText(t().model.modelSet(label));
    return;
  }
  if (chosen === PI_GONE) {
    await ctx.answerCallbackQuery({ text: t().model.pi.goneToast });
    return;
  }
  const pressed = piPressed(list, chosen);
  if (pressed.kind !== "model") {
    await ctx.answerCallbackQuery({
      text:
        pressed.kind === "stale" ? t().model.pi.stale : t().model.noSuchModel,
    });
    return;
  }
  await setPiPick(state, pressed.model.key);
  await ctx.answerCallbackQuery({
    text: t().model.modelToast(pressed.model.key),
  });
  await ctx.editMessageText(t().model.modelSet(pressed.model.key));
};

/**
 * The model `/effort` speaks of: the conversation's pick, else its start.
 * On pi the list says its levels; `none` while no list arrived.
 */
const effortModel = async (state: RouteState, model: string | undefined) => {
  if (state.activeProvider !== "pi") {
    return { kind: "model", model: ownPick(model) } as const;
  }
  const list = await loadPiModels();
  if (list.models.length === 0) {
    return { kind: "none" } as const;
  }
  return {
    kind: "model",
    model:
      ownPick(model) ?? (await piFallback({ model, userId: state.userId })),
  } as const;
};

/** The level `chosen` names among the ones `/effort` offers now. */
const effortChoice = async (
  state: RouteState,
  model: string | undefined,
  chosen: string
) => {
  const spoken = await effortModel(state, model);
  return spoken.kind === "none"
    ? undefined
    : getEffortLevelsFor(state.activeProvider, spoken.model).find(
        (level) => level.id === chosen
      );
};

export const registerModelEffortHandlers = ({ bot }: HandlerDeps) => {
  bot.command("model", async (ctx) => {
    if (!mayChooseModel(ctx)) {
      await ctx.reply(t().notForYou);
      return;
    }
    // The menu shows the list in hand; a stale one is read again for the
    // next time, never awaited here.
    refreshModelsInBackground(MENU_MODEL_LIST_MAX_AGE_MS);
    const state = await routeStateFor(ctx, await getState(ctx));
    if (state.activeProvider === "pi") {
      await piModelCommand(ctx, state, ctx.match.trim());
      return;
    }
    const pick = await resolveThreadPick(state);
    const current =
      pick.model === undefined || pick.model === DEFAULT_MODEL
        ? AUTO_MODEL
        : pick.model;
    const routed = await routedFor({
      half: "model",
      provider: state.activeProvider,
      userId: state.userId,
    });
    const keyboard = new InlineKeyboard();
    for (const choice of getModels(state.activeProvider)) {
      const mark = choice.id === current ? "✓ " : "";
      const label =
        choice.id === AUTO_MODEL ? noOverrideLabel(routed) : modelLabel(choice);
      keyboard.text(`${mark}${label}`, `model:${choice.id}`).row();
    }
    await ctx.reply(t().model.modelHeader, {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(MODEL_CALLBACK_RE, async (ctx) => {
    if (!mayChooseModel(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const chosen = ctx.match?.[1] ?? "";
    const state = await routeStateFor(ctx, await getState(ctx));
    if (state.activeProvider === "pi") {
      await piModelPress(ctx, state, chosen);
      return;
    }
    const choice = getModels(state.activeProvider).find(
      (model) => model.id === chosen
    );
    if (!choice) {
      await ctx.answerCallbackQuery({ text: t().model.noSuchModel });
      return;
    }
    // Clearing the override leaves the half unset, which is the one state the
    // router waits for: the next message in this thread is routed again.
    const model = chosen === AUTO_MODEL ? undefined : chosen;
    const pick = await resolveThreadPick(state);
    if (model !== pick.model) {
      retireRun(state);
    }
    await rememberThreadPick(state, { ...pick, model });
    const label =
      chosen === AUTO_MODEL
        ? noOverrideLabel(
            await routedFor({
              half: "model",
              provider: state.activeProvider,
              userId: state.userId,
            })
          )
        : modelLabel(choice);
    await ctx.answerCallbackQuery({ text: t().model.modelToast(label) });
    await ctx.editMessageText(t().model.modelSet(label));
  });

  // A switch row left in an old `/model` message: the choice is a default in
  // `/settings` now.
  bot.callbackQuery(MODEL_ROUTING_CALLBACK_RE, async (ctx) => {
    await ctx.answerCallbackQuery({ text: t().model.routingMoved });
  });

  bot.command("effort", async (ctx) => {
    if (!mayChooseModel(ctx)) {
      await ctx.reply(t().notForYou);
      return;
    }
    const state = await routeStateFor(ctx, await getState(ctx));
    const pick = await resolveThreadPick(state);
    const spoken = await effortModel(state, pick.model);
    if (spoken.kind === "none") {
      await ctx.reply(t().model.pi.noList);
      return;
    }
    const levels = getEffortLevelsFor(state.activeProvider, spoken.model);
    if (levels.length === 0) {
      await ctx.reply(t().model.noEffort);
      return;
    }
    const current = pick.effort ?? AUTO_EFFORT;
    const noOverride = noOverrideLabel(
      await routedFor({
        half: "effort",
        provider: state.activeProvider,
        userId: state.userId,
      })
    );
    const keyboard = new InlineKeyboard();
    keyboard
      .text(
        `${current === AUTO_EFFORT ? "✓ " : ""}${noOverride}`,
        `effort:${AUTO_EFFORT}`
      )
      .row();
    for (const choice of levels) {
      const mark = choice.id === current ? "✓ " : "";
      keyboard
        .text(`${mark}${effortLabel(choice)}`, `effort:${choice.id}`)
        .row();
    }
    await ctx.reply(t().model.effortHeader, {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(EFFORT_CALLBACK_RE, async (ctx) => {
    if (!mayChooseModel(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const chosen = ctx.match?.[1] ?? "";
    const state = await routeStateFor(ctx, await getState(ctx));
    const { model } = await resolveThreadPick(state);
    const choice =
      chosen === AUTO_EFFORT
        ? {
            id: AUTO_EFFORT,
            label: noOverrideLabel(
              await routedFor({
                half: "effort",
                provider: state.activeProvider,
                userId: state.userId,
              })
            ),
          }
        : await effortChoice(state, model, chosen);
    if (!choice) {
      await ctx.answerCallbackQuery({ text: t().noSuchOption });
      return;
    }
    const effort = chosen === AUTO_EFFORT ? undefined : chosen;
    const pick = await resolveThreadPick(state);
    if (effort !== pick.effort) {
      retireRun(state);
    }
    await rememberThreadPick(state, { ...pick, effort });
    const label = effortLabel(choice);
    await ctx.answerCallbackQuery({ text: t().model.effortToast(label) });
    await ctx.editMessageText(t().model.effortSet(label));
  });
};
