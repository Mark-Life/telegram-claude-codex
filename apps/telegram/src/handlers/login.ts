import { snapshotOf } from "@workspace/agent";
import { listProviders } from "@workspace/agent/registry";
import type {
  AgentProvider,
  DeviceLogin,
  LoginProcess,
} from "@workspace/agent/types";
import { InlineKeyboard } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { isOwner } from "../access/tier";
import { t } from "../i18n";
import { logError, logInfo } from "../log";
import { sendTo } from "../telegram/bridge";
import { syncPrivateCommands } from "../telegram/commands";
import { routeOf } from "../telegram/route";
import type { Route } from "../telegram/route";
import {
  effectiveProviders,
  refreshProviders,
  reprobeInBackground,
} from "./agent-bridge";
import type { HandlerDeps } from "./deps";
import { LOGIN_CALLBACK_RE, logRejection, swallow } from "./helpers";
import { deviceAuthMessage, isCompleteDeviceAuth } from "./login-parse";

/**
 * `/login`: one menu for everything the owner signs in to from the chat — their
 * own Telegram account and each provider with a device flow. Every entry shows
 * its status and the presses that apply now: sign in, sign out, cancel a
 * sign-in in progress. A new provider is one more entry, not a new command.
 * Owner-only and private-chat-only.
 */

const LOGIN_VERBS = ["cancel", "in", "out"] as const;

/** What a press asks of an entry. */
export type LoginVerb = (typeof LOGIN_VERBS)[number];

/** An entry's line in the menu right now, and the presses it takes. */
export interface LoginRow {
  line: string;
  verbs: readonly LoginVerb[];
}

/** One thing `/login` signs in to. */
export interface LoginTarget {
  /** The entry's part of its buttons' callback data: `login:<key>:<verb>`. */
  key: string;
  name: () => string;
  /**
   * Do what the press asked; a long sign-in runs on after this returns. A
   * cancel returns once the flow ended, so the redraw shows it gone.
   */
  press: (input: { route: Route; verb: LoginVerb }) => Promise<void>;
  state: () => Promise<LoginRow>;
}

/** Whether this update comes from the owner in their private chat. */
export const ownerPrivate = (ctx: BotContext) =>
  isOwner(accessOf(ctx).tier) && ctx.chat?.type === "private";

/** The menu: one line per entry, one row of buttons per entry with presses. */
const menuOf = async (targets: readonly LoginTarget[]) => {
  const copy = t().login.menu;
  const rows = await Promise.all(
    targets.map(async (target) => ({ row: await target.state(), target }))
  );
  const keyboard = new InlineKeyboard();
  for (const { row, target } of rows) {
    for (const verb of row.verbs) {
      keyboard.text(
        copy.button[verb](target.name()),
        `login:${target.key}:${verb}`
      );
    }
    if (row.verbs.length > 0) {
      keyboard.row();
    }
  }
  const lines = rows.map(({ row, target }) => `${target.name()}: ${row.line}`);
  return { keyboard, text: [copy.header, ...lines].join("\n") };
};

const MINUTES_TO_WAIT = 10;
const MS_PER_MINUTE = 60_000;
/** How long the device flow may stay open before the child is killed. */
export const LOGIN_TIMEOUT_MS = MINUTES_TO_WAIT * MS_PER_MINUTE;
/** How long to collect the CLI's opening output before answering the owner. */
const PROMPT_WINDOW_MS = 8000;
/** How long a cancel waits for the flow to wind down before the menu redraws. */
const CANCEL_WAIT_MS = 5000;

/**
 * Read the device-auth prompt out of a live process: whatever it printed in the
 * first few seconds, without waiting for it to exit — it only exits once the
 * owner has approved the login.
 *
 * Reading stops once both the link and the code are in hand, not at the link:
 * the CLI prints them several lines apart, and stopping at the first `https://`
 * sends the owner a link and no code to type into it.
 */
const readPrompt = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const deadline = Date.now() + PROMPT_WINDOW_MS;
  let seen = "";
  try {
    while (Date.now() < deadline) {
      // A read waits for the next output, so it is raced against the window:
      // a CLI that goes quiet before the code still gets an answer sent.
      // oxlint-disable-next-line no-await-in-loop -- reading a stream is sequential by nature
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()),
      ]);
      if (next === undefined || next.done) {
        break;
      }
      seen += decoder.decode(next.value, { stream: true });
      if (isCompleteDeviceAuth(seen)) {
        break;
      }
    }
  } catch {
    // A closed stream is just the end of the output; report what arrived.
  } finally {
    reader.releaseLock();
  }
  return seen;
};

/** Kill the login process once the owner's window to approve has passed. */
const withTimeout = async (proc: {
  exited: Promise<number>;
  kill: () => void;
}) => {
  const timer = setTimeout(() => {
    proc.kill();
  }, LOGIN_TIMEOUT_MS);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * After a login the owner approved: check every provider again and recompute
 * which one new conversations use, then refresh the owner's menu, which
 * lists `/provider` by the same snapshot.
 */
const afterLogin = async (ownerId: number) => {
  await refreshProviders();
  await syncPrivateCommands({ tier: "owner", userId: ownerId });
};

/** A device flow in progress, and whether the owner cancelled it. */
interface DeviceFlow {
  cancelled: boolean;
  /** Settles once the flow told the owner how it ended. */
  ended?: Promise<void>;
  proc?: LoginProcess;
}

/**
 * A provider's device flow as a `/login` entry (`codex login --device-auth`
 * today): it prints a link and a code, which the owner opens on whatever
 * device they are holding; the process exits once the browser side is
 * approved, and the credentials land where the provider's next run reads
 * them. This is the account every run bills to, so signing out stays in the
 * shell.
 */
const deviceLoginTarget = (
  { ownerId, pendingWork }: HandlerDeps,
  provider: Pick<AgentProvider, "displayName" | "id"> & {
    deviceLogin: DeviceLogin;
  }
): LoginTarget => {
  let active: DeviceFlow | undefined;

  /** Own the whole flow so the press returns immediately. */
  const runDeviceAuth = async (input: {
    bin: string;
    flow: DeviceFlow;
    route: Route;
  }) => {
    const { bin, flow } = input;
    const say = async (text: string) => {
      await sendTo(input.route, text);
    };
    await say(t().login.connecting);
    try {
      flow.proc = provider.deviceLogin.start(bin);
    } catch (error) {
      logError(`${provider.id} login spawn failed`, error);
      await say(t().login.spawnFailed);
      return;
    }
    const { proc } = flow;
    try {
      if (flow.cancelled) {
        // Cancelled while the process was starting.
        proc.kill();
      }
      const prompt =
        proc.stdout instanceof ReadableStream
          ? await readPrompt(proc.stdout)
          : "";
      if (!flow.cancelled) {
        await say(deviceAuthMessage(prompt));
      }
    } catch (error) {
      // The owner never got the link, so nobody can approve this one.
      proc.kill();
      throw error;
    }
    const exitCode = await withTimeout(proc);
    if (exitCode === 0) {
      // Approved, even when a cancel arrived as it exited.
      await afterLogin(ownerId);
      await say(t().login.done);
      return;
    }
    await say(flow.cancelled ? t().login.cancelled : t().login.failed);
  };

  const state = async (): Promise<LoginRow> => {
    const copy = t().login.menu;
    if (active !== undefined) {
      return { line: copy.running, verbs: ["cancel"] };
    }
    const snapshot = snapshotOf(effectiveProviders().snapshots, provider.id);
    if (snapshot.bin === undefined) {
      // Installed since the last check: the next /login sees it.
      reprobeInBackground([provider.id]);
      return { line: copy.notInstalled, verbs: [] };
    }
    const status = await provider.deviceLogin.status(snapshot.bin);
    if (status.exitCode !== 0) {
      logInfo(`${provider.id} login status: ${status.output}`);
      return { line: copy.loggedOut, verbs: ["in"] };
    }
    if (snapshot.status !== "ready") {
      // Logged in from a shell since the last check: pick it up now.
      pendingWork
        .track(afterLogin(ownerId))
        .catch(logRejection(`${provider.id} provider refresh`));
    }
    return { line: copy.loggedIn, verbs: [] };
  };

  const press: LoginTarget["press"] = async ({ route, verb }) => {
    if (verb === "cancel") {
      const flow = active;
      if (flow !== undefined) {
        flow.cancelled = true;
        flow.proc?.kill();
        await flow.ended;
      }
      return;
    }
    const { bin } = snapshotOf(effectiveProviders().snapshots, provider.id);
    if (verb !== "in" || active !== undefined || bin === undefined) {
      return;
    }
    const flow: DeviceFlow = { cancelled: false };
    active = flow;
    // The device flow lives for minutes; grammy handles one update at a time,
    // so awaiting it here would freeze every other command until it ended.
    flow.ended = pendingWork
      .track(
        runDeviceAuth({ bin, flow, route }).finally(() => {
          active = undefined;
        })
      )
      .catch(logRejection(`${provider.id} login`));
  };

  return { key: provider.id, name: () => provider.displayName, press, state };
};

/**
 * Register `/login` and its buttons over the owner's Telegram account and
 * every provider with a device flow.
 */
export const registerLoginHandlers = (
  deps: HandlerDeps,
  account: LoginTarget
) => {
  const targets = [
    account,
    ...listProviders().flatMap(({ deviceLogin, displayName, id }) =>
      deviceLogin === undefined
        ? []
        : [deviceLoginTarget(deps, { deviceLogin, displayName, id })]
    ),
  ];

  deps.bot.command("login", async (ctx) => {
    if (!isOwner(accessOf(ctx).tier)) {
      await ctx.reply(t().notForYou);
      return;
    }
    if (!ownerPrivate(ctx)) {
      await ctx.reply(t().login.menu.privateOnly);
      return;
    }
    const menu = await menuOf(targets);
    await ctx.reply(menu.text, { reply_markup: menu.keyboard });
  });

  deps.bot.callbackQuery(LOGIN_CALLBACK_RE, async (ctx) => {
    const route = routeOf(ctx);
    if (!ownerPrivate(ctx) || route === null) {
      await ctx.answerCallbackQuery({ text: t().notYourButton }).catch(swallow);
      return;
    }
    const { key, verb } =
      LOGIN_CALLBACK_RE.exec(ctx.callbackQuery.data)?.groups ?? {};
    const target = targets.find((candidate) => candidate.key === key);
    const pressed = LOGIN_VERBS.find((candidate) => candidate === verb);
    if (target === undefined || pressed === undefined) {
      await ctx.answerCallbackQuery({ text: t().noSuchOption }).catch(swallow);
      return;
    }
    // Answered first: reading an entry's state may run its CLI.
    await ctx.answerCallbackQuery().catch(swallow);
    // A stale button (the state moved on since the menu was drawn) does
    // nothing; the redraw below shows what applies now.
    const now = await target.state();
    if (now.verbs.includes(pressed)) {
      const pressing = target.press({ route, verb: pressed });
      // A cancel ends a flow that may be stuck on the network: the redraw
      // waits for it a little, not forever.
      await (pressed === "cancel"
        ? Promise.race([pressing, Bun.sleep(CANCEL_WAIT_MS)])
        : pressing);
    }
    const menu = await menuOf(targets);
    await ctx
      .editMessageText(menu.text, { reply_markup: menu.keyboard })
      .catch(swallow);
  });
};
