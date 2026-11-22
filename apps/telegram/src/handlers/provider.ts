import {
  decodeProviderId,
  getProvider,
  orderedSnapshots,
  snapshotOf,
} from "@workspace/agent";
import type { EffectiveProviders, ProviderSnapshot } from "@workspace/agent";
import type { ProviderId } from "@workspace/agent/types";
import { Effect, Option } from "effect";
import { InlineKeyboard } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { isOwner } from "../access/tier";
import { getThread, pinThread, setSetting } from "../db/bridge";
import { t } from "../i18n";
import { runtime } from "../runtime";
import {
  effectiveProviders,
  reprobeInBackground,
  stopRouteRuns,
} from "./agent-bridge";
import { defaultProviderOf, readUserSettings } from "./chat-defaults";
import type { HandlerDeps } from "./deps";
import { PROVIDER_CALLBACK_RE } from "./helpers";
import {
  markRouteSwitched,
  routeProvider,
  runnableNow,
} from "./route-provider";
import type { ProviderRoute } from "./route-provider";
import { forgetSession, routeView } from "./session-routing";
import { dropRoutePlans, getState } from "./user-state";
import type { UserState } from "./user-state";

/**
 * `/provider`: which agent answers in this conversation, the owner's choice.
 * In a forum topic it is the topic's row, which the owner and executors
 * writing there follow (members, guests and groups stay on the light
 * provider); in the owner's private chat it is `owner_provider`. A switch starts a
 * new conversation, like a project switch, and stops whatever was running
 * there. The menu reads the last check of each provider and starts a fresh
 * one in the background, so the handler never waits on a CLI; the next
 * `/provider` shows what it found.
 */

export const nameOf = (id: ProviderId) => getProvider(id).displayName;

const isReady = (snapshot: ProviderSnapshot) => snapshot.status === "ready";

/** Whether `id` can take a switch now, by the last check. */
export const readyNow = (id: ProviderId) =>
  isReady(snapshotOf(effectiveProviders().snapshots, id));

/** The menu for `current`: text, plus one button per ready provider. */
const menuOf = (providers: EffectiveProviders, current: ProviderId) => {
  const copy = t().provider.menu;
  const all = orderedSnapshots(providers.snapshots);
  const ready = all.filter(isReady);
  const idle = all
    .filter((snapshot) => !isReady(snapshot))
    .map(({ id, status }) => `${nameOf(id)} — ${copy.notReady[status]}`);
  const only =
    ready.length === 1 && ready[0] !== undefined
      ? [copy.onlyOne(nameOf(ready[0].id))]
      : [];
  const keyboard = new InlineKeyboard();
  for (const { id } of ready) {
    const mark = id === current ? "✓ " : "";
    keyboard.text(`${mark}${nameOf(id)}`, `provider:${id}`).row();
  }
  return { keyboard, text: [copy.header, ...idle, ...only].join("\n") };
};

/**
 * The route a switch may change: a topic's row, or the owner's choice for
 * their private chat. A light route (any group run of the owner outside the
 * workspace) and the workspace's General topic have no choice to make.
 */
export const switchableRoute = async (ctx: BotContext, state: UserState) => {
  const inPlace =
    state.threadId !== null || accessOf(ctx).surface === "private";
  const route = inPlace
    ? await routeProvider({ access: accessOf(ctx), state })
    : undefined;
  return route?.source === "light" ? undefined : route;
};

/** Point the conversation at `next` and stop what was running in it. */
export const switchTo = async (input: {
  next: ProviderId;
  route: ProviderRoute;
  state: UserState;
}) => {
  const { next, state } = input;
  const { chatId, threadId } = state;
  if (threadId === null) {
    await setSetting({ key: "owner_provider", value: next });
    // Switching back must never silently resume a stale session.
    await forgetSession(routeView(state, next));
  } else {
    const row = await getThread({ chatId, threadId });
    await pinThread({
      chatId,
      projectPath: row?.projectPath ?? state.activeProject,
      provider: next,
      threadId,
    });
  }
  // A plan belongs to the old provider's session; feedback on it would
  // reach the new provider with no plan behind it.
  dropRoutePlans({ chatId, threadId });
  markRouteSwitched({ chatId, threadId });
  const stopped = stopRouteRuns({ chatId, threadId }, "switched");
  runtime.runFork(
    Effect.log("provider.switched").pipe(
      Effect.annotateLogs({
        from: input.route.provider,
        source: input.route.source,
        stopped,
        to: next,
      })
    )
  );
};

/**
 * Where `/new` may move this conversation's provider: the owner's private
 * chat and any topic of theirs, and an executor's own private topics. An
 * executor's private chat outside a topic shares its session with the
 * owner's, and a workspace topic is everyone's, so neither moves for them.
 */
const newMoves = (ctx: BotContext, state: UserState) => {
  const { surface, tier } = accessOf(ctx);
  const inPrivate = surface === "private";
  if (isOwner(tier)) {
    return state.threadId !== null || inPrivate ? "moves" : "stays";
  }
  if (!inPrivate) {
    return "stays";
  }
  return state.threadId === null ? "shared" : "moves";
};

/**
 * `/new` onto the caller's default provider (`/settings`) when `route` (this
 * conversation's, resolved once by `/new`) is elsewhere: the same switch as
 * `/provider`, so the default's old conversation is never resumed. Answers
 * what happened, for the reply: moved (and whether the shared private chat
 * did, which executors lose too), the default is down, the chat is an
 * executor's shared one that keeps its provider, or nothing to do.
 */
export const startOnDefault = async (input: {
  ctx: BotContext;
  route: ProviderRoute;
  state: UserState;
}) => {
  const { ctx, route, state } = input;
  const where = newMoves(ctx, state);
  const next =
    route.source === "light" || where === "stays"
      ? undefined
      : defaultProviderOf(
          await readUserSettings(state.userId),
          effectiveProviders().default
        );
  if (next === undefined || next === route.provider) {
    return { kind: "stayed" } as const;
  }
  if (where === "shared") {
    return { kind: "shared" } as const;
  }
  if (!runnableNow(next)) {
    return { kind: "down", name: nameOf(next) } as const;
  }
  await switchTo({ next, route, state });
  return {
    kind: "moved",
    name: nameOf(next),
    privateChat: state.threadId === null,
  } as const;
};

/** What the owner reads after a switch. */
const switchedText = (next: ProviderId, privateChat: boolean) => {
  const copy = t().provider.menu;
  const done = copy.switched(nameOf(next));
  // Private conversations are kept per project and provider, not per user.
  return privateChat ? `${done} ${copy.executorsToo(nameOf(next))}` : done;
};

export const registerProviderHandlers = ({ bot }: HandlerDeps) => {
  bot.command("provider", async (ctx) => {
    if (!isOwner(accessOf(ctx).tier)) {
      await ctx.reply(t().provider.menu.notOwner);
      return;
    }
    const state = await getState(ctx);
    const route = await switchableRoute(ctx, state);
    if (route === undefined) {
      await ctx.reply(t().provider.menu.notHere);
      return;
    }
    const menu = menuOf(effectiveProviders(), route.provider);
    await ctx.reply(menu.text, { reply_markup: menu.keyboard });
    reprobeInBackground();
  });

  bot.callbackQuery(PROVIDER_CALLBACK_RE, async (ctx) => {
    if (!isOwner(accessOf(ctx).tier)) {
      await ctx.answerCallbackQuery({ text: t().provider.menu.notOwner });
      return;
    }
    const chosen = decodeProviderId(ctx.match?.[1]);
    if (Option.isNone(chosen)) {
      await ctx.answerCallbackQuery({ text: t().noSuchOption });
      return;
    }
    const next = chosen.value;
    const state = await getState(ctx);
    const route = await switchableRoute(ctx, state);
    if (route === undefined) {
      await ctx.answerCallbackQuery({ text: t().provider.menu.notHere });
      return;
    }
    if (route.provider === next) {
      const text = t().provider.menu.already(nameOf(next));
      await ctx.answerCallbackQuery({ text });
      await ctx.editMessageText(text);
      return;
    }
    if (!readyNow(next)) {
      await ctx.answerCallbackQuery({
        text: t().provider.unavailable(nameOf(next)),
      });
      return;
    }
    await switchTo({ next, route, state });
    const text = switchedText(next, state.threadId === null);
    await ctx.answerCallbackQuery({
      text: t().provider.menu.switchedToast(nameOf(next)),
    });
    await ctx.editMessageText(text);
  });
};
