import { Forbidden } from "@workspace/api";
import { Effect } from "effect";

/** Helpers every group's handlers share. */

/** Epoch milliseconds as the API's ISO 8601 instant. */
export const isoOf = (millis: number) => new Date(millis).toISOString();

/** `isoOf`, or undefined when there is no instant. */
export const optionalIso = (millis: number | undefined) =>
  millis === undefined ? undefined : isoOf(millis);

/**
 * `{[key]: value}`, or nothing when the value is undefined: an optional key
 * of a response schema is absent or holds a value, never `undefined`.
 */
export const field = <K extends string, V>(
  key: K,
  value: V | undefined
): Partial<Record<K, V>> => {
  const present: Partial<Record<K, V>> = {};
  if (value !== undefined) {
    present[key] = value;
  }
  return present;
};

/**
 * Refuse a holder whose tier lacks `what`, as the chat answers a member who
 * asks for /tasks. Every key holder passes today; the check keeps the rule
 * where the chat keeps it.
 */
export const operatorOnly = (allowed: boolean, what: string) =>
  allowed
    ? Effect.void
    : Effect.fail(
        new Forbidden({
          message: `Only the owner and executors manage ${what}.`,
        })
      );
