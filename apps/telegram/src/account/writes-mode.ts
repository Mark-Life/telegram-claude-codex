import { SettingsRepo } from "@workspace/db";
import { ACCOUNT_WRITE_MODES, AppConfig } from "@workspace/env/bot";
import type { AccountWriteMode } from "@workspace/env/bot";
import { Context, Effect, Layer, Option } from "effect";

/**
 * Whether a run's writes on the owner's Telegram account wait for a button:
 * the owner's `account_writes` setting from `/settings`, else
 * `TELEGRAM_ACCOUNT_WRITES`, else `confirm`. Read on every write request, so a
 * press in `/settings` applies to the very next one.
 */

/** A stored mode, or `fallback` when the key is unset or holds anything else. */
export const writesModeOf = (
  stored: string | undefined,
  fallback: AccountWriteMode
) => ACCOUNT_WRITE_MODES.find((mode) => mode === stored) ?? fallback;

/** `TELEGRAM_ACCOUNT_WRITES`, the mode while the owner has set none. */
export const envWritesMode = (
  account: Option.Option<{ readonly writes: AccountWriteMode }>
): AccountWriteMode =>
  Option.match(account, {
    onNone: () => "confirm",
    onSome: (settings) => settings.writes,
  });

const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  const settings = yield* SettingsRepo;
  const fallback = envWritesMode(cfg.telegramAccount);
  return {
    /**
     * The mode in force, as an effect to run per request. A failed read takes
     * `confirm`, the safe side: a write then waits for the owner's button.
     */
    current: settings.get("account_writes").pipe(
      Effect.map((stored) =>
        writesModeOf(Option.getOrUndefined(stored), fallback)
      ),
      Effect.catch((error) =>
        Effect.logWarning("account writes mode read failed, confirming").pipe(
          Effect.annotateLogs({ reason: error.reason }),
          Effect.as<AccountWriteMode>("confirm")
        )
      )
    ),
  };
});

export class WritesMode extends Context.Service<
  WritesMode,
  Effect.Success<typeof make>
>()("@workspace/WritesMode") {
  static readonly layer = Layer.effect(WritesMode, make);
}
