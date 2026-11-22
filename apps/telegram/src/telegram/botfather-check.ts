import { logWarning } from "../log";
import { tg } from "./bridge";

/**
 * Warn about the bot settings no API can change.
 *
 * Group privacy and topic ("threaded") mode exist in BotFather only — there is
 * no setter, just these read-only flags on `getMe`. Privacy mode is the one
 * that costs something silently: with it enabled the bot never receives plain
 * group messages, so the call-name trigger in `access/` cannot fire and the
 * group simply looks broken.
 *
 * Read-only, never fatal, and English like the rest of the log: a wrong setting
 * degrades groups and nothing else, so it is not worth refusing to boot over.
 */
export const warnBotFatherSettings = async () => {
  const me = await tg("getMe", async (api) => await api.getMe(), {
    retry: "all",
  });
  if (!me.can_read_all_group_messages) {
    logWarning(
      "Privacy mode is enabled: the bot cannot see plain group messages, so the call-name trigger will not fire. Fix in BotFather: /setprivacy -> pick the bot -> Disable."
    );
  }
  if (!me.can_join_groups) {
    logWarning(
      "This bot cannot be added to groups. Fix in BotFather: /setjoingroups -> pick the bot -> Enable."
    );
  }
};
