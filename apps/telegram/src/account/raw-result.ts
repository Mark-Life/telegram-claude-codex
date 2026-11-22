import { getMarkedPeerId, Long } from "@mtcute/bun";
import { Predicate } from "effect";
import type { Json } from "effect/Schema";

import { MAX_OUTPUT_BYTES, MAX_TEXT_CHARS, clip } from "./present";

/**
 * A raw call's answer, made fit for the run: plain JSON, `Long` as a decimal
 * string, bytes as their size, access hashes and file references dropped
 * (they are credentials the run has no use for), long strings and arrays
 * clipped, depth capped. A peer, chat or channel also gets `marked_id`, the
 * id the account tools take (`-id` for a chat, `-100…` for a channel), so a
 * bare `channelId` is never passed back as a user's. The whole answer stays
 * within the output cap: the array cap shrinks until it fits, and
 * `outputText` cuts what still does not.
 */

const DROPPED = new Set(["accessHash", "fileReference"]);
const MAX_DEPTH = 12;
const FIRST_ARRAY_CAP = 100;
const SECOND_ARRAY_CAP = 20;
const LAST_ARRAY_CAP = 5;
/** Array caps tried in turn until the answer fits. */
const ARRAY_CAPS = [FIRST_ARRAY_CAP, SECOND_ARRAY_CAP, LAST_ARRAY_CAP];

/** Where a constructor keeps its bare id, and the kind of peer it names. */
const BARE_IDS: ReadonlyMap<
  string,
  readonly [field: string, kind: "channel" | "chat" | "user"]
> = new Map([
  ["channel", ["id", "channel"]],
  ["channelForbidden", ["id", "channel"]],
  ["chat", ["id", "chat"]],
  ["chatForbidden", ["id", "chat"]],
  ["peerChannel", ["channelId", "channel"]],
  ["peerChat", ["chatId", "chat"]],
  ["peerUser", ["userId", "user"]],
]);

/** The marked id of a pruned peer, chat or channel; undefined for others. */
const markedIdOf = (
  fields: Readonly<Record<string, Json>>
): number | undefined => {
  const tag = fields._;
  const rule = Predicate.isString(tag) ? BARE_IDS.get(tag) : undefined;
  const id = rule === undefined ? undefined : fields[rule[0]];
  return rule !== undefined && Predicate.isNumber(id)
    ? getMarkedPeerId(id, rule[1])
    : undefined;
};

const pruneAt = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a raw call's answer is whatever Telegram sent; this walk is where it is parsed
  value: unknown,
  depth: number,
  arrayCap: number
): Json => {
  if (value === null || value === undefined) {
    return null;
  }
  if (Long.isLong(value)) {
    return value.toString();
  }
  if (Predicate.isUint8Array(value)) {
    return `<${value.length} bytes>`;
  }
  if (Predicate.isString(value)) {
    return clip(value, MAX_TEXT_CHARS);
  }
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return value;
  }
  if (Predicate.isBigInt(value)) {
    return value.toString();
  }
  if (depth >= MAX_DEPTH) {
    return "<too deep>";
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, arrayCap)
      .map((item) => pruneAt(item, depth + 1, arrayCap));
    return value.length > arrayCap
      ? [...kept, { _truncated: value.length - arrayCap }]
      : kept;
  }
  if (Predicate.isObject(value)) {
    const fields: [string, Json][] = [];
    for (const [key, field] of Object.entries(value)) {
      if (!DROPPED.has(key) && !Predicate.isFunction(field)) {
        fields.push([key, pruneAt(field, depth + 1, arrayCap)]);
      }
    }
    const pruned = Object.fromEntries(fields);
    const markedId = markedIdOf(pruned);
    return markedId === undefined ? pruned : { ...pruned, marked_id: markedId };
  }
  return null;
};

/** The answer of one raw call as the run reads it, within the output cap. */
export const rawAnswer = (input: {
  readonly class: "mark" | "read";
  readonly method: string;
  readonly result: unknown;
}) => {
  const wrap = (arrayCap: number) => ({
    class: input.class,
    method: input.method,
    result: pruneAt(input.result, 0, arrayCap),
    untrusted_content: true,
  });
  for (const cap of ARRAY_CAPS) {
    const answer = wrap(cap);
    if (Buffer.byteLength(JSON.stringify(answer)) <= MAX_OUTPUT_BYTES) {
      return answer;
    }
  }
  return wrap(LAST_ARRAY_CAP);
};
