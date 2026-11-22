import { oneTurnThreadOptions, turnOn } from "./codex-turns";
import type { OneTurnClient } from "./codex-turns";
import { getProvider } from "./registry";
import type { HelperPick, HelperTurn } from "./types";

/**
 * One cheap pass that turns a script task's raw output into something worth
 * reading in a chat: the provider and model the owner picked for it, else
 * the helper provider's light model or the owner's light tier on it, at low
 * effort unless the owner set a depth for it, a throwaway turn, a read-only
 * working directory and no tools. Every failure answers undefined, so the
 * caller sends the raw output rather than nothing.
 */

/** Input is truncated to this, so a runaway result cannot become a long turn. */
export const MAX_FORMAT_INPUT = 8000;

/** What the pass needs: the raw result and what produced it. */
export interface FormatArgs {
  /** Raw text (or serialized structured output) the task produced. */
  result: string;
  /** Task title, so the model knows what the numbers are about. */
  title: string;
  /** Directory the throwaway thread runs in; read-only, never the bot repo. */
  workingDirectory: string;
}

/** The Codex SDK client slice the pass drives; a test hands in a fake. */
export type FormatClient = OneTurnClient;

/** Clip an over-long result, saying so, so the model does not invent an ending. */
const clip = (result: string) =>
  result.length <= MAX_FORMAT_INPUT
    ? result
    : `${result.slice(0, MAX_FORMAT_INPUT)}\n[truncated]`;

/** The one-turn instruction: format this, invent nothing. */
export const buildFormatPrompt = ({ result, title }: FormatArgs) =>
  [
    `Format this result for a telegram message. It is the output of a recurring task called "${title}".`,
    "Keep every fact and number exactly as given, add nothing, and drop noise like ids and empty fields.",
    "Reply with the message text only: short lines, no preamble, no code fences unless the content is code.",
    "",
    clip(result),
  ].join("\n");

/** Codex thread options of the formatting pass: throwaway, read-only, no tools. */
export const formatThreadOptions = (workingDirectory: string) =>
  oneTurnThreadOptions({ workingDirectory });

/**
 * Format one result on a single turn. Undefined means "send the raw output":
 * an empty result, an empty answer, or any failure at all.
 */
const formatOn = async (turn: HelperTurn, args: FormatArgs) => {
  let text = "";
  if (args.result.trim().length > 0) {
    try {
      const answer = await turn({
        effort: "low",
        prompt: buildFormatPrompt(args),
        workingDirectory: args.workingDirectory,
      });
      text = answer.trim();
    } catch {
      // A formatter that cannot answer must not swallow the result.
    }
  }
  return text.length > 0 ? text : undefined;
};

/** Format on a Codex SDK client (or a fake of one). */
export const formatWith = async (client: FormatClient, args: FormatArgs) =>
  await formatOn(turnOn(client), args);

/**
 * Format one result on `helper`; undefined when the pass did not produce one,
 * including when no provider serves it or the provider has no `oneTurn`. The
 * turn is registered, so a restart waits for it.
 */
export const formatForTelegram = async (
  /** No depth in the pick keeps low; no model keeps the light one. */
  args: FormatArgs & HelperPick
) => {
  const oneTurn =
    args.helper === undefined ? undefined : getProvider(args.helper).oneTurn;
  return oneTurn === undefined
    ? undefined
    : await formatOn(
        async (request) =>
          await oneTurn({
            ...request,
            effort: args.effort ?? request.effort,
            kind: "format",
            label: "task_result",
            model: args.model,
            ownEffort: args.effort,
          }),
        args
      );
};
