import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import {
  privateQuotaRefusalText,
  privateUsageMilestone,
  readLimits,
  takePrivateRun,
} from "../access/rate-limit";
import { t } from "../i18n";
import { logUnlessTelegram } from "./helpers";
import { sendToNotifyRoute } from "./workspace";

/**
 * Updates already charged. One message can reach the budget twice — a voice
 * note is charged before it is downloaded and again when its transcript starts
 * a run — and it must cost one run, not two.
 */
const charged = new WeakSet<BotContext>();

/** A stranger as a human recognises them: name, handle, and the id to act on. */
const describeSender = (from: {
  first_name?: string;
  id: number;
  last_name?: string;
  username?: string;
}) => {
  const name = [from.first_name, from.last_name]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" ");
  const handle = from.username === undefined ? undefined : `@${from.username}`;
  return [name, handle, `id ${from.id}`]
    .filter((part) => part !== undefined && part.length > 0)
    .join(", ");
};

/** What the owner is told about a stranger who is spending the day's budget. */
const usageNoticeText = (input: {
  limit: number;
  milestone: "half" | "spent";
  used: number;
  who: string;
}) =>
  input.milestone === "spent"
    ? t().quota.strangerSpent({ limit: input.limit, who: input.who })
    : t().quota.strangerBusy({
        limit: input.limit,
        used: input.used,
        who: input.who,
      });

/**
 * Take one run from the sender's day budget outside a group, tell them when it
 * is spent, and tell the owner who is spending it. Returns false only when the
 * budget refused the run — the caller then does nothing else with the message.
 * A group message costs nothing here: it is charged by the group gate instead.
 */
export const chargePrivateRun = async (ctx: BotContext, ownerId: number) => {
  const { surface, tier } = accessOf(ctx);
  const { from } = ctx;
  if (surface === "group" || from === undefined || charged.has(ctx)) {
    return true;
  }
  // Claimed before the await: a second call for the same update while the
  // budget is being read must not charge it twice.
  charged.add(ctx);
  // Read once per run, so the refusal and the notices name the budget that
  // was applied, even if the owner changes it meanwhile.
  const limits = await readLimits("private");
  const verdict = await takePrivateRun({ limits, tier, userId: from.id });
  if (!verdict.ok) {
    charged.delete(ctx);
    await ctx.reply(
      privateQuotaRefusalText({ scope: verdict.scope, userLimit: limits.user })
    );
    return false;
  }
  const milestone = privateUsageMilestone({
    limit: limits.user,
    tier,
    used: verdict.used,
  });
  if (milestone !== undefined) {
    sendToNotifyRoute({
      ownerId,
      text: usageNoticeText({
        limit: limits.user,
        milestone,
        used: verdict.used,
        who: describeSender(from),
      }),
    }).catch(logUnlessTelegram("usageNotice"));
  }
  return true;
};
