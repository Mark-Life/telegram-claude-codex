import { randomBytes } from "node:crypto";

import { getMarkedPeerId, Long } from "@mtcute/bun";
import type { InputPeerLike, Peer, tl } from "@mtcute/bun";
import { Effect, Option, Predicate } from "effect";
import { absurd } from "effect/Function";
import type { Json, JsonArray, JsonObject } from "effect/Schema";

import type {
  TelegramAccountError,
  TelegramAccountHandle,
} from "../telegram/telegram-account";
import { badInput } from "./inputs";
import type { BadInput } from "./inputs";
import { parsePeer, peerLabel } from "./present";
import { camel, isOptional } from "./raw-schema";
import type { RawArgument, RawEntry, RawIndex } from "./raw-schema";

/**
 * A raw call's parameters, checked against the schema of its method and
 * turned into what the wire takes. The writer mtcute ships checks only that
 * required fields are there, never their types, so every value is checked
 * here: an unknown key, a missing argument or a value of the wrong type is
 * `BadInput`.
 *
 * Used twice. When the run asks (`normalizeParams`): the parameters as JSON
 * again, every key camelCase, a peer shortcut resolved and kept as its
 * marked id (so a username that changes hands cannot redirect the write),
 * `hash` and `random_id` filled in (so a retried write is one write to
 * Telegram), and the peers and bytes it holds, for the confirmation. When it
 * is carried out (`buildCall`): the same JSON as the TL object mtcute sends,
 * `long` as `Long`, bytes as `Uint8Array`, each peer as its input peer.
 *
 * The JSON convention: `long` is a decimal string (or a safe integer),
 * bytes and `int128`/`int256` are base64, `Bool` and `true` flags are
 * booleans, a vector is an array, a boxed type is an object whose `_` names a
 * constructor of exactly that type (it may be left out when the type has
 * only one). `InputPeer`, `InputUser` and `InputChannel` take `"me"`, a
 * marked id or a username, and as an object only a constructor that names no
 * one (`inputPeerSelf`, `inputPeerEmpty` and the like), so every peer of a
 * write reaches the owner by name. A bare chat or user id of the methods in
 * `BARE_IDS` is looked up and labelled too.
 */

/** A value as the wire takes it. */
type TlValue =
  | boolean
  | number
  | string
  | Long
  | Uint8Array
  | TlObject
  | tl.TypeInputChannel
  | tl.TypeInputPeer
  | tl.TypeInputUser
  | readonly TlValue[];

/** A TL object: `_` names its constructor or method. */
interface TlObject {
  readonly [key: string]: TlValue;
}

/** A peer a raw write names, by where it sits in the parameters. */
interface RawPeerRef {
  readonly path: string;
  readonly peer: { readonly id: number; readonly label: string };
}

const PEER_KINDS = ["InputPeer", "InputUser", "InputChannel"] as const;
type PeerKind = (typeof PEER_KINDS)[number];

const isPeerKind = (type: string): type is PeerKind =>
  PEER_KINDS.some((kind) => kind === type);

/**
 * The input-peer constructors a run may give as an object: they name no one.
 * Any other (`inputPeerUser` with its access hash, `inputUserFromMessage`
 * and the like) is refused, because only a shortcut is resolved and shown to
 * the owner by name.
 */
const NAMELESS_PEERS: ReadonlySet<string> = new Set([
  "inputChannelEmpty",
  "inputPeerEmpty",
  "inputPeerSelf",
  "inputUserEmpty",
  "inputUserSelf",
]);

/**
 * Arguments that name a chat or user by a bare id rather than an input peer,
 * by the constructor or method that holds them: a basic group's `chat_id`,
 * user ids, and a privacy rule's chats (a basic group or a supergroup, so
 * both marked ids are tried). Each is looked up and labelled, so the owner
 * sees who the write is about.
 */
const BARE_IDS: ReadonlyMap<
  string,
  {
    readonly key: string;
    readonly marks: (id: number) => readonly number[];
  }
> = (() => {
  const chat = {
    key: "chatId",
    marks: (id: number) => [getMarkedPeerId(id, "chat")],
  };
  const chats = {
    key: "chats",
    marks: (id: number) => [
      getMarkedPeerId(id, "chat"),
      getMarkedPeerId(id, "channel"),
    ],
  };
  const users = {
    key: "id",
    marks: (id: number) => [getMarkedPeerId(id, "user")],
  };
  return new Map([
    ["contacts.editCloseFriends", users],
    ["inputPrivacyValueAllowChatParticipants", chats],
    ["inputPrivacyValueDisallowChatParticipants", chats],
    ["messages.addChatUser", chat],
    ["messages.deleteChatUser", chat],
    ["messages.editChatAdmin", chat],
    ["messages.editChatPhoto", chat],
    ["messages.editChatTitle", chat],
    ["messages.migrateChat", chat],
  ]);
})();

/** How deep a parameter object may nest; real methods stay well under. */
const MAX_DEPTH = 10;
/**
 * Longest vector one call may hold, and most peer shortcuts: each shortcut
 * can be a `contacts.resolveUsername` on the live account, and thousands in
 * one call would earn the whole account a long flood wait.
 */
const MAX_RAW_VECTOR = 200;
const MAX_RAW_PEERS = 50;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const LONG_MIN = -9_223_372_036_854_775_808n;
const LONG_MAX = 9_223_372_036_854_775_807n;
const LONG_BYTES = 8;
const INT32_BYTES = 4;
const INT128_BYTES = 16;
const INT256_BYTES = 32;
/** How much of a wrong value an error quotes. */
const QUOTE_CHARS = 40;
const DECIMAL = /^-?\d{1,20}$/u;
const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

export const isJsonArray = (value: Json): value is JsonArray =>
  Array.isArray(value);

/** The object a value is, if it is one: not null, an array or a primitive. */
export const objectOf = (value: Json): JsonObject | undefined =>
  value === null ||
  isJsonArray(value) ||
  Predicate.isString(value) ||
  Predicate.isNumber(value) ||
  Predicate.isBoolean(value)
    ? undefined
    : value;

const quote = (value: Json) => {
  const text = JSON.stringify(value);
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text;
};

const wrongType = (path: string, expected: string, value: Json) =>
  badInput(`${path}: expected ${expected}, got ${quote(value)}.`);

/** A decimal string of a signed 64-bit value, from either JSON form. */
const longOf = (value: Json): Option.Option<string> => {
  if (Predicate.isNumber(value)) {
    return Number.isSafeInteger(value)
      ? Option.some(String(value))
      : Option.none();
  }
  if (!Predicate.isString(value) || !DECIMAL.test(value)) {
    return Option.none();
  }
  const big = BigInt(value);
  return big >= LONG_MIN && big <= LONG_MAX
    ? Option.some(big.toString())
    : Option.none();
};

const randomLong = () => randomBytes(LONG_BYTES).readBigInt64LE().toString();

const randomInt = () => randomBytes(INT32_BYTES).readInt32LE();

/** A required `hash` left out: 0, which asks Telegram for a fresh answer. */
const hashDefault = (argument: RawArgument): Option.Option<Json> => {
  if (argument.type === "long") {
    return Option.some("0");
  }
  return argument.type === "int" ? Option.some(0) : Option.none();
};

/**
 * The value of a required argument the run may leave out: `hash` as 0,
 * `random_id` fresh, a vector of them as long as the sibling `id`.
 */
const defaultOf = (
  argument: RawArgument,
  siblings: JsonObject,
  path: string
): Effect.Effect<Option.Option<Json>, BadInput> => {
  const vector = argument.typeModifiers?.isVector === true;
  if (argument.name === "hash" && !vector) {
    return Effect.succeed(hashDefault(argument));
  }
  if (argument.name !== "random_id") {
    return Effect.succeed(Option.none());
  }
  if (!vector) {
    if (argument.type === "long") {
      return Effect.succeed(Option.some(randomLong()));
    }
    return Effect.succeed(
      argument.type === "int" ? Option.some(randomInt()) : Option.none()
    );
  }
  const ids = siblings.id;
  if (argument.type !== "long" || ids === undefined || !isJsonArray(ids)) {
    return Effect.fail(
      badInput(`${path}: give random_id, one per id, or give id as an array.`)
    );
  }
  return Effect.succeed(Option.some(ids.map(() => randomLong())));
};

/** A primitive value, checked: what it is on the wire, or a flag left out. */
type Checked =
  | {
      readonly kind: "bytes";
      readonly base64: string;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: "long"; readonly decimal: string }
  | { readonly kind: "omit" }
  | { readonly kind: "scalar"; readonly value: boolean | number | string };

type Check = (value: Json, path: string) => Effect.Effect<Checked, BadInput>;

const scalarIf = (input: {
  readonly expected: string;
  readonly ok: boolean;
  readonly path: string;
  readonly value: Json;
}): Effect.Effect<Checked, BadInput> => {
  const { value } = input;
  return input.ok &&
    (Predicate.isString(value) ||
      Predicate.isNumber(value) ||
      Predicate.isBoolean(value))
    ? Effect.succeed({ kind: "scalar", value })
    : Effect.fail(wrongType(input.path, input.expected, value));
};

const bytesOf =
  (length: number | null): Check =>
  (value, path) => {
    if (!Predicate.isString(value) || !BASE64.test(value)) {
      return Effect.fail(wrongType(path, "base64", value));
    }
    const bytes = new Uint8Array(Buffer.from(value, "base64"));
    return length === null || bytes.length === length
      ? Effect.succeed({ base64: value, bytes, kind: "bytes" })
      : Effect.fail(
          badInput(`${path}: expected ${length} bytes, got ${bytes.length}.`)
        );
  };

const isInt32 = (value: Json) =>
  Predicate.isNumber(value) &&
  Number.isInteger(value) &&
  value >= INT32_MIN &&
  value <= INT32_MAX;

/** How each primitive type is checked. A boxed type has no entry. */
const PRIMITIVES = new Map<string, Check>([
  [
    "int",
    (value, path) =>
      scalarIf({
        expected: "a 32-bit integer",
        ok: isInt32(value),
        path,
        value,
      }),
  ],
  [
    "int53",
    (value, path) =>
      scalarIf({
        expected: "a safe integer",
        ok: Predicate.isNumber(value) && Number.isSafeInteger(value),
        path,
        value,
      }),
  ],
  [
    "double",
    (value, path) =>
      scalarIf({
        expected: "a number",
        ok: Predicate.isNumber(value) && Number.isFinite(value),
        path,
        value,
      }),
  ],
  [
    "string",
    (value, path) =>
      scalarIf({
        expected: "a string",
        ok: Predicate.isString(value),
        path,
        value,
      }),
  ],
  [
    "Bool",
    (value, path) =>
      scalarIf({
        expected: "true or false",
        ok: Predicate.isBoolean(value),
        path,
        value,
      }),
  ],
  [
    "true",
    // A flag that is false is a flag left out.
    (value, path) =>
      value === false
        ? Effect.succeed({ kind: "omit" })
        : scalarIf({
            expected: "true or false",
            ok: value === true,
            path,
            value,
          }),
  ],
  [
    "long",
    (value, path) =>
      Option.match(longOf(value), {
        onNone: () =>
          Effect.fail(
            wrongType(path, "a 64-bit integer as a decimal string", value)
          ),
        onSome: (decimal) => Effect.succeed<Checked>({ decimal, kind: "long" }),
      }),
  ],
  ["bytes", bytesOf(null)],
  ["int128", bytesOf(INT128_BYTES)],
  ["int256", bytesOf(INT256_BYTES)],
]);

/** A bare id the walk found, by where it sits and its marked ids to try. */
interface BareId {
  readonly marks: readonly number[];
  readonly path: string;
}

/**
 * Every bare id `BARE_IDS` names in normalized parameters. An object is
 * known by its `_`; the root, a method's arguments, by `name`.
 */
const bareIdsIn = (
  value: Json,
  path: string,
  name?: string
): readonly BareId[] => {
  if (isJsonArray(value)) {
    return value.flatMap((item, at) => bareIdsIn(item, `${path}[${at}]`));
  }
  const object = objectOf(value);
  if (object === undefined) {
    return [];
  }
  const prefix = path === "" ? "" : `${path}.`;
  const tag = object._;
  const holder = name ?? (Predicate.isString(tag) ? tag : undefined);
  const bare = holder === undefined ? undefined : BARE_IDS.get(holder);
  const own: BareId[] = [];
  const ids = bare === undefined ? undefined : object[bare.key];
  if (bare !== undefined && ids !== undefined) {
    const at = `${prefix}${bare.key}`;
    if (Predicate.isNumber(ids)) {
      own.push({ marks: bare.marks(ids), path: at });
    } else if (isJsonArray(ids)) {
      for (const [index, item] of ids.entries()) {
        if (Predicate.isNumber(item)) {
          own.push({ marks: bare.marks(item), path: `${at}[${index}]` });
        }
      }
    }
  }
  const nested = Object.entries(object).flatMap(([key, field]) =>
    bareIdsIn(field, `${prefix}${key}`)
  );
  return [...own, ...nested];
};

/** What one walk does with the values it checked: JSON again, or the wire. */
interface Mode<Out> {
  readonly bytes: (input: {
    readonly base64: string;
    readonly bytes: Uint8Array;
    readonly path: string;
  }) => Out;
  readonly list: (items: readonly Out[]) => Out;
  readonly long: (decimal: string) => Out;
  readonly object: (fields: ReadonlyMap<string, Out>) => Out;
  readonly peer: (input: {
    readonly kind: PeerKind;
    readonly path: string;
    readonly ref: InputPeerLike;
  }) => Effect.Effect<Out, BadInput | TelegramAccountError>;
  readonly scalar: (value: boolean | number | string) => Out;
}

type Walked<A> = Effect.Effect<A, BadInput | TelegramAccountError>;

/** A peer shortcut: `"me"`, a marked id or a username. */
const shortcutOf = (value: Json) =>
  Predicate.isString(value) || Predicate.isNumber(value)
    ? parsePeer(String(value))
    : undefined;

/** The run's keys matched to the entry's arguments; a stray key is BadInput. */
const givenArguments = Effect.fnUntraced(function* (input: {
  readonly entry: RawEntry;
  readonly object: JsonObject;
  readonly prefix: string;
}) {
  const { entry, prefix } = input;
  const byKey = new Map<string, RawArgument>();
  for (const argument of entry.arguments) {
    byKey.set(argument.name, argument);
    byKey.set(camel(argument.name), argument);
  }
  const given = new Map<RawArgument, Json>();
  for (const [key, value] of Object.entries(input.object)) {
    if (key === "_" && prefix !== "") {
      continue;
    }
    const argument = byKey.get(key);
    if (argument === undefined) {
      return yield* badInput(
        `${prefix}${key}: ${entry.name} has no such argument. Use tg_describe ${entry.name}.`
      );
    }
    if (argument.type === "#") {
      return yield* badInput(
        `${prefix}${key}: flags are computed; leave them out.`
      );
    }
    if (given.has(argument)) {
      return yield* badInput(
        `${prefix}${key}: given twice, as snake_case and camelCase.`
      );
    }
    given.set(argument, value);
  }
  return given;
});

/** One walk over a parameter object, by the schema, in one `Mode`. */
class Walker<Out> {
  readonly #index: RawIndex;
  readonly #mode: Mode<Out>;

  constructor(index: RawIndex, mode: Mode<Out>) {
    this.#index = index;
    this.#mode = mode;
  }

  /**
   * The arguments of one constructor or method out of a JSON object, by
   * their camelCase name (the snake_case one is taken too). Flags are left
   * out: the writer computes them.
   */
  fields(input: {
    readonly depth: number;
    readonly entry: RawEntry;
    readonly object: JsonObject;
    readonly path: string;
  }): Walked<readonly (readonly [string, Out])[]> {
    const { entry, object } = input;
    const prefix = input.path === "" ? "" : `${input.path}.`;
    const walkValue = (value: Parameters<Walker<Out>["value"]>[0]) =>
      this.value(value);
    return Effect.gen(function* () {
      const given = yield* givenArguments({ entry, object, prefix });
      const fields: (readonly [string, Out])[] = [];
      for (const argument of entry.arguments) {
        if (argument.type === "#") {
          continue;
        }
        const key = camel(argument.name);
        const path = `${prefix}${key}`;
        const value = given.get(argument);
        const filled =
          value === undefined
            ? yield* defaultOf(argument, object, path)
            : Option.some(value);
        if (Option.isNone(filled)) {
          if (isOptional(argument)) {
            continue;
          }
          return yield* badInput(
            `${path}: required (${argument.type}). Use tg_describe ${entry.name}.`
          );
        }
        const out = yield* walkValue({
          depth: input.depth,
          path,
          type: argument.type,
          value: filled.value,
          vector: argument.typeModifiers?.isVector === true,
        });
        if (Option.isSome(out)) {
          fields.push([key, out.value]);
        }
      }
      return fields;
    });
  }

  /** One value of an argument's type: a vector, a primitive or a boxed type. */
  value(input: {
    readonly depth: number;
    readonly path: string;
    readonly type: string;
    readonly value: Json;
    readonly vector: boolean;
  }): Walked<Option.Option<Out>> {
    const { depth, path, type, value } = input;
    if (input.vector) {
      if (!isJsonArray(value)) {
        return Effect.fail(wrongType(path, `an array of ${type}`, value));
      }
      if (value.length > MAX_RAW_VECTOR) {
        return Effect.fail(
          badInput(
            `${path}: ${value.length} items; at most ${MAX_RAW_VECTOR} in one call.`
          )
        );
      }
      return Effect.forEach(value, (item, at) =>
        this.value({
          depth,
          path: `${path}[${at}]`,
          type,
          value: item,
          vector: false,
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(badInput(`${path}[${at}]: cannot be false here.`)),
              onSome: (out) => Effect.succeed(out),
            })
          )
        )
      ).pipe(Effect.map((items) => Option.some(this.#mode.list(items))));
    }
    const check = PRIMITIVES.get(type);
    if (check !== undefined) {
      return Effect.map(check(value, path), (checked) =>
        this.#emit(checked, path)
      );
    }
    return Effect.map(this.#boxed({ depth, path, type, value }), Option.some);
  }

  /** A checked primitive in this walk's mode; none for a flag left out. */
  #emit(checked: Checked, path: string): Option.Option<Out> {
    switch (checked.kind) {
      case "bytes": {
        return Option.some(this.#mode.bytes({ ...checked, path }));
      }
      case "long": {
        return Option.some(this.#mode.long(checked.decimal));
      }
      case "omit": {
        return Option.none();
      }
      case "scalar": {
        return Option.some(this.#mode.scalar(checked.value));
      }
      default: {
        return absurd<Option.Option<Out>>(checked);
      }
    }
  }

  /** A value of a boxed type: a peer shortcut, or an object of its type. */
  #boxed(input: {
    readonly depth: number;
    readonly path: string;
    readonly type: string;
    readonly value: Json;
  }): Walked<Out> {
    const { depth, path, type, value } = input;
    const object = objectOf(value);
    if (object === undefined) {
      return this.#shortcut({ path, type, value });
    }
    const named = object._;
    if (
      isPeerKind(type) &&
      !(Predicate.isString(named) && NAMELESS_PEERS.has(named))
    ) {
      return Effect.fail(
        badInput(
          `${path}: give the peer as "me", a marked id or a @username, not an object, so the owner sees who it is.`
        )
      );
    }
    if (depth >= MAX_DEPTH) {
      return Effect.fail(badInput(`${path}: nested too deep.`));
    }
    const constructors = this.#index.constructorsByType.get(type) ?? [];
    const [only] = constructors;
    const entry =
      named === undefined && constructors.length === 1
        ? only
        : constructors.find((candidate) => candidate.name === named);
    if (entry === undefined) {
      return Effect.fail(
        badInput(
          `${path}: "_" must name a constructor of ${type}: ${constructors
            .map((candidate) => candidate.name)
            .join(", ")}. Use tg_describe ${type}.`
        )
      );
    }
    return this.fields({ depth: depth + 1, entry, object, path }).pipe(
      Effect.map((fields) =>
        this.#mode.object(
          new Map([["_", this.#mode.scalar(entry.name)], ...fields])
        )
      )
    );
  }

  /** A peer argument given as `"me"`, an id or a username. */
  #shortcut(input: {
    readonly path: string;
    readonly type: string;
    readonly value: Json;
  }): Walked<Out> {
    const { path, type, value } = input;
    if (!isPeerKind(type)) {
      return Effect.fail(
        wrongType(path, `an object of type ${type} with its "_"`, value)
      );
    }
    const ref = shortcutOf(value);
    return ref === undefined
      ? Effect.fail(
          wrongType(
            path,
            `${type}: "me", a numeric id, a @username or an object with its "_"`,
            value
          )
        )
      : this.#mode.peer({ kind: type, path, ref });
  }
}

/** Parameters as the run gave them, or none. */
type Params = JsonObject | undefined;

/**
 * Walk the parameters once without touching the account, so a call with a
 * vector over `MAX_RAW_VECTOR` or more than `MAX_RAW_PEERS` peer shortcuts
 * is refused before any of them is resolved.
 */
const checkSize = (input: {
  readonly entry: RawEntry;
  readonly index: RawIndex;
  readonly params: Params;
}) =>
  Effect.gen(function* () {
    let shortcuts = 0;
    const mode: Mode<null> = {
      bytes: () => null,
      list: () => null,
      long: () => null,
      object: () => null,
      peer: () => {
        shortcuts += 1;
        return Effect.succeed(null);
      },
      scalar: () => null,
    };
    yield* new Walker(input.index, mode).fields({
      depth: 0,
      entry: input.entry,
      object: input.params ?? {},
      path: "",
    });
    yield* shortcuts > MAX_RAW_PEERS
      ? Effect.fail(
          badInput(
            `${shortcuts} peers given as "me", an id or a @username; at most ${MAX_RAW_PEERS} in one call.`
          )
        )
      : Effect.void;
  });

/** The parameters checked and kept for later: what the write stores. */
interface NormalizedParams {
  /** Paths of the bytes values, so the confirmation shows their size. */
  readonly bytes: readonly string[];
  readonly params: JsonObject;
  readonly peers: readonly RawPeerRef[];
}

/** Whether a chat is the kind the argument takes. */
const fitsKind = (kind: PeerKind, peer: Peer) => {
  switch (kind) {
    case "InputPeer": {
      return true;
    }
    case "InputUser": {
      return peer.type === "user";
    }
    case "InputChannel": {
      return (
        peer.type === "chat" &&
        (peer.raw._ === "channel" || peer.raw._ === "channelForbidden")
      );
    }
    default: {
      return absurd<boolean>(kind);
    }
  }
};

/** The first of a bare id's marked ids the account knows; else the last error. */
const lookUpBare = (
  account: TelegramAccountHandle,
  marks: readonly number[]
): Effect.Effect<Peer, BadInput | TelegramAccountError> => {
  const [first, ...rest] = marks;
  if (first === undefined) {
    return Effect.fail(badInput("A bare id has no marked form."));
  }
  const found = account.use(
    "getPeer",
    async (client) => await client.getPeer(first)
  );
  return rest.length === 0
    ? found
    : found.pipe(Effect.catch(() => lookUpBare(account, rest)));
};

/**
 * The run's parameters checked against `entry`, as JSON to store: every
 * key camelCase, defaults filled in, each peer shortcut resolved now and kept
 * as its marked id (`"me"` stays `"me"`), with the label the owner reads.
 */
export const normalizeParams = (input: {
  readonly account: TelegramAccountHandle;
  readonly entry: RawEntry;
  readonly index: RawIndex;
  readonly params: Params;
}) =>
  Effect.gen(function* () {
    yield* checkSize(input);
    const peers: RawPeerRef[] = [];
    const bytes: string[] = [];
    const mode: Mode<Json> = {
      bytes: ({ base64, path }) => {
        bytes.push(path);
        return base64;
      },
      list: (items) => [...items],
      long: (decimal) => decimal,
      object: (fields) => Object.fromEntries(fields),
      peer: ({ kind, path, ref }) =>
        input.account
          .use("getPeer", async (client) => await client.getPeer(ref))
          .pipe(
            Effect.flatMap((peer) => {
              const label = peerLabel(peer);
              if (!fitsKind(kind, peer)) {
                return Effect.fail(
                  badInput(`${path}: ${label} is not an ${kind}.`)
                );
              }
              peers.push({ path, peer: { id: peer.id, label } });
              return Effect.succeed<Json>(ref === "me" ? "me" : peer.id);
            })
          ),
      scalar: (value) => value,
    };
    const fields = yield* new Walker(input.index, mode).fields({
      depth: 0,
      entry: input.entry,
      object: input.params ?? {},
      path: "",
    });
    const params = Object.fromEntries(fields);
    const bare = bareIdsIn(params, "", input.entry.name);
    if (peers.length + bare.length > MAX_RAW_PEERS) {
      return yield* badInput(
        `${peers.length + bare.length} peers named; at most ${MAX_RAW_PEERS} in one call.`
      );
    }
    for (const { marks, path } of bare) {
      const peer = yield* lookUpBare(input.account, marks);
      peers.push({ path, peer: { id: peer.id, label: peerLabel(peer) } });
    }
    const normalized: NormalizedParams = { bytes, params, peers };
    return normalized;
  });

/** A call ready for `client.call`: its `_` is a method of the schema. */
type RawCall = TlObject & tl.RpcMethod;

/**
 * Whether a built object is a call of the schema's: its `_` names a method.
 * `buildCall` sets it from the entry it walked, so this only proves it.
 */
const isRpcMethod = (index: RawIndex, value: TlObject): value is RawCall => {
  const name = value._;
  return Predicate.isString(name) && index.methods.has(name);
};

/** Resolve a stored peer to the input peer its argument takes. */
const resolveInput = (
  account: TelegramAccountHandle,
  kind: PeerKind,
  ref: InputPeerLike
) => {
  switch (kind) {
    case "InputPeer": {
      return account.use(
        "resolvePeer",
        async (client): Promise<TlValue> => await client.resolvePeer(ref)
      );
    }
    case "InputUser": {
      return account.use(
        "resolveUser",
        async (client): Promise<TlValue> => await client.resolveUser(ref)
      );
    }
    case "InputChannel": {
      return account.use(
        "resolveChannel",
        async (client): Promise<TlValue> => await client.resolveChannel(ref)
      );
    }
    default: {
      return absurd<never>(kind);
    }
  }
};

/**
 * Stored parameters, checked again, as the TL call mtcute sends: `long` as
 * `Long`, bytes as `Uint8Array`, each peer resolved to its input peer now.
 */
export const buildCall = (input: {
  readonly account: TelegramAccountHandle;
  readonly entry: RawEntry;
  readonly index: RawIndex;
  readonly params: Params;
}) =>
  Effect.gen(function* () {
    yield* checkSize(input);
    const mode: Mode<TlValue> = {
      bytes: ({ bytes }) => bytes,
      list: (items) => items,
      long: (decimal) => Long.fromString(decimal),
      object: (fields): TlValue => Object.fromEntries(fields),
      peer: ({ kind, ref }) => resolveInput(input.account, kind, ref),
      scalar: (value) => value,
    };
    const fields = yield* new Walker(input.index, mode).fields({
      depth: 0,
      entry: input.entry,
      object: input.params ?? {},
      path: "",
    });
    const call: TlObject = Object.fromEntries([
      ["_", input.entry.name],
      ...fields,
    ]);
    if (!isRpcMethod(input.index, call)) {
      return yield* badInput(`${input.entry.name} is not a method.`);
    }
    return call;
  });
