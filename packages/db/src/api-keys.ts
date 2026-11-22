import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull } from "./schema";
import { UsersRepo } from "./users";
import type { Tier } from "./users";

/**
 * HTTP API keys. A key is `pab_<id>_<secret>`: the id is public and names the
 * row, the secret is 32 random bytes the db keeps only as a sha256. A key
 * belongs to one Telegram user and acts as them; their tier is read on every
 * request, never stored with the key.
 */

/** Where a key was made. */
export const API_KEY_ORIGINS = ["cli", "telegram"] as const;

export type ApiKeyOrigin = (typeof API_KEY_ORIGINS)[number];

/** The longest key name kept; a name is a label, not a description. */
export const API_KEY_NAME_MAX = 64;

/**
 * Minutes a new key's token DM stays before the bot deletes it, whichever
 * door (`/apikeys`, the apikeys CLI) sent it.
 */
export const TOKEN_MESSAGE_MINUTES = 10;

/** A line break, tab or other control character: a name is one plain line. */
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL_RE = /\p{Cc}/u;

/** Whether `name` (trimmed) is a key name: one line of 1-64 characters. */
export const isApiKeyName = (name: string) =>
  name.length > 0 && name.length <= API_KEY_NAME_MAX && !CONTROL_RE.test(name);

/** The token's fixed prefix: "personal assistant bot". */
const TOKEN_PREFIX = "pab";

/** Base32 alphabet of the public id: no `_`, so the token splits cleanly. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 12;
const SECRET_BYTES = 32;

const TOKEN_RE = /^pab_(?<id>[a-z2-7]{12})_(?<secret>[\w-]{43})$/u;

/** How often a key's `last_used_at` is written at most, per process. */
const TOUCH_INTERVAL_MS = 60_000;

/** Owner and executor may hold keys; every other tier holds none. */
export const canHoldApiKey = (tier: Tier) =>
  tier === "owner" || tier === "executor";

/** One key as every reader sees it: never its secret or hash. */
export const ApiKeyEntrySchema = Schema.Struct({
  createdAt: Millis,
  createdBy: Schema.Int,
  createdVia: Schema.Literals(API_KEY_ORIGINS),
  id: Schema.String,
  lastUsedAt: OptionalFromNull(Millis),
  name: Schema.String,
  revokedAt: OptionalFromNull(Millis),
  userId: Schema.Int,
});

export type ApiKeyEntry = typeof ApiKeyEntrySchema.Type;

const ApiKeyRow = ApiKeyEntrySchema.pipe(
  Schema.encodeKeys({
    createdAt: "created_at",
    createdBy: "created_by",
    createdVia: "created_via",
    lastUsedAt: "last_used_at",
    revokedAt: "revoked_at",
    userId: "user_id",
  })
);

const SecretRow = Schema.Struct({
  id: Schema.String,
  secret_hash: Schema.String,
});

/** A key id with a short prefix of its stored hash, for the access watcher. */
const FingerprintRow = Schema.Struct({
  fingerprint: Schema.String,
  id: Schema.String,
});

const ApiKeyInsert = Schema.Struct({
  createdAt: Millis,
  createdBy: Schema.Int,
  createdVia: Schema.Literals(API_KEY_ORIGINS),
  id: Schema.String,
  name: Schema.String,
  secretHash: Schema.String,
  userId: Schema.Int,
});

/** The DM that carried a token, waiting for the bot to delete it. */
export const TokenMessageSchema = Schema.Struct({
  chatId: Schema.Int,
  id: Schema.String,
  messageId: Schema.Int,
});

export type TokenMessage = typeof TokenMessageSchema.Type;

const TokenMessageRow = TokenMessageSchema.pipe(
  Schema.encodeKeys({ chatId: "token_chat_id", messageId: "token_message_id" })
);

const TokenMessageWrite = Schema.Struct({
  chatId: Schema.Int,
  id: Schema.String,
  messageId: Schema.Int,
});

const KeyAt = Schema.Struct({ at: Millis, id: Schema.String });

const COLUMNS =
  "id, user_id, name, created_by, created_via, created_at, last_used_at, revoked_at";

const makeRepo = Effect.gen(function* makeApiKeysRepo() {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);

  const insertRow = SqlSchema.findOne({
    Request: ApiKeyInsert,
    Result: ApiKeyRow,
    execute: (row) =>
      sql`INSERT INTO api_keys
            (id, user_id, name, secret_hash, created_by, created_via, created_at)
          VALUES (${row.id}, ${row.userId}, ${row.name}, ${row.secretHash},
            ${row.createdBy}, ${row.createdVia}, ${row.createdAt})
          RETURNING ${columns}`,
  });
  const selectOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ApiKeyRow,
    execute: (id) => sql`SELECT ${columns} FROM api_keys WHERE id = ${id}`,
  });
  const selectSecret = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SecretRow,
    execute: (id) => sql`SELECT id, secret_hash FROM api_keys WHERE id = ${id}`,
  });
  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ApiKeyRow,
    execute: () =>
      sql`SELECT ${columns} FROM api_keys ORDER BY created_at ASC, id ASC`,
  });
  const selectFingerprints = SqlSchema.findAll({
    Request: Schema.Void,
    Result: FingerprintRow,
    execute: () =>
      sql`SELECT id, substr(secret_hash, 1, 8) AS fingerprint FROM api_keys`,
  });
  const markRevoked = SqlSchema.findOneOption({
    Request: KeyAt,
    Result: ApiKeyRow,
    execute: (row) =>
      sql`UPDATE api_keys SET revoked_at = ${row.at}
          WHERE id = ${row.id} AND revoked_at IS NULL
          RETURNING ${columns}`,
  });
  const markUsed = SqlSchema.void({
    Request: KeyAt,
    execute: (row) =>
      sql`UPDATE api_keys SET last_used_at = ${row.at} WHERE id = ${row.id}`,
  });
  const writeTokenMessage = SqlSchema.void({
    Request: TokenMessageWrite,
    execute: (row) =>
      sql`UPDATE api_keys
          SET token_chat_id = ${row.chatId}, token_message_id = ${row.messageId}
          WHERE id = ${row.id}`,
  });
  const selectTokenMessages = SqlSchema.findAll({
    Request: Millis,
    Result: TokenMessageRow,
    execute: (cutoff) =>
      sql`SELECT id, token_chat_id, token_message_id FROM api_keys
          WHERE token_message_id IS NOT NULL AND token_chat_id IS NOT NULL
            AND (created_at <= ${cutoff} OR revoked_at IS NOT NULL)`,
  });
  const dropTokenMessage = SqlSchema.void({
    Request: Schema.String,
    execute: (id) =>
      sql`UPDATE api_keys SET token_chat_id = NULL, token_message_id = NULL
          WHERE id = ${id}`,
  });

  /** Store a new key; the caller made its id and hashed its secret. */
  const insert = Effect.fn("ApiKeysRepo.insert")(function* insert(
    row: typeof ApiKeyInsert.Type
  ) {
    return yield* insertRow(row).pipe(
      // An INSERT … RETURNING always hands back its row; no row is a defect.
      Effect.catchTag("NoSuchElementError", (cause) => Effect.die(cause))
    );
  }, persistence("ApiKeysRepo.insert"));

  /** One key by id, revoked ones included. */
  const get = Effect.fn("ApiKeysRepo.get")(function* get(id: string) {
    return yield* selectOne(id);
  }, persistence("ApiKeysRepo.get"));

  /** The stored hash of one key's secret; only `verify` reads it. */
  const secretHash = Effect.fn("ApiKeysRepo.secretHash")(function* secretHash(
    id: string
  ) {
    return Option.map(yield* selectSecret(id), (row) => row.secret_hash);
  }, persistence("ApiKeysRepo.secretHash"));

  /** Every key, oldest first, revoked ones included. */
  const list = Effect.fn("ApiKeysRepo.list")(function* list() {
    return yield* selectAll();
  }, persistence("ApiKeysRepo.list"));

  /**
   * Every key id with the first 8 hex chars of its stored hash, so the access
   * watcher sees a hash swapped behind the bot's back. Never the hash itself.
   */
  const fingerprints = Effect.fn("ApiKeysRepo.fingerprints")(
    function* fingerprints() {
      return yield* selectFingerprints();
    },
    persistence("ApiKeysRepo.fingerprints")
  );

  /** Revoke a live key; none when there is no such key or it was revoked. */
  const revoke = Effect.fn("ApiKeysRepo.revoke")(function* revoke(id: string) {
    const at = yield* Clock.currentTimeMillis;
    return yield* markRevoked({ at, id });
  }, persistence("ApiKeysRepo.revoke"));

  /** Note that a key was just used. */
  const touch = Effect.fn("ApiKeysRepo.touch")(function* touch(id: string) {
    const at = yield* Clock.currentTimeMillis;
    yield* markUsed({ at, id });
  }, persistence("ApiKeysRepo.touch"));

  /** Remember the DM that carried a key's token, so it can be deleted. */
  const noteTokenMessage = Effect.fn("ApiKeysRepo.noteTokenMessage")(
    function* noteTokenMessage(message: TokenMessage) {
      yield* writeTokenMessage(message);
    },
    persistence("ApiKeysRepo.noteTokenMessage")
  );

  /** Token DMs of keys made at or before `cutoff`, or revoked since. */
  const tokenMessagesDue = Effect.fn("ApiKeysRepo.tokenMessagesDue")(
    function* tokenMessagesDue(cutoff: number) {
      return yield* selectTokenMessages(cutoff);
    },
    persistence("ApiKeysRepo.tokenMessagesDue")
  );

  /** Forget a token DM once it is deleted (or cannot be). */
  const forgetTokenMessage = Effect.fn("ApiKeysRepo.forgetTokenMessage")(
    function* forgetTokenMessage(id: string) {
      yield* dropTokenMessage(id);
    },
    persistence("ApiKeysRepo.forgetTokenMessage")
  );

  return {
    fingerprints,
    forgetTokenMessage,
    get,
    insert,
    list,
    noteTokenMessage,
    revoke,
    secretHash,
    tokenMessagesDue,
    touch,
  } as const;
});

/**
 * The `api_keys` table. Every door (the `/apikeys` command, the apikeys CLI
 * and the HTTP API) goes through `ApiKeyService` above it, never here.
 */
export class ApiKeysRepo extends Context.Service<
  ApiKeysRepo,
  Effect.Success<typeof makeRepo>
>()("@workspace/db/ApiKeysRepo") {
  static readonly layer = Layer.effect(ApiKeysRepo, makeRepo);
}

/**
 * A key could not be issued. `tier`: the holder is not the owner or an
 * executor. `name`: the name is empty, longer than `API_KEY_NAME_MAX`, or not one line
 * (a line break or other control character).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class ApiKeyRefused extends Schema.TaggedError<ApiKeyRefused>()(
  "ApiKeyRefused",
  { reason: Schema.Literals(["name", "tier"]) }
) {}

/**
 * A token did not authenticate. `malformed`: not a `pab_` token at all;
 * `unknown`: no such key or a wrong secret (told apart only in the log);
 * `revoked`: the key was revoked; `tier`: its holder is no longer the owner or
 * an executor.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class ApiKeyRejected extends Schema.TaggedError<ApiKeyRejected>()(
  "ApiKeyRejected",
  {
    reason: Schema.Literals(["malformed", "unknown", "revoked", "tier"]),
  }
) {}

/** Who a valid key acts as, with the tier read just now. */
export interface ApiKeyHolder {
  readonly key: ApiKeyEntry;
  readonly tier: Tier;
}

/** A fresh random public id. */
const newKeyId = () =>
  Array.from(
    randomBytes(ID_LENGTH),
    (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]
  ).join("");

const hashSecret = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

/** The id and secret of a token, or none when it is not one of ours. */
export const parseApiToken = (token: string) => {
  const match = TOKEN_RE.exec(token.trim());
  const id = match?.groups?.id;
  const secret = match?.groups?.secret;
  return id === undefined || secret === undefined
    ? Option.none()
    : Option.some({ id, secret });
};

/** How a key is shown after it was issued: its id, never its secret. */
export const apiKeyHint = (id: string) => `${TOKEN_PREFIX}_${id}…`;

/** Whether the stored hash is the hash of `secret`, in constant time. */
const secretMatches = (stored: string, secret: string) => {
  const expected = Buffer.from(stored, "hex");
  const actual = Buffer.from(hashSecret(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const makeService = Effect.gen(function* makeApiKeyService() {
  const repo = yield* ApiKeysRepo;
  const users = yield* UsersRepo;
  /** When this process last wrote each key's `last_used_at`. */
  const touched = new Map<string, number>();

  /**
   * Issue a key to `holderId`, who must be the owner or an executor right
   * now. The token is handed back once, redacted; only its hash is stored.
   */
  const issue = Effect.fn("ApiKeyService.issue")(function* issue(input: {
    readonly createdBy: number;
    readonly holderId: number;
    readonly name: string;
    readonly ownerId: number;
    readonly via: ApiKeyOrigin;
  }) {
    const name = input.name.trim();
    if (!isApiKeyName(name)) {
      return yield* new ApiKeyRefused({ reason: "name" });
    }
    const tier = yield* users.tierOf({
      ownerId: input.ownerId,
      userId: input.holderId,
    });
    if (!canHoldApiKey(tier)) {
      return yield* new ApiKeyRefused({ reason: "tier" });
    }
    const id = newKeyId();
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const createdAt = yield* Clock.currentTimeMillis;
    const key = yield* repo.insert({
      createdAt,
      createdBy: input.createdBy,
      createdVia: input.via,
      id,
      name,
      secretHash: hashSecret(secret),
      userId: input.holderId,
    });
    return {
      key,
      tier,
      token: Redacted.make(`${TOKEN_PREFIX}_${id}_${secret}`),
    } as const;
  });

  /**
   * The live keys `viewerId` may see: the owner sees every key, anyone else
   * only their own.
   */
  const list = Effect.fn("ApiKeyService.list")(function* list(input: {
    readonly ownerId: number;
    readonly viewerId: number;
  }) {
    const all = yield* repo.list();
    return all.filter(
      (key) =>
        key.revokedAt === undefined &&
        (input.viewerId === input.ownerId || key.userId === input.viewerId)
    );
  });

  /**
   * Revoke a live key `viewerId` may see. None when there is no such live key
   * or it is someone else's and the viewer is not the owner.
   */
  const revoke = Effect.fn("ApiKeyService.revoke")(function* revoke(input: {
    readonly keyId: string;
    readonly ownerId: number;
    readonly viewerId: number;
  }) {
    const found = yield* repo.get(input.keyId);
    const visible = Option.filter(
      found,
      (key) =>
        key.revokedAt === undefined &&
        (input.viewerId === input.ownerId || key.userId === input.viewerId)
    );
    if (Option.isNone(visible)) {
      return Option.none<ApiKeyEntry>();
    }
    return yield* repo.revoke(input.keyId);
  });

  /**
   * Whether a key still acts for its holder, and at which tier read now:
   * none once it is revoked or gone, or its holder may no longer hold keys.
   * What a running agent run of the key is checked against.
   */
  const standing = Effect.fn("ApiKeyService.standing")(
    function* standing(input: {
      readonly keyId: string;
      readonly ownerId: number;
    }) {
      const key = yield* repo.get(input.keyId);
      if (Option.isNone(key) || key.value.revokedAt !== undefined) {
        return Option.none<ApiKeyHolder>();
      }
      const tier = yield* users.tierOf({
        ownerId: input.ownerId,
        userId: key.value.userId,
      });
      return canHoldApiKey(tier)
        ? Option.some<ApiKeyHolder>({ key: key.value, tier })
        : Option.none<ApiKeyHolder>();
    }
  );

  /**
   * Who a token acts as. The holder's tier is read now through the same rule
   * the chat uses, so a revoke or a demotion disables the key at once.
   */
  const authenticate = Effect.fn("ApiKeyService.authenticate")(
    function* authenticate(input: {
      readonly ownerId: number;
      readonly token: Redacted.Redacted;
    }) {
      const parsed = parseApiToken(Redacted.value(input.token));
      if (Option.isNone(parsed)) {
        return yield* new ApiKeyRejected({ reason: "malformed" });
      }
      const { id, secret } = parsed.value;
      const stored = yield* repo.secretHash(id);
      if (Option.isNone(stored) || !secretMatches(stored.value, secret)) {
        return yield* new ApiKeyRejected({ reason: "unknown" });
      }
      const key = yield* repo.get(id);
      if (Option.isNone(key)) {
        return yield* new ApiKeyRejected({ reason: "unknown" });
      }
      if (key.value.revokedAt !== undefined) {
        return yield* new ApiKeyRejected({ reason: "revoked" });
      }
      const tier = yield* users.tierOf({
        ownerId: input.ownerId,
        userId: key.value.userId,
      });
      if (!canHoldApiKey(tier)) {
        return yield* new ApiKeyRejected({ reason: "tier" });
      }
      const now = yield* Clock.currentTimeMillis;
      if (now - (touched.get(id) ?? 0) >= TOUCH_INTERVAL_MS) {
        touched.set(id, now);
        // A missed timestamp never fails the request it describes.
        yield* repo.touch(id).pipe(Effect.ignore);
      }
      const holder: ApiKeyHolder = { key: key.value, tier };
      return holder;
    }
  );

  return {
    authenticate,
    forgetTokenMessage: repo.forgetTokenMessage,
    issue,
    list,
    noteTokenMessage: repo.noteTokenMessage,
    revoke,
    standing,
    tokenMessagesDue: repo.tokenMessagesDue,
  } as const;
});

/**
 * The one way to issue, list, revoke and check API keys. The `/apikeys`
 * command, the apikeys CLI and the HTTP API are thin doors over it.
 */
export class ApiKeyService extends Context.Service<
  ApiKeyService,
  Effect.Success<typeof makeService>
>()("@workspace/db/ApiKeyService") {
  static readonly layer = Layer.effect(ApiKeyService, makeService);
}
