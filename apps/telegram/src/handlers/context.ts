import { getProvider, supportsCompaction } from "@workspace/agent";
import type { SessionContext } from "@workspace/db";
import { InlineKeyboard } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { fitSession } from "../access/provider-access";
import { runAccessFor } from "../access/run-access";
import { isOperator } from "../access/tier";
import { getSessionContext } from "../db/bridge";
import { t } from "../i18n";
import { runDirOf } from "../runs/start-run";
import { bar, escapeHtml, shortTokens } from "../telegram/format";
import { isRunning } from "./agent-bridge";
import type { HandlerDeps } from "./deps";
import { removedKeyboard } from "./helpers";
import { routeProvider } from "./route-provider";
import { routeView, storedSessionId } from "./session-routing";
import { getState } from "./user-state";

/**
 * `/context`: how full the context window of the conversation this chat or
 * topic resumes is, as its provider's CLI counted it at the last request
 * (`session_context`, written by every run that keeps its session). A read
 * of one row: it never starts a provider. The session is the one the
 * caller's own next run would resume, so a sandboxed caller sees their
 * scratch conversation, never the owner's.
 */

const FULL = 100;

/**
 * The percentage the provider's CLI shows: the tokens over the window, with
 * the baseline it counts as fixed (Codex's) left out of both.
 */
const percentOf = (figure: SessionContext) => {
  const baseline = figure.baselineTokens ?? 0;
  const room = (figure.windowTokens ?? 0) - baseline;
  return room <= 0
    ? undefined
    : (Math.max(0, figure.usedTokens - baseline) / room) * FULL;
};

/** The figure as lines: the number first, so a screen reader reaches it first. */
const figureLines = (figure: SessionContext) => {
  const copy = t().session.context;
  const shown = percentOf(figure);
  if (figure.windowTokens === undefined || shown === undefined) {
    return [copy.tokensOnly(shortTokens(figure.usedTokens))];
  }
  // Rounded like the CLIs round it, the bar drawn from the same number; past
  // 100% the number says so and the bar stays full.
  const rounded = Math.round(shown);
  return [
    `${copy.used(rounded)} ${bar(rounded)}`,
    copy.tokens(
      shortTokens(figure.usedTokens),
      shortTokens(figure.windowTokens)
    ),
    ...(figure.modelWindowTokens === undefined
      ? []
      : [
          copy.modelWindow(
            shortTokens(figure.windowTokens),
            shortTokens(figure.modelWindowTokens)
          ),
        ]),
    ...(figure.compactAt === undefined
      ? []
      : [copy.compactAt(shortTokens(figure.compactAt))]),
  ];
};

/** «Sum up» where the provider compacts, and «Start over». */
const contextKeyboard = (input: { compacts: boolean; userId: number }) => {
  const copy = t().session.context;
  const keyboard = new InlineKeyboard();
  if (input.compacts) {
    keyboard.text(copy.buttonCompact, `context_compact:${input.userId}`);
  }
  return keyboard.text(copy.buttonNew, `context_new:${input.userId}`);
};

/** What `/context` answers, and its buttons when the caller may press them. */
const contextReply = async (ctx: BotContext) => {
  const copy = t().session.context;
  const access = accessOf(ctx);
  const state = await getState(ctx);
  const route = await routeProvider({ access, readOnly: true, state });
  const decision = runAccessFor(access);
  if (!fitSession(route, decision.agent).persistSession) {
    return { text: copy.notKept };
  }
  const conversation = routeView(state, route.provider);
  const sessionId = await storedSessionId(
    conversation,
    runDirOf(decision, state)
  );
  // A compaction holds the slot too (`/compact` parks the queue for it), but
  // records no figure while it runs.
  const compacting = state.parkedQueue !== undefined;
  const running = isRunning(state) && !compacting;
  if (sessionId === undefined) {
    // A new conversation's first run names its session only once it starts.
    return { text: running ? copy.noFigureRunning : copy.noSession };
  }
  const figure = await getSessionContext({
    provider: route.provider,
    sessionId,
  });
  const title = copy.title(
    escapeHtml(getProvider(route.provider).displayName),
    figure?.model === undefined ? undefined : escapeHtml(figure.model)
  );
  // `/new` and `/compact` write the conversation's session, which only an
  // operator may (`maySteerSession`).
  const operator = isOperator(access.tier);
  const waiting = running ? copy.noFigureRunning : copy.noFigure;
  const lines = [
    title,
    ...(figure === undefined ? [waiting] : figureLines(figure)),
    ...(running && figure !== undefined ? [copy.live] : []),
    ...(compacting ? [copy.compacting] : []),
    ...(operator && figure !== undefined && !compacting ? [copy.free] : []),
  ];
  return {
    keyboard: operator
      ? contextKeyboard({
          // One compaction at a time: a second would replay the session
          // underneath the first.
          compacts: supportsCompaction(route.provider) && !compacting,
          userId: state.userId,
        })
      : undefined,
    text: lines.join("\n"),
  };
};

export const registerContextHandlers = ({ bot }: HandlerDeps) => {
  bot.command("context", async (ctx) => {
    const reply = await contextReply(ctx);
    await ctx.reply(reply.text, {
      parse_mode: "HTML",
      reply_markup: reply.keyboard ?? removedKeyboard,
    });
  });
};
