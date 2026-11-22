import { Schema } from "effect";

/** An instant as every endpoint shows it. */
export const IsoTime = Schema.String.annotate({
  description: "An ISO 8601 instant in UTC.",
  format: "date-time",
});

/**
 * A row id in a path: digits only, so a handler reads it with `Number` and
 * the OpenAPI document keeps the parameter's description.
 */
export const pathId = (description: string) =>
  Schema.String.check(Schema.isPattern(/^[1-9]\d{0,14}$/u)).annotate({
    description,
  });
