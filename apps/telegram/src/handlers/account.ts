import {
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Option,
  Predicate,
  Result,
} from "effect";
import { InputFile } from "grammy";
import QRCode from "qrcode";

import type { BotContext } from "../access/context";
import { AccountActions, ACCOUNT_ACTION_CALLBACK } from "../account/actions";
import { WritesMode } from "../account/writes-mode";
import { t } from "../i18n";
import { routeOf, threadOpts } from "../telegram/route";
import type { Route } from "../telegram/route";
import { TelegramAccount } from "../telegram/telegram-account";
import type {
  AccountSelf,
  TelegramAccountError,
} from "../telegram/telegram-account";
import { TelegramBot } from "../telegram/telegram-bot";
import type { HandlerDeps } from "./deps";
import { swallow } from "./helpers";
import { ownerPrivate } from "./login";
import type { LoginRow, LoginTarget, LoginVerb } from "./login";

/**
 * The owner's own Telegram account as a `/login` entry: signing in sends a QR
 * code the owner scans in Settings → Devices, then asks for the cloud password
 * when the account has one and deletes that message the moment it is read.
 * Also the confirmation buttons under a write a run asked for.
 */

const LOGIN_MINUTES = 5;
const LOGIN_TIMEOUT = Duration.minutes(LOGIN_MINUTES);
const QR_WIDTH_PX = 512;
const QR_MARGIN = 2;

/** The account as the owner recognises it: name, and handle when it has one. */
export const nameOf = (self: AccountSelf) =>
  self.username === undefined ? self.name : `${self.name} (@${self.username})`;

const failureText = (error: TelegramAccountError) => {
  switch (error.reason) {
    case "flood": {
      return t().account.flood;
    }
    case "off": {
      return t().account.off;
    }
    case "forward-restricted":
    case "not-logged-in":
    case "peer-not-found":
    case "rpc":
    case "unknown": {
      return t().account.loginFailed;
    }
    default: {
      return t().account.loginFailed;
    }
  }
};

/** A command: the password prompt lets it through instead of reading it as the password. */
const isCommand = (text: string | undefined) => text?.startsWith("/") ?? false;

/** A login in progress: its signal, the topic it runs in, and its fiber once forked. */
interface AccountFlow {
  controller: AbortController;
  fiber?: Fiber.Fiber<void>;
  route: Route;
}

/** Whether an update comes from the topic the flow runs in. */
const inRoute = (ctx: BotContext, route: Route) => {
  const from = routeOf(ctx);
  return (
    from !== null &&
    from.chatId === route.chatId &&
    from.threadId === route.threadId
  );
};

/**
 * Register the password prompt and the confirmation buttons, and hand back
 * the account's `/login` entry.
 */
export const registerAccountHandlers = Effect.fnUntraced(function* (
  deps: HandlerDeps
) {
  const account = yield* TelegramAccount;
  const actions = yield* AccountActions;
  const telegram = yield* TelegramBot;
  const writesMode = (yield* WritesMode).current;
  // Login flows live in this set: closing the registering scope at shutdown
  // interrupts one that is still waiting for a scan.
  const logins = yield* FiberSet.make();
  const fork = yield* FiberSet.runtime(logins)();
  const runPromise = yield* FiberSet.runtimePromise(logins)();
  // A confirmation press runs a write to its end even at shutdown: the owner
  // pressed the button, so the drain waits for it instead of cutting it.
  const context = yield* Effect.context();
  const runTracked = async <A>(effect: Effect.Effect<A>) =>
    await deps.pendingWork.track(Effect.runPromiseWith(context)(effect));

  // Where a failed confirmation is reported: the owner's private chat.
  const ownerRoute: Route = { chatId: deps.ownerId, threadId: null };

  /** The one login in progress; the owner has one account and one chat. */
  let active: AccountFlow | undefined;
  /** Set while the flow waits for the cloud password in the flow's topic. */
  let passwordWaiter:
    | {
        readonly reject: (reason: Error) => void;
        readonly resolve: (password: string) => void;
        readonly route: Route;
      }
    | undefined;

  const say = (route: Route, text: string) =>
    telegram.sendTo(route, text).pipe(Effect.asVoid, Effect.ignore);

  const deleteQuietly = (route: Route, messageId: number) =>
    telegram
      .use(
        "deleteMessage",
        async (api) => await api.deleteMessage(route.chatId, messageId),
        { logLevel: "debug", retry: "all" }
      )
      .pipe(Effect.ignore);

  const login = Effect.fnUntraced(function* (flow: AccountFlow) {
    const { controller, route } = flow;
    let qrMessageId: number | undefined;

    const showQr = Effect.fnUntraced(function* (url: string) {
      const png = yield* Effect.promise(
        async () =>
          await QRCode.toBuffer(url, {
            margin: QR_MARGIN,
            type: "png",
            width: QR_WIDTH_PX,
          })
      );
      const sent = yield* telegram.use(
        "sendPhoto",
        async (api) =>
          await api.sendPhoto(
            route.chatId,
            new InputFile(png, "telegram-login.png"),
            { caption: t().account.qrCaption, ...threadOpts(route) }
          )
      );
      if (controller.signal.aborted) {
        // The flow ended while this code was on its way.
        yield* deleteQuietly(route, sent.message_id);
        return;
      }
      const previous = qrMessageId;
      qrMessageId = sent.message_id;
      if (previous !== undefined) {
        yield* deleteQuietly(route, previous);
      }
    });

    const askPassword = async (hint: string | undefined) => {
      await runPromise(say(route, t().account.askPassword(hint)));
      // Cancelled while the prompt was sent: the abort listener already ran,
      // so a waiter set now would take the owner's next message.
      if (controller.signal.aborted) {
        throw new Error("login aborted");
      }
      const answer = Promise.withResolvers<string>();
      passwordWaiter = { ...answer, route };
      return await answer.promise;
    };
    controller.signal.addEventListener("abort", () => {
      passwordWaiter?.reject(new Error("login aborted"));
      passwordWaiter = undefined;
    });

    const outcome = yield* account
      .login({
        onPasswordInvalid: async () => {
          await runPromise(say(route, t().account.wrongPassword));
        },
        onQr: async (url) => {
          await runPromise(showQr(url));
        },
        password: askPassword,
        signal: controller.signal,
      })
      .pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            controller.abort();
          })
        ),
        Effect.timeoutOption(LOGIN_TIMEOUT),
        Effect.result
      );

    const cancelled = controller.signal.aborted;
    controller.abort();
    active = undefined;
    if (qrMessageId !== undefined) {
      yield* deleteQuietly(route, qrMessageId);
    }
    if (Result.isSuccess(outcome) && Option.isSome(outcome.success)) {
      yield* say(route, t().account.loggedIn(nameOf(outcome.success.value)));
      return;
    }
    if (Result.isSuccess(outcome)) {
      yield* say(route, t().account.timedOut);
      return;
    }
    yield* cancelled
      ? say(route, t().login.cancelled)
      : Effect.logWarning("telegram account login failed").pipe(
          Effect.annotateLogs({ reason: outcome.failure.reason }),
          Effect.andThen(say(route, failureText(outcome.failure)))
        );
  }, Effect.withSpan("TelegramAccount.loginFlow"));

  const logout = Effect.fnUntraced(function* (route: Route) {
    const done = yield* account.logout.pipe(Effect.result);
    yield* say(
      route,
      Result.isSuccess(done)
        ? t().account.loggedOutDone
        : t().account.logoutFailed
    );
  });

  const state = Effect.gen(function* () {
    const copy = t().login.menu;
    const status = yield* account.status;
    if (Predicate.isTagged(status, "off")) {
      return { line: copy.off, verbs: [] } satisfies LoginRow;
    }
    if (active !== undefined) {
      return { line: copy.running, verbs: ["cancel"] } satisfies LoginRow;
    }
    if (!Predicate.isTagged(status, "logged-in")) {
      return { line: copy.loggedOut, verbs: ["in"] } satisfies LoginRow;
    }
    const writes =
      (yield* writesMode) === "confirm"
        ? t().account.writesConfirm
        : t().account.writesDirect;
    return {
      line: copy.loggedInAs({ name: nameOf(status.self), writes }),
      verbs: ["out"],
    } satisfies LoginRow;
  });

  const press = Effect.fnUntraced(function* (route: Route, verb: LoginVerb) {
    if (verb === "out") {
      yield* logout(route);
    } else if (verb === "cancel") {
      const flow = active;
      flow?.controller.abort();
      // Let the flow say it was cancelled, so the redrawn menu no longer
      // shows it running.
      if (flow?.fiber !== undefined) {
        yield* Fiber.await(flow.fiber);
      }
    } else if (active === undefined) {
      // Set before the fork, so the menu redrawn right after the press
      // already shows the login running.
      const flow: AccountFlow = {
        controller: new AbortController(),
        route,
      };
      active = flow;
      flow.fiber = fork(login(flow));
    }
  });

  const target: LoginTarget = {
    key: "tg",
    name: () => t().login.menu.telegram,
    // The QR code, the password prompt and every result go to the topic
    // where the sign-in was pressed; a cancel is told there too.
    press: async ({ route, verb }) => {
      await runPromise(press(route, verb));
    },
    state: async () => await runPromise(state),
  };

  // The password arrives as a plain message in the flow's topic while the
  // flow waits for it. It is taken before any other handler sees it —
  // compose, runs and the transcript never hold it — and deleted from the
  // chat at once. A message in another topic is left to its own run.
  const awaitingPassword = (ctx: BotContext) =>
    passwordWaiter !== undefined &&
    ownerPrivate(ctx) &&
    inRoute(ctx, passwordWaiter.route) &&
    !isCommand(ctx.message?.text);

  deps.bot.filter(awaitingPassword).on("message:text", async (ctx) => {
    const waiter = passwordWaiter;
    if (waiter === undefined) {
      return;
    }
    passwordWaiter = undefined;
    const deleted = await runPromise(
      telegram
        .use(
          "deleteMessage",
          async (api) =>
            await api.deleteMessage(
              waiter.route.chatId,
              ctx.message.message_id
            ),
          { retry: "all" }
        )
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
    );
    if (!deleted) {
      await runPromise(say(waiter.route, t().account.passwordNotDeleted));
    }
    waiter.resolve(ctx.message.text);
  });

  // The buttons under a write a run asked for. Only ALLOWED_USER_ID may press
  // them; the check stays even though confirmations go to the owner's chat.
  deps.bot.callbackQuery(ACCOUNT_ACTION_CALLBACK, async (ctx) => {
    if (ctx.from.id !== deps.ownerId) {
      await ctx.answerCallbackQuery({ text: t().notYourButton }).catch(swallow);
      return;
    }
    const groups = ACCOUNT_ACTION_CALLBACK.exec(ctx.callbackQuery.data)?.groups;
    const verb = groups?.verb ?? "";
    const id = groups?.id ?? "";
    const approve = verb === "ok";
    // A write can outlast Telegram's window for answering the press (a flood
    // wait, a slow network), so the press is answered at once and the
    // confirmation message is edited with the outcome.
    if (approve) {
      await ctx
        .answerCallbackQuery({ text: t().account.executing })
        .catch(swallow);
    }
    const text = await runTracked(
      actions.decide({ approve, id: Number(id) }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("account action decision failed", error).pipe(
            Effect.map(() => t().tryAgain),
            Effect.tap((failed) =>
              approve ? say(ownerRoute, failed) : Effect.void
            )
          )
        )
      )
    );
    if (!approve) {
      await ctx.answerCallbackQuery({ text }).catch(swallow);
    }
  });
  return target;
});
