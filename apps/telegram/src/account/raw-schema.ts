import { Context, Data, Effect, Layer, Schema } from "effect";

/**
 * The Telegram API schema mtcute ships (`@mtcute/core/tl/api-schema.json`,
 * one TL layer) and its error list (`raw-errors.json`), read for the raw API
 * tools. Both files are about 2 MB, so they are read on the first raw call,
 * never at boot, and decoded against only the fields used here: nothing is
 * imported as typed JSON.
 */

/** The schema files could not be read or decoded: a broken install. */
export class RawSchemaError extends Data.TaggedError("RawSchemaError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const RawArgumentSchema = Schema.Struct({
  comment: Schema.optional(Schema.String),
  /** snake_case, as the schema writes it; the wire takes it camelCase. */
  name: Schema.String,
  /** A primitive, a boxed type, `#` for flags or `!X` in the wrappers. */
  type: Schema.String,
  typeModifiers: Schema.optional(
    Schema.Struct({
      isVector: Schema.optional(Schema.Boolean),
      /** `flags.N`: the argument is optional. */
      predicate: Schema.optional(Schema.String),
    })
  ),
});

const RawEntrySchema = Schema.Struct({
  arguments: Schema.Array(RawArgumentSchema),
  available: Schema.optional(Schema.Literals(["user", "bot", "both"])),
  comment: Schema.optional(Schema.String),
  kind: Schema.Literals(["class", "method"]),
  name: Schema.String,
  /** A class: the type it builds. A method: the type it returns. */
  type: Schema.String,
  typeModifiers: Schema.optional(
    Schema.Struct({ isVector: Schema.optional(Schema.Boolean) })
  ),
});

const ApiSchemaFile = Schema.Struct({
  e: Schema.Array(RawEntrySchema),
  l: Schema.Int,
  /** The comment of each union type, by its name. */
  u: Schema.Record(Schema.String, Schema.String),
});

const RawErrorsFile = Schema.Struct({
  errors: Schema.Record(
    Schema.String,
    Schema.Struct({
      code: Schema.Int,
      description: Schema.optional(Schema.String),
      name: Schema.String,
    })
  ),
  throws: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});

export type RawArgument = typeof RawArgumentSchema.Type;
export type RawEntry = typeof RawEntrySchema.Type;
type ApiSchema = typeof ApiSchemaFile.Type;

/** One error a method may fail with. */
interface RawError {
  readonly code: number;
  readonly description: string;
  readonly name: string;
}

/** The schema of one layer, indexed for lookups. */
export interface RawIndex {
  readonly classes: ReadonlyMap<string, RawEntry>;
  /** Every constructor of a boxed type, mtcute's own dummies left out. */
  readonly constructorsByType: ReadonlyMap<string, readonly RawEntry[]>;
  readonly errorsByMethod: ReadonlyMap<string, readonly RawError[]>;
  readonly layer: number;
  readonly methods: ReadonlyMap<string, RawEntry>;
  readonly unionComments: ReadonlyMap<string, string>;
}

const readJson = <S extends Schema.Codec<unknown, unknown>>(
  file: string,
  schema: S
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new RawSchemaError({ cause, message: `Could not read ${file}` }),
    try: async () => {
      const resolved = Bun.resolveSync(file, import.meta.dir);
      const json: unknown = await Bun.file(resolved).json();
      return json;
    },
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof RawSchemaError
        ? error
        : new RawSchemaError({
            cause: error,
            message: `${file} does not match the expected schema`,
          })
    )
  );

/** The API schema as mtcute ships it, decoded; no index, no service. */
export const readApiSchema = readJson(
  "@mtcute/core/tl/api-schema.json",
  ApiSchemaFile
);

const readErrors = readJson("@mtcute/core/tl/raw-errors.json", RawErrorsFile);

/** How the namespace of a root name (`invokeWithLayer`) is keyed. */
export const ROOT_NAMESPACE = "(root)";

/** The namespace of a TL name: `messages` of `messages.getHistory`. */
export const namespaceOf = (name: string) => {
  const dot = name.indexOf(".");
  return dot === -1 ? ROOT_NAMESPACE : name.slice(0, dot);
};

/** A name without its namespace: `getHistory` of `messages.getHistory`. */
export const localName = (name: string) => name.slice(name.indexOf(".") + 1);

const groupBy = (entries: readonly RawEntry[]) => {
  const byType = new Map<string, RawEntry[]>();
  for (const entry of entries) {
    const list = byType.get(entry.type) ?? [];
    list.push(entry);
    byType.set(entry.type, list);
  }
  return byType;
};

const buildIndex = (
  api: ApiSchema,
  errors: typeof RawErrorsFile.Type
): RawIndex => {
  const methods = api.e.filter((entry) => entry.kind === "method");
  const classes = api.e.filter((entry) => entry.kind === "class");
  const errorsByMethod = new Map<string, readonly RawError[]>();
  for (const [method, names] of Object.entries(errors.throws)) {
    errorsByMethod.set(
      method,
      names.flatMap((name) => {
        const known = errors.errors[name];
        return known === undefined
          ? []
          : [
              {
                code: known.code,
                description: known.description ?? "",
                name: known.name,
              },
            ];
      })
    );
  }
  return {
    classes: new Map(classes.map((entry) => [entry.name, entry])),
    constructorsByType: groupBy(
      classes.filter((entry) => namespaceOf(entry.name) !== "mtcute")
    ),
    errorsByMethod,
    layer: api.l,
    methods: new Map(methods.map((entry) => [entry.name, entry])),
    unionComments: new Map(Object.entries(api.u)),
  };
};

/** Both files read and indexed. */
const loadRawIndex = Effect.map(
  Effect.all([readApiSchema, readErrors], { concurrency: 2 }),
  ([api, errors]) => buildIndex(api, errors)
);

const SNAKE = /_(?<letter>[a-zA-Z\d])/gu;

/** A schema name as the wire takes it: `top_msg_id` → `topMsgId`. */
export const camel = (name: string) =>
  name.replaceAll(SNAKE, (_, letter: string) => letter.toUpperCase());

const SUMMARY_CHARS = 300;
const TAG = /<[^>]+>/gu;
const LINK = /\{@link (?:(?<ns>\w+)\.)?Raw(?<name>\w+?)(?:Request)?\}/gu;
const ENTITIES = new Map([
  ["&amp;", "&"],
  ["&gt;", ">"],
  ["&lt;", "<"],
  ["&quot;", '"'],
]);

/**
 * A schema comment as plain text: no HTML tags, `{@link RawFooBar}` as
 * `FooBar`, clipped to `max`. `firstLine` keeps only its first line, for a
 * summary.
 */
export const cleanComment = (
  comment: string | undefined,
  options: { readonly firstLine?: boolean; readonly max?: number } = {}
) => {
  const plain = (comment ?? "")
    .replaceAll(LINK, (_whole, ns: string | undefined, name: string) =>
      ns === undefined ? name : `${ns}.${name}`
    )
    .replaceAll(TAG, "")
    .replaceAll(
      /&(?:amp|gt|lt|quot);/gu,
      (entity) => ENTITIES.get(entity) ?? ""
    )
    .trim();
  const text =
    options.firstLine === true ? (plain.split("\n")[0] ?? "") : plain;
  const max = options.max ?? SUMMARY_CHARS;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};

/** Whether an argument may be left out: a flag-guarded one. */
export const isOptional = (argument: RawArgument) =>
  argument.typeModifiers?.predicate !== undefined;

/** An argument's type as `tg_describe` shows it: `Vector<T>` for a vector. */
export const typeLabel = (argument: RawArgument) =>
  argument.typeModifiers?.isVector === true
    ? `Vector<${argument.type}>`
    : argument.type;

/** What a method returns, as `tg_describe` shows it. */
export const returnLabel = (entry: RawEntry) =>
  entry.typeModifiers?.isVector === true ? `Vector<${entry.type}>` : entry.type;

/**
 * One line for an entry, flags left out and optional arguments marked `?`:
 * `messages.getUnreadMentions(peer: InputPeer, topMsgId?: int, …): messages.Messages`.
 */
export const signature = (entry: RawEntry) => {
  const args = entry.arguments
    .filter((argument) => argument.type !== "#")
    .map(
      (argument) =>
        `${camel(argument.name)}${isOptional(argument) ? "?" : ""}: ${typeLabel(argument)}`
    )
    .join(", ");
  return `${entry.name}(${args}): ${returnLabel(entry)}`;
};

const make = Effect.gen(function* () {
  const index = yield* Effect.cached(
    loadRawIndex.pipe(Effect.withSpan("RawSchema.load"))
  );
  return { index } as const;
});

/**
 * RawSchema: the indexed API schema, read once, on the first raw call. A
 * failed read stays failed for the process: the files ship with the
 * dependency, so only a broken install fails it.
 */
export class RawSchema extends Context.Service<
  RawSchema,
  Effect.Success<typeof make>
>()("@workspace/RawSchema") {
  static readonly layer = Layer.effect(RawSchema, make);
}
