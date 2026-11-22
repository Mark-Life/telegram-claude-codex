import { noul } from "@typesafe-ai/sdk";
import type { SystemOneResult } from "@typesafe-ai/sdk";
import { Effect, Option } from "effect";

import { judgeAddressed } from "./codex-judge";
import type { JudgeArgs, JudgeSurface } from "./codex-judge";
import type { HelperPick, ProviderId } from "./types";
import { askJev, JEV_MODEL } from "./typesafe";

/**
 * The second gate on the call-name trigger, on TypeSafe Jev: a name scan says
 * the bot's name appeared, this asks for the probability that the bot was
 * actually being spoken to. One judgment, thresholded per surface. Without a
 * key — or when the call fails — the helper provider's one-turn pass (Codex,
 * Claude or pi) in `codex-judge.ts` answers instead, so the worst case is a
 * one-turn yes/no on the helper pick, and silence when that fails.
 */

/** Per attempt; the judge is awaited inline before any run is registered. */
const ADDRESS_TIMEOUT_MS = 2500;

/** Total budget for the TypeSafe leg, one retry included. */
const ADDRESS_BUDGET_MS = 6000;

/**
 * Probability at or above which the bot speaks, measured per surface on
 * Russian cases: a false yes in a group barges into a conversation, in a
 * Business chat it writes to a third party as the owner, so both sit above
 * the mentions the judge scored highest and well below a plain address.
 */
export const ADDRESS_YES = { business: 0.8, group: 0.75 } as const;

/** What the judge reads. The one-turn fallback adds its own scratch directory. */
export type AddressArgs = Omit<JudgeArgs, "workingDirectory">;

/**
 * The decision, plus what produced it — the ledger records both. Only the Jev
 * leg has a probability to report, so only that branch carries the numbers.
 */
export type AddressVerdict =
  | { addressed: boolean; via: ProviderId | "none" }
  | {
      addressed: boolean;
      inputTokens: number;
      model: string;
      probability: number;
      via: "typesafe";
    };

const chatFacts = (
  botName: string,
  surface: JudgeSurface
): Record<string, string> =>
  surface.kind === "group"
    ? { bot_name: botName, kind: "group_chat_the_bot_participates_in" }
    : {
        bot_name: botName,
        kind: "private_chat_between_the_owner_and_one_other_person",
        owner_name: surface.ownerName,
        peer_name: surface.peerName,
      };

/**
 * The material to judge: the chat's own facts, the message in question named
 * on its own, and the turns before it. Splitting the judged message out of the
 * tail removes a hop — the question never says "the last element".
 */
const buildAddressState = ({ botName, messages, surface }: AddressArgs) => {
  const judged = messages.at(-1);
  return {
    chat: chatFacts(botName, surface),
    message_to_judge: judged ? { from: judged.from, text: judged.text } : null,
    preceding_messages: messages
      .slice(0, -1)
      .map(({ from, text }) => ({ from, text })),
  };
};

const INSTRUCTIONS =
  "Is `message_to_judge` spoken TO the bot named `chat.bot_name` — a request, question or instruction for the bot itself?";

const yesCriteria = (botName: string) => [
  `The bot's name is used as the form of address (usually "${botName}, …") together with something for the bot to do or answer.`,
  "Still yes when the message is long, repeats an earlier request, sets a standing rule for the future, or also mentions other people.",
  "Voice messages arrive as speech-recognition transcripts: long, unpunctuated and with recognition errors, so a distorted but recognisable form of the name still counts as the form of address.",
];

const noCriteria = (botName: string, surface: JudgeSurface) => [
  `The bot is talked ABOUT in the third person: what it can or cannot do, what it said, how it works, plans for it ("${botName} can", "through ${botName}", "he", "she", "the assistant ${botName}").`,
  "The name is part of a title, folder, task or note name, or belongs to another person.",
  'The message is addressed to a person, by their name ("Andrey, …") or as "you", even when it asks that person to do something with or for the bot.',
  "The name appears only in passing, or the message only thanks or praises the bot.",
  ...(surface.kind === "business"
    ? [
        `"you", "listen", "look", "come on" and other second-person words mean ${surface.peerName}, not the bot, unless the bot's name is the form of address right there.`,
        `The owner reacts to what ${surface.peerName} said, or thinks aloud about how ${botName} works, could work or should be used.`,
      ]
    : []),
];

/**
 * The one question code reads. `criteria` carries the boundary because the
 * judgment turns on it: the same name, the same chat, address versus mention.
 */
const addressQuestions = ({ botName, surface }: AddressArgs) => ({
  addressed_to_bot: noul(INSTRUCTIONS, {
    false: noCriteria(botName, surface),
    true: yesCriteria(botName),
  }),
});

/** The request as it is sent, so a calibration script measures this question. */
export const addressRequest = (args: AddressArgs) => ({
  model: JEV_MODEL,
  questions: addressQuestions(args),
  state: buildAddressState(args),
});

/** The probability read at this surface's threshold, plus what the ledger keeps. */
export const addressVerdictOf = (
  result: SystemOneResult<ReturnType<typeof addressQuestions>>,
  kind: JudgeSurface["kind"]
) => {
  const probability = result.answers.addressed_to_bot.noul;
  return {
    addressed: probability >= ADDRESS_YES[kind],
    inputTokens: result.usage.input_tokens,
    model: result.model,
    probability,
    via: "typesafe",
  } as const satisfies AddressVerdict;
};

/**
 * The one-turn yes/no on `pick`: the provider that serves the
 * judge, with the owner's model and depth on it. It swallows its own
 * failures already. With no such provider the answer is silence, without
 * spawning anything.
 */
const helperVerdict = (
  args: JudgeArgs,
  pick: HelperPick
): Effect.Effect<AddressVerdict> => {
  const { helper } = pick;
  if (helper === undefined) {
    return Effect.succeed({ addressed: false, via: "none" });
  }
  return Effect.tryPromise(async () => await judgeAddressed(args, pick)).pipe(
    Effect.catchCause(() => Effect.succeed(false)),
    Effect.map((addressed): AddressVerdict => ({ addressed, via: helper })),
    Effect.withSpan(`judge.addressed.${helper}`)
  );
};

/**
 * Never fails: an empty history, a missing key or a failed call all answer
 * through the one-turn pass on `pick`, where the judge's fallback runs now
 * (the owner's choice, else the detected helper); TypeSafe stays first.
 */
export const judgeAddressedVerdict = (args: JudgeArgs, pick: HelperPick) =>
  args.messages.length === 0
    ? helperVerdict(args, pick)
    : Effect.flatMap(
        askJev(addressRequest(args), {
          budgetMs: ADDRESS_BUDGET_MS,
          retries: 1,
          span: "judge.addressed.typesafe",
          timeoutMs: ADDRESS_TIMEOUT_MS,
        }),
        Option.match({
          onNone: () => helperVerdict(args, pick),
          onSome: (result) =>
            Effect.as(
              Effect.annotateLogs(Effect.logDebug("judge.addressed"), {
                probability: result.answers.addressed_to_bot.noul,
                surface: args.surface.kind,
              }),
              addressVerdictOf(result, args.surface.kind)
            ),
        })
      );
