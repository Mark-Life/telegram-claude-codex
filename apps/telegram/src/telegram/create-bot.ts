import { Bot } from "grammy";

import type { BotContext } from "../access/context";

/**
 * The bot's own user id, which prefixes every token. The access middleware
 * drops the bot's own updates by comparing against it, so a token that does not
 * start with an id fails the boot instead of turning that guard into a no-op.
 */
const parseBotId = (token: string) => {
  const id = Number(token.split(":")[0] ?? "");
  if (!(Number.isSafeInteger(id) && id > 0)) {
    throw new Error("BOT_TOKEN does not start with a bot id");
  }
  return id;
};

/**
 * The grammy bot and its own id, nothing registered yet. The access pipeline
 * (`./access-pipeline.ts`) and the command handlers are installed by the
 * entrypoint once the runtime exists, so this module — which the runtime's
 * `TelegramBot` service builds — imports neither the db bridge nor any handler.
 */
export const createBot = (config: { token: string }) => {
  const bot = new Bot<BotContext>(config.token);
  const botId = parseBotId(config.token);
  return { bot, botId };
};
