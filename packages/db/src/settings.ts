import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis } from "./schema";

/**
 * Every setting the bot persists. A feature that needs a new one adds its key
 * here rather than passing a raw string, so the whole key space is one list and
 * a typo fails to compile.
 */
export const SETTING_KEYS = [
  // `direct` carries out a run's writes on the owner's Telegram account at
  // once; `confirm` waits for their button. Unset means
  // `TELEGRAM_ACCOUNT_WRITES`. Owner-only, from `/settings`.
  "account_writes",
  // `en` makes everything the bot itself says English; unset or anything else
  // is Russian. Owner-only, from `/settings`.
  "bot_language",
  "call_name",
  // The owner's Claude, Codex and pi settings, one JSON object each, keys and
  // values from the allowlist in `packages/agent/src/provider-settings.ts`;
  // anything else in it is dropped on read. Unset or `{}` keeps every
  // provider default. Owner-only, from `/settings`; read by every run.
  "claude_settings",
  "codex_settings",
  "pi_settings",
  // IANA zone a new reminder gets when its run names none; unset means
  // `DEFAULT_TZ`. Owner-only, from `/settings`; read by `reminders-cli.ts` too.
  "default_tz",
  // Daily group-run budgets, everyone together and per person: a positive
  // count or `off` for no limit; unset means the built-in default. Owner-only,
  // from `/settings`.
  "group_runs_per_day",
  "group_runs_per_user",
  // `off` ignores every private update from a `guest` tier user; unset or
  // anything else lets them in. Owner-only, from `/settings`.
  "guests",
  // Comma-separated providers whose own past sessions were imported into
  // `session_history` once; written by the bot at boot, never by a person.
  "history_imported",
  // What each helper pass (`format`, `judge`, `title`) runs on: a provider
  // (`helper_<use>_provider`), a model tier (`helper_<use>_model`), a pi
  // `provider/id` (`helper_<use>_pi_model`) and an effort level
  // (`helper_<use>_effort`). Unset, `auto` or `default` is Auto: title and
  // format follow the light choice, then the detected helper; the judge uses
  // the detected helper. The model and effort apply only on the chosen
  // provider; when it cannot run, all of them are dropped and Auto is used.
  // Owner-only, from `/settings`.
  "helper_format_effort",
  "helper_format_model",
  "helper_format_pi_model",
  "helper_format_provider",
  "helper_judge_effort",
  "helper_judge_model",
  "helper_judge_pi_model",
  "helper_judge_provider",
  "helper_title_effort",
  "helper_title_model",
  "helper_title_pi_model",
  "helper_title_provider",
  // What every `light` run (groups, guests, members, Business replies) runs
  // on: a provider (`light_provider`), a model tier (`light_model`) and an
  // effort level (`light_effort`). Unset, `auto` or `default` keep the
  // detected light provider and its own light pick. Owner-only, from
  // `/settings`.
  "light_effort",
  "light_model",
  // A pi model named outright (`provider/id`): pi has no tiers, so on pi it
  // stands in for `light_model`. Unset or `default` keeps the tier's rule.
  "light_pi_model",
  "light_provider",
  // `off` leaves the owner's chats as they were after the bot read them; unset
  // or anything else marks a chat read when a run reads its history, a voice
  // or round video listened when a run downloads it, and a Business chat read
  // when the bot answers there. Owner-only, from `/settings`.
  "mark_read",
  // Agent runs allowed at once; unset means `MAX_CONCURRENT_RUNS`. Owner-only,
  // from `/settings`.
  "max_concurrent_runs",
  // `off` starts new conversations on the provider's default model instead of
  // asking the model router; unset or anything else means `auto`. Owner-only,
  // from the `/model` menu.
  "model_routing",
  "owner_name",
  // The provider the owner chose for their own private chat; unset means the
  // detected default. Only `/provider` writes it.
  "owner_provider",
  "persona_gender",
  // The last few pi models picked with `/model`, newest first, as a JSON
  // array of `provider/id`; written by the bot, offered back in `/model`.
  "pi_recent_models",
  // Daily private-chat budgets, like the group ones above.
  "private_runs_per_day",
  "private_runs_per_user",
  // `off` queues a message sent while a run works, to run after it; unset or
  // anything else folds it into the running turn where the provider can.
  // Owner-only, from `/settings`.
  "steer",
  // The Claude sessions fresh task fires keep only so a restart can continue
  // them, as a JSON array of ids; written by the bot, which deletes at boot
  // the ones no `background_runs` row names (a fire the process died in).
  "task_kept_sessions",
  "trusted_group_ids",
  // The ElevenLabs model and voice a voice reply is spoken with: a model id
  // from `TTS_MODELS` and a voice id from the owner's ElevenLabs account.
  // Unset means the first model and the account's first voice matching the
  // persona's gender (`pickVoice`). Owner-only,
  // from `/settings`; read by `send-voice-to-user.ts`.
  "tts_model",
  "tts_voice",
  // `full` shows a run's steps, drafts and footer; unset or anything else
  // shows the answer alone. Owner-only, from `/settings`.
  "verbosity",
  // `off` keeps a voice note's transcript out of the chat; the note is still
  // transcribed and run. Unset or anything else echoes it. Owner-only, from
  // `/settings`.
  "voice_transcript",
  "workspace_chat_id",
  "workspace_thread_id",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const SettingKeySchema = Schema.Literals(SETTING_KEYS);
const SettingValue = Schema.Struct({ value: Schema.String });
const SettingWrite = Schema.Struct({
  key: SettingKeySchema,
  updatedAt: Millis,
  value: Schema.String,
});

/** One setting to write, or to forget when `value` is null. */
export interface SettingChange {
  readonly key: SettingKey;
  readonly value: string | null;
}

/** A stored chat id, or the fallback when nothing usable is stored. */
export const parseChatId = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw);
  return raw !== undefined && raw.length > 0 && Number.isSafeInteger(parsed)
    ? parsed
    : fallback;
};

/**
 * The workspace the owner chose with /setworkspace: its chat, and the topic
 * it was set from (null for the whole chat).
 */
export interface Workspace {
  readonly chatId: number;
  readonly threadId: number | null;
}

/** A selected row's value, undefined when the key was never set. */
const valueOf = (row: Option.Option<{ readonly value: string }>) =>
  Option.getOrUndefined(Option.map(row, (found) => found.value));

const make = Effect.gen(function* makeSettingsRepo() {
  const sql = yield* SqlClient.SqlClient;

  const select = SqlSchema.findOneOption({
    Request: SettingKeySchema,
    Result: SettingValue,
    execute: (key) => sql`SELECT value FROM settings WHERE key = ${key}`,
  });
  const upsert = SqlSchema.void({
    Request: SettingWrite,
    execute: (row) =>
      sql`INSERT INTO settings (key, value, updated_at)
          VALUES (${row.key}, ${row.value}, ${row.updatedAt})
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value, updated_at = excluded.updated_at`,
  });
  const remove = SqlSchema.void({
    Request: SettingKeySchema,
    execute: (key) => sql`DELETE FROM settings WHERE key = ${key}`,
  });

  const write = Effect.fnUntraced(function* write(change: SettingChange) {
    if (change.value === null) {
      return yield* remove(change.key);
    }
    const updatedAt = yield* Clock.currentTimeMillis;
    return yield* upsert({ key: change.key, updatedAt, value: change.value });
  });

  /** Stored value, none when the key was never set. */
  const get = Effect.fn("SettingsRepo.get")(function* get(key: SettingKey) {
    const row = yield* select(key);
    return row.pipe(Option.map((found) => found.value));
  }, persistence("SettingsRepo.get"));

  /**
   * The workspace, none when no usable chat is stored. A stored topic that is
   * not a positive id reads as the whole chat.
   */
  const workspace = Effect.fn("SettingsRepo.workspace")(function* workspace() {
    const chatId = parseChatId(
      valueOf(yield* select("workspace_chat_id")),
      Number.NaN
    );
    if (Number.isNaN(chatId)) {
      return Option.none<Workspace>();
    }
    const threadId = parseChatId(
      valueOf(yield* select("workspace_thread_id")),
      Number.NaN
    );
    const found: Workspace = {
      chatId,
      threadId: Number.isNaN(threadId) || threadId <= 0 ? null : threadId,
    };
    return Option.some(found);
  }, persistence("SettingsRepo.workspace"));

  /** Write (or overwrite) one setting. */
  const set = Effect.fn("SettingsRepo.set")(function* set(entry: {
    readonly key: SettingKey;
    readonly value: string;
  }) {
    yield* write(entry);
  }, persistence("SettingsRepo.set"));

  /** Forget one setting, back to its code default. */
  const unset = Effect.fn("SettingsRepo.unset")(function* unset(
    key: SettingKey
  ) {
    yield* remove(key);
  }, persistence("SettingsRepo.unset"));

  /** Every change in one transaction; a null value forgets the key. */
  const apply = Effect.fn("SettingsRepo.apply")(function* apply(
    changes: readonly SettingChange[]
  ) {
    yield* sql.withTransaction(
      Effect.all(
        changes.map((change) => write(change)),
        { discard: true }
      )
    );
  }, persistence("SettingsRepo.apply"));

  return { apply, get, set, unset, workspace } as const;
});

/**
 * Key/value settings (`settings`), values stored as text.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class SettingsRepo extends Context.Service<
  SettingsRepo,
  Effect.Success<typeof make>
>()("@workspace/db/SettingsRepo") {
  static readonly layer = Layer.effect(SettingsRepo, make);
}
