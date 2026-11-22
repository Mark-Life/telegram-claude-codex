import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { MtPeerNotFoundError, TelegramClient, tl } from "@mtcute/bun";
import type { User } from "@mtcute/bun";
import { AppConfig } from "@workspace/env/bot";
import { telegramAccountDbPath } from "@workspace/env/paths";
import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";

const OWNER_ONLY_MODE = 0o600;

/**
 * The session file holds an auth key that logs in as the owner: readable by
 * the bot's OS user only, and so are its WAL and shared-memory files, which
 * SQLite creates with the main file's mode. Best effort: a file that cannot be
 * narrowed still works.
 */
const restrictSessionFile = (file: string) => {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    closeSync(openSync(file, "a", OWNER_ONLY_MODE));
    for (const name of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        chmodSync(name, OWNER_ONLY_MODE);
      } catch {
        // Not created yet: SQLite gives it the main file's mode.
      }
    }
  } catch {
    // Unwritable .data surfaces when the client opens the file.
  }
};

/**
 * The failure every call on the owner's own account fails with. `method` is
 * the call's label ("getHistory"), `reason` the class a caller may match on;
 * `rpc` keeps Telegram's error text ("CHAT_WRITE_FORBIDDEN") for the log and
 * for the agent, never for the user.
 *
 * - `off` — `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` are not set
 * - `not-logged-in` — no session, or Telegram revoked it
 * - `flood` — a `FLOOD_WAIT` longer than mtcute sleeps through on its own
 * - `peer-not-found` — no chat or user by that id or username
 * - `forward-restricted` — the source protects its content, so Telegram
 *   refuses to forward it
 * - `rpc` — any other Telegram error
 * - `unknown` — anything else thrown inside the call
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class TelegramAccountError extends Schema.TaggedError<TelegramAccountError>()(
  "TelegramAccountError",
  {
    cause: Schema.Defect(),
    method: Schema.String,
    reason: Schema.Literals([
      "off",
      "not-logged-in",
      "flood",
      "peer-not-found",
      "forward-restricted",
      "rpc",
      "unknown",
    ]),
    retryAfter: Schema.optional(Schema.Number),
    rpc: Schema.optional(Schema.String),
  }
) {
  override get message() {
    return `${this.method} failed (${this.reason}${this.rpc === undefined ? "" : `: ${this.rpc}`})`;
  }
}

export type TelegramAccountReason = TelegramAccountError["reason"];

/** Who the account is, as the bot shows it. */
export interface AccountSelf {
  readonly id: number;
  readonly name: string;
  readonly username?: string;
}

export type AccountStatus =
  | { readonly _tag: "off" }
  | { readonly _tag: "logged-out" }
  | { readonly _tag: "logged-in"; readonly self: AccountSelf };

const {
  $is: isAccountStatus,
  "logged-in": LoggedIn,
  "logged-out": LoggedOut,
  off: Off,
} = Data.taggedEnum<AccountStatus>();

/** Telegram's answers that mean the session is gone for good. */
const SESSION_GONE = new Set([
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
]);

const FLOOD_CODE = 420;

const floodSeconds = (error: tl.RpcError) =>
  error.is("FLOOD_WAIT_%d") ? error.seconds : undefined;

/** Classify whatever an mtcute call threw as one `TelegramAccountError`. */
const toAccountError = (method: string, cause: unknown) => {
  if (tl.RpcError.is(cause)) {
    if (SESSION_GONE.has(cause.text)) {
      return new TelegramAccountError({
        cause,
        method,
        reason: "not-logged-in",
        rpc: cause.text,
      });
    }
    if (cause.code === FLOOD_CODE) {
      return new TelegramAccountError({
        cause,
        method,
        reason: "flood",
        retryAfter: floodSeconds(cause),
        rpc: cause.text,
      });
    }
    if (cause.text === "CHAT_FORWARDS_RESTRICTED") {
      return new TelegramAccountError({
        cause,
        method,
        reason: "forward-restricted",
        rpc: cause.text,
      });
    }
    const peerMissing =
      cause.text === "USERNAME_NOT_OCCUPIED" ||
      cause.text === "USERNAME_INVALID" ||
      cause.text === "PEER_ID_INVALID" ||
      cause.text === "CHANNEL_INVALID";
    return new TelegramAccountError({
      cause,
      method,
      reason: peerMissing ? "peer-not-found" : "rpc",
      rpc: cause.text,
    });
  }
  if (cause instanceof MtPeerNotFoundError) {
    return new TelegramAccountError({
      cause,
      method,
      reason: "peer-not-found",
    });
  }
  return new TelegramAccountError({ cause, method, reason: "unknown" });
};

const selfOf = (user: User): AccountSelf =>
  user.username === null
    ? { id: user.id, name: user.displayName }
    : { id: user.id, name: user.displayName, username: user.username };

/** mtcute's own logger prints to stdout; only its warnings are worth a line. */
const MTCUTE_LOG_WARN = 2;

/** What a QR login needs from the chat side of the flow. */
export interface LoginInput {
  /** Show this `tg://login` link as a QR code; called again on every renewal. */
  readonly onQr: (url: string, expires: Date) => Promise<void>;
  /** Ask for the cloud password; `hint` is the one the owner set, if any. */
  readonly password: (hint: string | undefined) => Promise<string>;
  /** The password was wrong; the next `password` call asks again. */
  readonly onPasswordInvalid: () => Promise<void>;
  /** Aborts the whole flow: timeout or the owner giving up. */
  readonly signal: AbortSignal;
}

const off = (method: string) =>
  new TelegramAccountError({ cause: undefined, method, reason: "off" });

/** The service when the env keys are absent: every call fails with `off`. */
const disabled = {
  login: () => Effect.fail(off("signInQr")),
  logout: Effect.fail(off("logOut")),
  status: Effect.succeed<AccountStatus>(Off()),
  use: (method: string) => Effect.fail(off(method)),
};

/**
 * Builds the mtcute client over `.data/telegram-account.db` with updates off,
 * and wraps its lifecycle as a scoped resource: release destroys the client
 * (closing the session db) on runtime dispose. A stored session counts as
 * logged in at once; the connection and a `getMe` check run in a background
 * fiber, so a slow network never holds up the boot, and a session Telegram has
 * revoked flips the status to logged out there.
 */
const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  if (Option.isNone(cfg.telegramAccount)) {
    return disabled;
  }
  const settings = cfg.telegramAccount.value;
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => {
      restrictSessionFile(telegramAccountDbPath());
      return new TelegramClient({
        apiHash: Redacted.value(settings.apiHash),
        apiId: settings.apiId,
        disableUpdates: true,
        logLevel: MTCUTE_LOG_WARN,
        storage: telegramAccountDbPath(),
      });
    }),
    (built) =>
      Effect.promise(async () => {
        await built.destroy();
      })
  );

  const stored = yield* Effect.tryPromise(async () => {
    await client.prepare();
    return await client.storage.self.fetch();
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError("telegram account session unreadable", error)
    ),
    Effect.orElseSucceed(() => null)
  );
  const state = yield* Ref.make<AccountStatus>(
    stored === null
      ? LoggedOut()
      : LoggedIn({ self: { id: stored.userId, name: String(stored.userId) } })
  );

  const markLoggedOut = Ref.set(state, LoggedOut());

  /** A call that found the session revoked also flips the status. */
  const call = <A>(method: string, fn: (c: TelegramClient) => Promise<A>) =>
    Effect.tryPromise({
      catch: (cause) => toAccountError(method, cause),
      try: async () => await fn(client),
    }).pipe(
      Effect.tapError((error) =>
        error.reason === "not-logged-in" ? markLoggedOut : Effect.void
      ),
      Effect.tapError((error) =>
        Effect.logWarning("telegram account call failed").pipe(
          Effect.annotateLogs({
            label: method,
            reason: error.reason,
            rpc: error.rpc,
          })
        )
      ),
      Effect.withSpan(`TelegramAccount.${method}`, {
        attributes: { "telegram.account.method": method },
      })
    );

  if (stored !== null) {
    yield* call("getMe", async (c) => {
      const me = await c.getMe();
      await c.notifyLoggedIn(me.raw);
      return me;
    }).pipe(
      Effect.tap((me) => Ref.set(state, LoggedIn({ self: selfOf(me) }))),
      Effect.tap(() => Effect.log("telegram account connected")),
      Effect.ignore,
      Effect.forkScoped
    );
  }

  const use = <A>(
    method: string,
    fn: (client: TelegramClient) => Promise<A>
  ): Effect.Effect<A, TelegramAccountError> =>
    Effect.flatMap(Ref.get(state), (status) =>
      isAccountStatus("logged-in")(status)
        ? call(method, fn)
        : Effect.fail(
            new TelegramAccountError({
              cause: undefined,
              method,
              reason: "not-logged-in",
            })
          )
    );

  const login = (input: LoginInput) =>
    call("signInQr", async (c) => {
      let hint: string | undefined;
      return await c.signInQr({
        abortSignal: input.signal,
        invalidPasswordCallback: input.onPasswordInvalid,
        onUrlUpdated: (url, expires) => {
          // Rendering the QR is best effort; a failed send shows up in the
          // bot's own log and the next renewal tries again.
          input.onQr(url, expires).catch(() => {
            // Nothing to add to the send's own log line.
          });
        },
        password: async () => {
          hint ??= (await c.getPasswordHint()) ?? undefined;
          return await input.password(hint);
        },
      });
    }).pipe(
      Effect.map(selfOf),
      Effect.tap((self) => Ref.set(state, LoggedIn({ self }))),
      Effect.tap((self) =>
        Effect.log("telegram account logged in").pipe(
          Effect.annotateLogs({ accountId: self.id })
        )
      )
    );

  const logout = call("logOut", async (c) => {
    await c.logOut();
  }).pipe(
    // Telegram answering that the session is already gone is a logout too.
    Effect.catchIf(
      (error) => error.reason === "not-logged-in",
      () => Effect.void
    ),
    Effect.tap(() => markLoggedOut)
  );

  return { login, logout, status: Ref.get(state), use };
});

/** The account plus every call on it, as exposed by TelegramAccount. */
export interface TelegramAccountHandle {
  /** QR login, then the cloud password when the account has one. */
  readonly login: (
    input: LoginInput
  ) => Effect.Effect<AccountSelf, TelegramAccountError>;
  /** End the session on Telegram's side and forget it here. */
  readonly logout: Effect.Effect<void, TelegramAccountError>;
  readonly status: Effect.Effect<AccountStatus>;
  /** One call on the logged-in client; fails `not-logged-in` without one. */
  readonly use: <A>(
    method: string,
    fn: (client: TelegramClient) => Promise<A>
  ) => Effect.Effect<A, TelegramAccountError>;
}

/**
 * TelegramAccount: the owner's own Telegram account over MTProto (mtcute),
 * opt-in per instance. Separate from `TelegramBot`: another protocol, another
 * identity, other errors. One client per process, because a second one would
 * fight over the session file.
 */
export class TelegramAccount extends Context.Service<
  TelegramAccount,
  TelegramAccountHandle
>()("@workspace/TelegramAccount") {
  static readonly layer = Layer.effect(TelegramAccount, make);
}
