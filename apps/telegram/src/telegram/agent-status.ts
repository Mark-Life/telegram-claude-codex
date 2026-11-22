import { Effect, Option, Semaphore } from "effect";
import { InlineKeyboard } from "grammy";

import { t } from "../i18n";
import {
  applyAgentEvent,
  boardSettled,
  closeBoard,
  emptyBoard,
  renderBoard,
} from "./agent-board";
import type { AgentBoard, AgentEventOf } from "./agent-board";
import { EDIT_INTERVAL_MS } from "./format";
import { routeKey } from "./route";
import type { Route } from "./route";
import { TelegramBot } from "./telegram-bot";

/**
 * The live status of a run's sub-agents and workflows: one message per batch,
 * sent when the first one starts and edited in place at most once per
 * `EDIT_INTERVAL_MS`. A batch ends once everything in it ended and the turn
 * that started it answered (a workflow a parked run waits on ends it later),
 * or when the run ends: its message then turns into the summary, and the
 * next agent opens a new one under the answer.
 *
 * The message is pinned while it is live, without a sound, and unpinned at
 * the end. Only private chats and the workspace forum show it (a group's
 * and a guest's runs are quiet). A pin that fails (no right to pin, the
 * chat unpinned it by hand) costs nothing but the pin.
 */

/** How often a live board is redrawn when only its clocks moved. */
const CLOCK_REFRESH_MS = 5000;

/** Whose run a status shows. */
export interface AgentStatusOptions {
  /** Who may press its stop button, the run's own user. */
  readonly userId: number;
}

/** The callback the stop button sends: `agents_stop:<user id>`. */
export const AGENTS_STOP_RE = /^agents_stop:(?<value>\d+)$/u;

/** The live status message pinned in each chat and topic, by route. */
const pinned = new Map<string, number>();

/** Every live status message, `<chat id>:<message id>`. */
const live = new Set<string>();

const liveKey = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

/**
 * Whether a status message is still live. A finished one whose summary edit
 * failed may still show its button, which must stop nothing.
 */
export const isLiveAgentStatus = (chatId: number, messageId: number) =>
  live.has(liveKey(chatId, messageId));

/** Telegram's words for an edit of a message that is gone or frozen. */
const GONE_RE = /message to edit not found|message can't be edited/u;

/** One run's status message. */
export const createAgentStatus = (
  route: Route,
  options: AgentStatusOptions
) => {
  const lock = Semaphore.makeUnsafe(1);
  let board: AgentBoard | undefined;
  let messageId: number | undefined;
  let isPinned = false;
  let dirty = false;
  let lastDraw = 0;
  let drawn = "";
  /** The turn that started the batch answered. */
  let answered = false;
  /**
   * Telegram refused the batch's message for good (a bad request, no right
   * to write): the batch draws nothing more.
   */
  let refused = false;

  const keyboard = () =>
    new InlineKeyboard().text(t().agents.stop, `agents_stop:${options.userId}`);

  const pin = (id: number) =>
    Effect.gen(function* () {
      const bot = yield* TelegramBot;
      const key = routeKey(route);
      const before = pinned.get(key);
      if (before !== undefined && before !== id) {
        yield* bot
          .use(
            "unpinChatMessage",
            async (api) => await api.unpinChatMessage(route.chatId, before),
            { logLevel: "debug" }
          )
          .pipe(Effect.ignore);
      }
      const ok = yield* bot
        .use(
          "pinChatMessage",
          async (api) =>
            await api.pinChatMessage(route.chatId, id, {
              disable_notification: true,
            }),
          { logLevel: "debug" }
        )
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        );
      if (ok) {
        pinned.set(key, id);
        isPinned = true;
      }
    });

  const unpin = (id: number) =>
    Effect.gen(function* () {
      if (!isPinned) {
        return;
      }
      isPinned = false;
      const key = routeKey(route);
      if (pinned.get(key) === id) {
        pinned.delete(key);
      }
      const bot = yield* TelegramBot;
      yield* bot
        .use(
          "unpinChatMessage",
          async (api) => await api.unpinChatMessage(route.chatId, id),
          { logLevel: "debug" }
        )
        .pipe(Effect.ignore);
    });

  /** Drop a message: no longer live, pinned or edited. */
  const forget = (id: number) =>
    Effect.gen(function* () {
      live.delete(liveKey(route.chatId, id));
      yield* unpin(id);
      if (messageId === id) {
        messageId = undefined;
        drawn = "";
      }
    });

  /** Send the board, or edit it in; a failed live edit waits for the next. */
  const draw = (current: AgentBoard, final: boolean) =>
    Effect.gen(function* () {
      if (refused) {
        return;
      }
      const bot = yield* TelegramBot;
      const now = Date.now();
      const html = renderBoard(current, now, final);
      lastDraw = now;
      dirty = false;
      if (messageId === undefined) {
        const sent = yield* bot
          .sendTo(route, html, {
            disable_notification: true,
            parse_mode: "HTML",
            reply_markup: final ? undefined : keyboard(),
          })
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("TelegramBotError", (error) => {
              refused =
                error.reason === "BadRequest" || error.reason === "Forbidden";
              return Effect.succeedNone;
            })
          );
        if (Option.isNone(sent)) {
          dirty = true;
          return;
        }
        messageId = sent.value.message_id;
        drawn = html;
        if (!final) {
          live.add(liveKey(route.chatId, messageId));
          yield* pin(messageId);
        }
        return;
      }
      if (html === drawn && !final) {
        return;
      }
      const id = messageId;
      const edited = yield* bot
        .use(
          "editMessageText",
          async (api) =>
            await api.editMessageText(route.chatId, id, html, {
              parse_mode: "HTML",
              reply_markup: final ? undefined : keyboard(),
            }),
          // The summary must land; a live edit is superseded by the next.
          final ? { retry: "all" } : { logLevel: "debug", retry: false }
        )
        .pipe(
          Effect.as("edited" as const),
          Effect.catchTag("TelegramBotError", (error) => {
            if (error.reason === "NotModified") {
              return Effect.succeed("edited" as const);
            }
            return Effect.succeed(
              error.reason === "BadRequest" && GONE_RE.test(error.description)
                ? ("gone" as const)
                : ("failed" as const)
            );
          })
        );
      if (edited === "edited") {
        drawn = html;
        return;
      }
      if (edited === "gone") {
        // Deleted by hand: the next draw sends the board again.
        yield* forget(id);
      } else if (final) {
        // The summary did not land: at least take the button away.
        yield* bot
          .use(
            "editMessageReplyMarkup",
            async (api) => await api.editMessageReplyMarkup(route.chatId, id),
            { logLevel: "debug" }
          )
          .pipe(Effect.ignore);
      }
      dirty = true;
    });

  /** Turn the batch into its summary and let the next one start fresh. */
  const finish = (current: AgentBoard) =>
    Effect.gen(function* () {
      closeBoard(current, Date.now());
      yield* draw(current, true);
      if (messageId !== undefined) {
        yield* forget(messageId);
      }
      board = undefined;
      answered = false;
      refused = false;
    });

  const settleIfDone = Effect.suspend(() =>
    board !== undefined && answered && boardSettled(board)
      ? finish(board)
      : Effect.void
  );

  return {
    /** The turn answered: a batch that ended closes now, one still live later. */
    answered: Effect.suspend(() => {
      answered = true;
      return settleIfDone;
    }).pipe(Semaphore.withPermit(lock)),

    /** Fold in one sub-agent event; the first start sends the message. */
    apply: (event: AgentEventOf) =>
      Effect.gen(function* () {
        if (board === undefined) {
          if (event.kind !== "agent_started") {
            return;
          }
          board = emptyBoard(Date.now());
        }
        // A new agent of the run's own reopens the batch until the next
        // answer; a workflow's next wave, after a parked run answered, does
        // not.
        if (
          event.kind === "agent_started" &&
          (event.agent.parentId === undefined ||
            !board.nodes.has(event.agent.parentId))
        ) {
          answered = false;
        }
        applyAgentEvent(board, event, Date.now());
        dirty = true;
        // The first start shows at once; a send that failed waits a beat.
        if (
          messageId === undefined &&
          Date.now() - lastDraw >= EDIT_INTERVAL_MS
        ) {
          yield* draw(board, false);
        }
      }).pipe(Semaphore.withPermit(lock)),

    /** The run ended: whatever still runs is stopped, and the batch closes. */
    close: Effect.suspend(() =>
      board === undefined ? Effect.void : finish(board)
    ).pipe(Semaphore.withPermit(lock)),

    /**
     * A deferred redraw, from the stream's edit loop: what changed, at most
     * once per interval, and the clocks every few seconds.
     */
    flush: Effect.suspend(() => {
      if (board === undefined) {
        return Effect.void;
      }
      if (answered && boardSettled(board)) {
        return finish(board);
      }
      const since = Date.now() - lastDraw;
      return (dirty && since >= EDIT_INTERVAL_MS) || since >= CLOCK_REFRESH_MS
        ? draw(board, false)
        : Effect.void;
    }).pipe(Semaphore.withPermit(lock)),
  };
};

export type AgentStatus = ReturnType<typeof createAgentStatus>;
