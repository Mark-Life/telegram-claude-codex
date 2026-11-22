import { turnOn } from "./codex-turns";
import type { OneTurnClient } from "./codex-turns";
import { runSideTurn } from "./side-turn";
import type { HelperPick, HelperTurn } from "./types";

/**
 * The fallback of the second gate on the call-name trigger, used whenever
 * `address-judge.ts` has no TypeSafe key or its call fails. A cheap name scan
 * says the bot's name appeared; this asks the helper provider's one-turn pass
 * (Codex, Claude or pi) on its cheapest model, or the owner's pick, whether
 * the bot was actually being spoken to, or whether someone merely mentioned
 * it (or a person with the same name). Every failure answers "no", so the
 * bot stays silent when unsure.
 */

/**
 * How long the group path waits for that one token. The judge is awaited inline
 * before any run is registered, so a hung turn is not `/stop`-able and holds a
 * shutdown drain open; past this it is abandoned and the bot stays silent.
 */
export const JUDGE_TIMEOUT_MS = 30_000;

/** One line of group chat as the judge sees it. */
export interface JudgeMessage {
  from: string;
  text: string;
}

/**
 * Where the judged message was written. In a group the bot is one participant;
 * in the owner's Business chat it is not a participant at all, so "you" is
 * almost always the human peer and the bot is mostly talked about.
 */
export type JudgeSurface =
  | { kind: "group" }
  | { kind: "business"; ownerName: string; peerName: string };

/** What the judge needs: the bot's spoken name and the tail of the chat. */
export interface JudgeArgs {
  botName: string;
  /** Oldest first; the last entry is the message being judged. */
  messages: readonly JudgeMessage[];
  surface: JudgeSurface;
  /** Directory the throwaway thread runs in; read-only, never the bot repo. */
  workingDirectory: string;
}

const YES = "YES";

const surfaceIntro = (botName: string, surface: JudgeSurface) =>
  surface.kind === "group"
    ? [
        `You are a message classifier for a Telegram group-chat bot named "${botName}".`,
        "Several people talk in this chat; the bot is one of the participants.",
      ]
    : [
        `You are a message classifier for an assistant bot named "${botName}".`,
        `The messages come from a private one-to-one Telegram chat between the owner, ${surface.ownerName}, and another human, ${surface.peerName}.`,
        `The bot is not a participant: it silently listens on the owner's side. Almost every message here is meant for ${surface.peerName}, including messages in which the owner discusses the bot.`,
      ];

const surfaceRules = (botName: string, surface: JudgeSurface) =>
  surface.kind === "group"
    ? []
    : [
        `- "you", "listen", "look", "come on" and other second-person words mean ${surface.peerName}, not the bot, unless the bot's name is used right there as the form of address.`,
        `- the owner reacts to what ${surface.peerName} said, or thinks aloud about how ${botName} works, could work or should be used.`,
      ];

/** Render the chat tail plus the question, answerable in one token. */
export const buildJudgePrompt = ({ botName, messages, surface }: JudgeArgs) => {
  const transcript = messages
    .map((message) => `${message.from}: ${message.text}`)
    .join("\n");
  return [
    ...surfaceIntro(botName, surface),
    "Voice messages appear as speech-recognition transcripts: long, unpunctuated, with recognition errors.",
    "",
    "Recent messages, oldest first:",
    "",
    transcript,
    "",
    `Question: is the LAST message spoken TO ${botName} — a request, question or instruction for the bot itself?`,
    "",
    `Answer YES only when the speaker addresses the bot directly: its name used as the form of address (usually "${botName}, …") together with something for the bot to do or answer.`,
    "Such a direct address stays YES even when the message is long, repeats an earlier request, sets a standing rule for the future, or also mentions other people.",
    "",
    "Answer NO when:",
    `- the bot is talked ABOUT in the third person: what it can or cannot do, what it said, how it works, plans for it ("${botName} can", "through ${botName}", "he", "she", "the assistant ${botName}");`,
    "- the name is part of a title, folder, task or note name, or belongs to another person;",
    `- the message is addressed to a person, by their name ("Andrey, …") or as "you", even if it asks that person to do something with or for ${botName};`,
    ...surfaceRules(botName, surface),
    "- the name appears only in passing, or the message just thanks or praises the bot.",
    "",
    "If unsure, answer NO: a missed request costs one repeat, an unwanted answer barges into a conversation between people.",
    `Reply with exactly one word: ${YES} or NO.`,
  ].join("\n");
};

/** The verdict, read strictly: anything but a leading YES means stay silent. */
export const parseVerdict = (raw: string) =>
  raw.trim().toUpperCase().startsWith(YES);

/**
 * The slice of the Codex SDK the judge drives, kept so a test can hand it a
 * fake client instead of spawning Codex.
 */
export type JudgeClient = OneTurnClient;

/**
 * Ask one turn whether the last message was addressed to the bot. The turn is
 * capped by `JUDGE_TIMEOUT_MS`; a timeout raises like any other failure and so
 * lands on the same answer — no.
 */
const judgeOn = async (turn: HelperTurn, args: JudgeArgs) => {
  if (args.messages.length === 0) {
    return false;
  }
  try {
    return parseVerdict(
      await turn({
        prompt: buildJudgePrompt(args),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
        workingDirectory: args.workingDirectory,
      })
    );
  } catch {
    // A judge that cannot answer must not make the bot speak.
    return false;
  }
};

/** Judge on a Codex SDK client (or a fake of one). */
export const judgeWith = async (client: JudgeClient, args: JudgeArgs) =>
  await judgeOn(turnOn(client), args);

/**
 * Whether the last group message was addressed to the bot, asked of
 * `pick.helper`. Errors mean no, and so do a full side-turn pool and a helper
 * with no `oneTurn`: the bot stays silent rather than spawn an agent process
 * for every inbound message. The pick's model and depth are the owner's for
 * the judge; absent keeps the helper's light model and its own effort.
 */
export const judgeAddressed = async (args: JudgeArgs, pick: HelperPick) =>
  await runSideTurn({
    ...pick,
    fallback: false,
    label: "address_judge",
    turn: async (turn) => await judgeOn(turn, args),
  });
