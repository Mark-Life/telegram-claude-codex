import { isRunnable, snapshotOf } from "@workspace/agent";
import { decodeProviderId } from "@workspace/agent/registry";
import type { ProviderId } from "@workspace/agent/types";
import { Effect, Option } from "effect";

import { accessOf } from "../access/context";
import type { AccessInfo, BotContext } from "../access/context";
import { runAccessFor } from "../access/run-access";
import { getSetting, getThread, pinThread } from "../db/bridge";
import type { ThreadEntry } from "../db/threads";
import { runtime } from "../runtime";
import { routeKey } from "../telegram/route";
import type { Route } from "../telegram/route";
import { effectiveProviders } from "./agent-bridge";
import { defaultProviderOf, readUserSettings } from "./chat-defaults";
import type { StoredSettings, providerChoiceOf } from "./chat-defaults";
import { lightProviderFor } from "./light-defaults";
import { routeView } from "./session-routing";
import type { UserState } from "./user-state";

/**
 * Which provider a route runs on, resolved for every run and every command
 * rather than cached with the conversation, so a `/provider` in a topic
 * reaches the owner and executors writing there at once. Light and scratch
 * runs always take the light provider.
 */

/**
 * Where the provider came from. Only `topic` and `owner` are a stored choice
 * someone made; the other two are the detected roles and never refuse.
 */
type ProviderSource = "default" | "light" | "owner" | "topic";

export interface ProviderRoute {
  provider: ProviderId;
  source: ProviderSource;
}

/**
 * The owner's own choice for their private chat; none when unset or naming a
 * provider this build does not have.
 */
export const ownerChoice = async () =>
  decodeProviderId(await getSetting("owner_provider"));

/** Whether `id` can take a run now, by the last check. */
export const runnableNow = (id: ProviderId) =>
  isRunnable(snapshotOf(effectiveProviders().snapshots, id).status);

/**
 * The provider a person's new conversations start on (`/settings`): the one
 * they chose, or the detected default for "Авто", while it can run; else
 * none, and the route falls through.
 */
const ownDefault = (stored: StoredSettings) => {
  const own = defaultProviderOf(stored, effectiveProviders().default);
  return own !== undefined && runnableNow(own) ? own : undefined;
};

/**
 * `startProviderOf` on what the caller read: the owner's choice for their
 * private chat (`owner_provider`) and whether a provider can run now.
 */
export const startProviderWith = (input: {
  choice: ReturnType<typeof providerChoiceOf>;
  detected: ProviderId;
  owner: boolean;
  ownerChoice: Option.Option<ProviderId>;
  runnable: (id: ProviderId) => boolean;
}) => {
  const { choice, detected } = input;
  if (choice.kind === "chosen" && input.runnable(choice.provider)) {
    return choice.provider;
  }
  if (choice.kind === "detected" || !input.owner) {
    return detected;
  }
  return Option.getOrElse(input.ownerChoice, () => detected);
};

/**
 * The provider a person's new conversation would start on now in their
 * private chat (a workspace topic with no usable choice starts on the
 * detected one): their choice while it can run, the detected default for
 * "Авто"; with no usable choice, the owner's new private conversations
 * follow their private chat (`owner_provider`) and everyone else's the
 * detected default, as `routeProvider` routes them. `/settings` describes
 * its model and effort rows on it, and a task that names no provider of its
 * own fires on it.
 */
export const startProviderOf = async (input: {
  choice: ReturnType<typeof providerChoiceOf>;
  detected: ProviderId;
  owner: boolean;
}) =>
  startProviderWith({
    ...input,
    ownerChoice: input.owner ? await ownerChoice() : Option.none(),
    runnable: runnableNow,
  });

/**
 * An executor's private topic was pinned by a run, not chosen, and nobody can
 * `/provider` it: when its provider is down, re-pin it to the default, which
 * starts a fresh conversation there instead of refusing every message.
 */
const repinToDefault = async (row: ThreadEntry, provider: ProviderId) => {
  runtime.runFork(
    Effect.log("provider.topic_repinned").pipe(
      Effect.annotateLogs({ from: row.provider, to: provider })
    )
  );
  await pinThread({
    chatId: row.chatId,
    projectPath: row.projectPath,
    provider,
    threadId: row.threadId,
  });
};

/**
 * The provider for this update's route, first match wins:
 * 1. a light or scratch run (groups, guests, members): the owner's light
 *    choice when it can take the run, else the light provider, even inside
 *    a pinned topic, because it runs in scratch and never
 *    touches the topic's row;
 * 2. a forum topic: its `threads` row, read now; in an executor's private
 *    chat a row whose provider is down is re-pinned to their default;
 * 3. a forum topic with no row yet, which this message starts: the sender's
 *    own default provider (`/settings`) while it can run;
 * 4. the owner's private chat, and a topic there with no row when the owner
 *    has no default: `owner_provider`, else the detected default;
 * 5. anything else (an executor's private chat outside a topic, a
 *    workspace's General topic): the detected default.
 *
 * A private chat never follows a default on its own: only `/new` moves it
 * onto one (`startOnDefault`), so a default never moves a running
 * conversation. An executor's private chat outside a topic shares its
 * session with the owner's (one per project and provider), so it stays on
 * the detected default; their own topics follow their default. The sender's
 * settings are read only when a rule needs them.
 */
export const routeProvider = async (input: {
  access: AccessInfo;
  /**
   * A read leaves a down topic's pin as it is (`/context`): only a run or a
   * command that acts on the conversation moves it.
   */
  readOnly?: boolean;
  state: Pick<UserState, "chatId" | "threadId" | "userId">;
}): Promise<ProviderRoute> => {
  const providers = effectiveProviders();
  const { access } = input;
  const decision = runAccessFor(access);
  if (decision.scratch !== false || decision.agent.modelClass === "light") {
    return {
      provider: await lightProviderFor(decision.agent),
      source: "light",
    };
  }
  const fallback: ProviderRoute = {
    provider: providers.default,
    source: "default",
  };
  const { chatId, threadId, userId } = input.state;
  const inPrivate = access.surface === "private";
  if (threadId !== null) {
    const row = await getThread({ chatId, threadId });
    const pinnedByRun = inPrivate && access.tier !== "owner";
    if (
      row !== undefined &&
      pinnedByRun &&
      input.readOnly !== true &&
      !runnableNow(row.provider)
    ) {
      const next =
        ownDefault(await readUserSettings(userId)) ?? providers.default;
      if (next !== row.provider) {
        await repinToDefault(row, next);
        return { provider: next, source: "default" };
      }
    }
    if (row !== undefined) {
      return { provider: row.provider, source: "topic" };
    }
    const own = ownDefault(await readUserSettings(userId));
    if (own !== undefined) {
      return { provider: own, source: "default" };
    }
  }
  if (access.tier === "owner" && inPrivate) {
    return Option.match(await ownerChoice(), {
      onNone: () => fallback,
      onSome: (provider): ProviderRoute => ({ provider, source: "owner" }),
    });
  }
  return fallback;
};

/**
 * The conversation on its route's provider, for a command that reads or
 * writes its session or pick (`/compact`, `/model`, `/effort`, `/history`).
 */
export const routeStateFor = async (ctx: BotContext, state: UserState) => {
  const { provider } = await routeProvider({ access: accessOf(ctx), state });
  return routeView(state, provider);
};

/** How many `/provider` switches each route has had since boot. */
const switches = new Map<string, number>();

/** Switches a route has had so far; compare two reads to see one happen. */
export const routeSwitchCount = (route: Route) =>
  switches.get(routeKey(route)) ?? 0;

/**
 * Count a `/provider` switch on a route. A run that resolved its provider
 * before the switch but has not started yet sees the count move and stops.
 */
export const markRouteSwitched = (route: Route) => {
  switches.set(routeKey(route), routeSwitchCount(route) + 1);
};
