import { isInstalled, orderedSnapshots } from "@workspace/agent";
import type { EffectiveProviders } from "@workspace/agent";

import type { Tier } from "../access/tier";
import { listUsers } from "../db/bridge";
import { effectiveProviders } from "../handlers/agent-bridge";
import { t } from "../i18n";
import { tgBestEffort } from "./bridge";
import type { RetryPolicy } from "./bridge";

/**
 * The session pointer and the run defaults are shared by every conversation on
 * this machine, so the commands that write them stay out of generic menus —
 * `handlers/history.ts`, `session-commands.ts` and `model-effort.ts` refuse
 * them for the same tiers.
 */
const OPERATOR_ONLY = new Set(["compact", "effort", "history", "model", "new"]);

const CONVERSATION_COMMANDS = [
  "new",
  "stop",
  "history",
  "compact",
  "context",
  "compose",
  "send",
  "cancel",
  "model",
  "effort",
  "help",
] as const;

/**
 * Executors may manage the shared reminder and recurring-task registries, set
 * what their own new conversations start on (`/settings`), see how much of
 * the subscriptions their runs bill to is used (`/usage`) and hold their own
 * HTTP API keys (`/apikeys`).
 */
const EXECUTOR_COMMANDS = [
  ...CONVERSATION_COMMANDS,
  "reminders",
  "tasks",
  "task",
  "settings",
  "usage",
  "apikeys",
] as const;

/** Only the immutable owner may change who has access. */
const OWNER_COMMANDS = [
  ...EXECUTOR_COMMANDS,
  "users",
  "access",
  "grant",
  "revoke",
  "callname",
  "login",
  "provider",
] as const;

/** Every command a menu lists; each locale describes all of them. */
export type MenuCommand = (typeof OWNER_COMMANDS)[number];

/** A menu as Telegram takes it, described in the language in use. */
const describeCommands = (commands: readonly MenuCommand[]) =>
  commands.map((command) => ({
    command,
    description: t().commands[command],
  }));

/** Commands that are useful to every user who may talk to the bot. */
export const generalCommands = () =>
  describeCommands(
    CONVERSATION_COMMANDS.filter((command) => !OPERATOR_ONLY.has(command))
  );

/**
 * Whether the owner's menu offers `/provider`: two or more providers have
 * their CLI on this host, so there is something to choose between.
 */
export const providerOffered = (providers: EffectiveProviders) =>
  orderedSnapshots(providers.snapshots).filter(isInstalled).length > 1;

/** Owner commands that exist only when this host offers them. */
interface OfferedCommands {
  provider?: boolean;
}

/**
 * A private command menu mirrors the user's current access tier. `offered`
 * says which host-dependent commands the owner's menu lists; see
 * `providerOffered`.
 */
export const commandsForTier = (tier: Tier, offered: OfferedCommands = {}) => {
  if (tier === "owner") {
    return describeCommands(
      OWNER_COMMANDS.filter(
        (command) => command !== "provider" || offered.provider === true
      )
    );
  }
  return tier === "executor"
    ? describeCommands(EXECUTOR_COMMANDS)
    : generalCommands();
};

/**
 * Set or replace one user's private-chat command menu. Never rejects: a menu
 * that failed to update is logged by TelegramBot and changes no access.
 * `retry` defaults to "all" (setMyCommands is idempotent); a command handler
 * passes false, because the update it answers waits on this call.
 */
export const syncPrivateCommands = async (input: {
  retry?: RetryPolicy;
  tier: Tier;
  userId: number;
}) => {
  const providers = effectiveProviders();
  await tgBestEffort(
    "setMyCommands",
    async (api) =>
      await api.setMyCommands(
        commandsForTier(input.tier, { provider: providerOffered(providers) }),
        {
          scope: { chat_id: input.userId, type: "chat" },
        }
      ),
    { logLevel: "warn", retry: input.retry ?? "all" }
  );
};

/**
 * Group menus stay generic; privileged commands are private-chat commands.
 * Never rejects, like `syncPrivateCommands`.
 */
export const syncGeneralCommands = async () => {
  const scopes = [
    { type: "default" as const },
    { type: "all_private_chats" as const },
    { type: "all_group_chats" as const },
    { type: "all_chat_administrators" as const },
  ];
  await Promise.all(
    scopes.map(
      async (scope) =>
        await tgBestEffort(
          "setMyCommands",
          async (api) => await api.setMyCommands(generalCommands(), { scope }),
          { logLevel: "warn", retry: "all" }
        )
    )
  );
};

/**
 * Publish every menu: the general one, the owner's and each user's. Run at
 * boot and after a language switch, since the descriptions are copy.
 */
export const syncAllCommands = async (ownerId: number) => {
  const users = await listUsers();
  await Promise.all([
    syncGeneralCommands(),
    syncPrivateCommands({ tier: "owner", userId: ownerId }),
    ...users.map(async (user) => {
      await syncPrivateCommands({ tier: user.tier, userId: user.userId });
    }),
  ]);
};
