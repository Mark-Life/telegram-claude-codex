import { localName, namespaceOf, ROOT_NAMESPACE } from "./raw-schema";
import type { RawEntry } from "./raw-schema";

/**
 * Which raw Telegram methods a run may call, and how. One classifier,
 * checked in this order, first match wins:
 *
 * - `deny`, whatever the writes mode: bot-only methods, the wrappers that
 *   would carry another call past this check, whole namespaces (logins,
 *   payments, calls, uploads, SMS jobs, Fragment, mtcute's own), the
 *   account's password, sessions, takeout, email, phone, passport and push
 *   methods, deleting the account or a chat, handing a channel over, web
 *   views and URL logins, pressing a bot's button, voting (the typed `vote`
 *   tool shows the answers' text), the reads that act too, whose result
 *   could not come back from behind a button, and a read that can spend
 *   Stars or record a referral;
 * - `read`: `get*`, `search*`, `check*`, `resolve*`, run at once;
 * - `mark`: the read marks in `MARK_METHODS`, run at once like `mark_read`;
 * - `write`: everything else, always behind the owner's button.
 *
 * The names are a heuristic, which is why every write asks, even under
 * `direct`. Pure, so a test can run it over the whole schema.
 */

type RawClass = "deny" | "mark" | "read" | "write";

/** A class and, for a denied method, why. */
interface RawVerdict {
  readonly class: RawClass;
  readonly reason?: string;
}

/**
 * Every namespace of the layer and whether its methods are classified or all
 * denied. A namespace a new layer adds is missing here, so it is denied until
 * someone looks at it, and the policy test fails until then.
 */
export const RAW_NAMESPACES: ReadonlyMap<string, "classify" | "deny"> = new Map(
  [
    [ROOT_NAMESPACE, "deny"],
    ["account", "classify"],
    ["aicompose", "classify"],
    ["auth", "deny"],
    ["bots", "classify"],
    ["channels", "classify"],
    ["chatlists", "classify"],
    ["communities", "classify"],
    ["contacts", "classify"],
    ["ephemeral", "classify"],
    ["folders", "classify"],
    ["fragment", "deny"],
    ["help", "classify"],
    ["langpack", "classify"],
    ["messages", "classify"],
    ["mtcute", "deny"],
    ["payments", "deny"],
    ["phone", "deny"],
    ["photos", "classify"],
    ["premium", "classify"],
    ["smsjobs", "deny"],
    ["stats", "classify"],
    ["stickers", "classify"],
    ["stories", "classify"],
    ["updates", "classify"],
    ["upload", "deny"],
    ["users", "classify"],
  ]
);

const ACCOUNT_DENIED =
  /Password|Passkey|Authorization|Takeout|Email|Phone|SecureValue|Device/u;

const IRREVERSIBLE = "irreversible, or presses a bot's button";
const ACTS_TOO =
  "reads but acts too, and its result could not come back from behind the owner's button";

/** Denied one by one, each with why. */
const DENIED_METHODS: ReadonlyMap<string, string> = new Map([
  ["account.deleteAccount", IRREVERSIBLE],
  // Counts a view on the link's owner's business link.
  ["account.resolveBusinessChatLink", ACTS_TOO],
  ["account.setAccountTTL", IRREVERSIBLE],
  ["channels.deleteChannel", IRREVERSIBLE],
  ["channels.editCreator", IRREVERSIBLE],
  // Can publish the owner's location.
  ["contacts.getLocated", ACTS_TOO],
  ["ephemeral.getCallbackAnswer", IRREVERSIBLE],
  ["messages.deleteChat", IRREVERSIBLE],
  ["messages.editChatCreator", IRREVERSIBLE],
  ["messages.getBotCallbackAnswer", IRREVERSIBLE],
  // Sends the query, and maybe the location, to a bot.
  ["messages.getInlineBotResults", ACTS_TOO],
  // Its `increment` flag counts a view.
  ["messages.getMessagesViews", ACTS_TOO],
  [
    "messages.sendVote",
    "use the vote tool, which shows the owner the answers' text",
  ],
]);

const WEB = /WebView|WebApp|UrlAuth/u;

/**
 * Arguments that make a read act: `allow_paid_stars` spends the owner's Stars
 * (`channels.searchPosts`, whose free searches are limited too) and `referer`
 * records a bot's affiliate referral (`contacts.resolveUsername`,
 * `help.getRecentMeUrls`).
 */
const ACTING_ARGUMENTS = new Set(["allow_paid_stars", "referer"]);

const READ = /^(?:get|search|check|resolve)/u;
/**
 * The methods that only move a read mark, run at once like `mark_read`. An
 * allowlist, not `read*`: `readMessageContents` marks a voice or round note
 * played for its sender and starts a view-once or timed message's countdown,
 * and `readEncryptedHistory` starts every timer of a secret chat, so both
 * are writes behind the button.
 */
const MARK_METHODS = new Set([
  "channels.readHistory",
  "messages.readDiscussion",
  "messages.readFeaturedStickers",
  "messages.readHistory",
  "messages.readMentions",
  "messages.readPollVotes",
  "messages.readReactions",
  "messages.readSavedHistory",
]);

const denied = (reason: string): RawVerdict => ({ class: "deny", reason });

const denyReason = (
  entry: Pick<RawEntry, "arguments" | "available" | "name">
) => {
  const namespace = namespaceOf(entry.name);
  const local = localName(entry.name);
  const rule = RAW_NAMESPACES.get(namespace);
  if (rule === undefined) {
    return `namespace ${namespace} is not reviewed yet`;
  }
  if (rule === "deny") {
    return namespace === ROOT_NAMESPACE
      ? "wrapper methods would carry another call past the policy"
      : `the ${namespace} namespace is never called raw`;
  }
  if (entry.available === "bot") {
    return "bot-only method";
  }
  if (entry.arguments.some((argument) => argument.type.startsWith("!"))) {
    return "wraps another call";
  }
  if (namespace === "account" && ACCOUNT_DENIED.test(local)) {
    return "touches the account's login, sessions, contact details or devices";
  }
  const reason = DENIED_METHODS.get(entry.name);
  if (reason !== undefined) {
    return reason;
  }
  if (
    READ.test(local) &&
    entry.arguments.some((argument) => ACTING_ARGUMENTS.has(argument.name))
  ) {
    return "a read that can spend the owner's Stars or record a referral";
  }
  return WEB.test(entry.name) ? "opens a web app or logs in by URL" : undefined;
};

/** The class of one method, with the reason when it is denied. */
export const verdictOf = (
  entry: Pick<RawEntry, "arguments" | "available" | "name">
): RawVerdict => {
  const reason = denyReason(entry);
  if (reason !== undefined) {
    return denied(reason);
  }
  if (READ.test(localName(entry.name))) {
    return { class: "read" };
  }
  return { class: MARK_METHODS.has(entry.name) ? "mark" : "write" };
};
