import type { AgentError } from "@workspace/agent";
import { Predicate } from "effect";

import { t } from "../i18n";

/**
 * What a user is told when a run does not finish: one plain sentence about
 * what happened and what to do next, then the error's own text, mostly
 * English, so the user can tell a login problem from a limit, a broken tool
 * or a provider warning.
 */

/** Longest error text shown to the user; the full one is in the log. */
const MAX_DETAIL_LENGTH = 300;

/** The generic answer: everything that has no recognizable cause. */
export const genericErrorCopy = () => t().errors.generic;

/** The first non-empty line of an error text, cut to length. */
const firstLine = (message: string) => {
  const line = message
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line !== undefined && line.length > MAX_DETAIL_LENGTH
    ? `${line.slice(0, MAX_DETAIL_LENGTH)}…`
    : line;
};

/**
 * The text worth quoting: a crash's message, or the raw message of an error
 * with no tag (a provider warning, a thrown exception). `AtCapacity` and
 * `AgentInterrupted` already say everything in their sentence.
 */
const detailSource = (error?: AgentError, message?: string) => {
  if (error === undefined) {
    return message;
  }
  return Predicate.isTagged(error, "ProviderCrashed")
    ? error.message
    : undefined;
};

/** The error text to quote, or undefined when there is none. */
export const errorDetail = (error?: AgentError, message?: string) => {
  const source = detailSource(error, message);
  return source === undefined ? undefined : firstLine(source);
};

/** A sentence followed by an error text quoted as plain text, when there is one. */
export const withDetail = (sentence: string, message?: string) => {
  const line = message === undefined ? undefined : firstLine(message);
  return line === undefined
    ? sentence
    : `${sentence}\n\n${t().errors.detail(`«${line}»`)}`;
};

/** The one sentence a failed run turns into, without the error text. */
export const errorSentence = (error?: AgentError) =>
  error === undefined ? genericErrorCopy() : t().errors[error._tag];

/** The sentence plus the quoted error text, as plain text. */
export const errorCopy = (error?: AgentError, message?: string) =>
  withDetail(errorSentence(error), detailSource(error, message));

/** The error text as a markdown paragraph to append, or "". */
export const errorDetailMarkdown = (error?: AgentError, message?: string) => {
  const detail = errorDetail(error, message);
  return detail === undefined
    ? ""
    : `\n\n${t().errors.detail(`\`${detail.replaceAll("`", "'")}\``)}`;
};
