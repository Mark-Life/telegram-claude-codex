import { Option, Schema } from "effect";

/** Secret shapes stripped from any error copy before it reaches durable storage. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[\w.-]+/giu,
  /\bsk-[A-Za-z0-9_-]{8,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]+/gu,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}/gu,
];

/** Longest error copy kept; anything past this is truncated. */
const MAX_LENGTH = 240;

/**
 * Sanitizes an error string for durable storage: collapses all whitespace to
 * single spaces, redacts common secret shapes (Bearer/sk-/xox-/bot-token), then
 * caps the length. Pure and unit-testable; never returns a secret substring.
 */
export const clipError = (msg: string) => {
  let redacted = msg.replaceAll(/\s+/gu, " ").trim();
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted.length > MAX_LENGTH
    ? redacted.slice(0, MAX_LENGTH)
    : redacted;
};

/** Effect's tagged failures carry a string `_tag`; plain errors do not. */
const decodeTagged = Schema.decodeUnknownOption(
  Schema.Struct({ _tag: Schema.String })
);

/**
 * Class name for a caught value: Effect's `_tag` when present, then
 * `Error.name`, then `fallback`. A caught value has no domain type, so this
 * module is the single boundary that accepts one and names it.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value is unknown by construction; naming it is this function's job
export const errorClassOf = (error: unknown, fallback: string) => {
  const tagged = decodeTagged(error);
  if (Option.isSome(tagged)) {
    return tagged.value._tag;
  }
  return error instanceof Error ? error.name : fallback;
};

/** True when a filesystem read failed only because the file is not there. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- same boundary: the value comes from a catch clause
export const isMissingFile = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
