import { Option, Predicate, Schema, SchemaTransformation } from "effect";

/**
 * A nullable column read as an optional key: NULL decodes to an absent key,
 * and an absent key or an explicit `undefined` encodes to NULL, so a write
 * always binds a value `bun:sqlite` accepts. The domain records keep the
 * `field?: T` shape the rest of the codebase already reads.
 *
 * `Schema.optional`, not `optionalKey`, on the type side: the handlers build
 * writes straight from Telegram objects (`username: message.chat.username`),
 * so a key is often present with the value `undefined`, and the repo has no
 * `exactOptionalPropertyTypes` to reject it at compile time.
 */
export const OptionalFromNull = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(
      Schema.optional(Schema.toType(schema)),
      SchemaTransformation.transformOptional<
        S["Type"] | undefined,
        S["Type"] | null
      >({
        decode: (value) => value.pipe(Option.filter(Predicate.isNotNull)),
        encode: (value) =>
          Option.some(
            value.pipe(
              Option.filter(Predicate.isNotUndefined),
              Option.getOrNull
            )
          ),
      })
    )
  );

/** An epoch-milliseconds timestamp, the unit every table stores. */
export const Millis = Schema.Int;

/** An INTEGER PRIMARY KEY / AUTOINCREMENT id. */
export const RowId = Schema.Int;
