import { getVerbositySetting, setVerbositySetting } from "../db";
import {
  parseVerbosity,
  policyFor,
  type Verbosity,
} from "../telegram/render-policy";
import type { HandlerDeps } from "./deps";
import { mainKeyboard } from "./helpers";

/**
 * How much of a run reaches the chat. Quiet is the default and the production
 * mode: an unset setting reads as quiet, so a fresh install is silent until the
 * answer.
 */
export const currentVerbosity = () => parseVerbosity(getVerbositySetting());

/** Render policy matching the verbosity currently stored in the db. */
export const currentRenderPolicy = () => policyFor(currentVerbosity());

/** Flip verbosity, persist it, and return the level it landed on. */
export const toggleVerbosity = () => {
  const next: Verbosity = currentVerbosity() === "full" ? "quiet" : "full";
  setVerbositySetting(next);
  return next;
};

const VERBOSITY_COPY = {
  full: "Verbose ON - tool calls, thinking and the footer will show.",
  quiet: "Verbose OFF - only the answer will show.",
} as const satisfies Record<Verbosity, string>;

/** One line telling the user what a verbosity level means for them. */
export const describeVerbosity = (verbosity: Verbosity) =>
  VERBOSITY_COPY[verbosity];

/** /verbose: no arguments, toggles the render policy for every later run. */
export const registerVerbosityCommand = ({ bot }: HandlerDeps) => {
  bot.command("verbose", async (ctx) => {
    await ctx.reply(describeVerbosity(toggleVerbosity()), {
      reply_markup: mainKeyboard,
    });
  });
};
