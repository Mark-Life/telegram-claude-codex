import { noul, score } from "@typesafe-ai/sdk";
import type { SystemOneResult } from "@typesafe-ai/sdk";
import { Effect, Option } from "effect";

import { MODEL_TIERS } from "./types";
import type { ModelTier, RoutedEffort } from "./types";
import { askJev, JEV_MODEL } from "./typesafe";

/**
 * Which model and how hard it thinks, decided once per thread from the first
 * message on TypeSafe Jev. Seven judgments over one state, in one request; the
 * mapping from those judgments to a tier and an effort is the policy table
 * below, in code, so a weight can change without re-measuring the questions.
 *
 * The judgment is optional like every other Jev call: no key, an error or a
 * spent budget answers `Option.none` and the caller takes `ROUTER_FALLBACK`.
 */

/** Per attempt. The router is awaited inline, before the run is registered. */
const ROUTE_TIMEOUT_MS = 1200;

/** Total budget, the whole inline cost of routing. No room for a retry. */
const ROUTE_BUDGET_MS = 1500;

/** The answer: which tier runs the thread, and how hard it thinks. */
export interface ModelPick {
  effort: RoutedEffort;
  tier: ModelTier;
}

/** Where the message came from; a transcript reads differently from typed text. */
export const ROUTE_KINDS = [
  "text",
  "voice_transcript",
  "forwarded_content",
  "attachment",
  "scheduled_task",
] as const;

export type RouteKind = (typeof ROUTE_KINDS)[number];

/**
 * What the router reads. Everything else the run will see — the helper-script
 * prompt, the group memory excerpt, the reminder block — is machinery the
 * judgment does not need, and Jev loses accuracy on irrelevant context, so the
 * message is named on its own and the quoted turn is capped hard.
 */
export interface RouteInput {
  /**
   * The run's prompt carries a document the sender attached. Not judged: it
   * raises the pick to `DOCUMENT_FLOOR` after the judgment.
   */
  carriesDocument?: boolean;
  kind: RouteKind;
  message: string;
  replyContext?: string;
}

/** A long transcript says nothing new past this; the tail is a distractor. */
const MESSAGE_CAP = 1200;

/** The quoted message is context, not the request; it gets far less room. */
const REPLY_CAP = 300;

const buildRouteState = (input: RouteInput) => ({
  kind: input.kind,
  message: input.message.slice(0, MESSAGE_CAP),
  reply_context: input.replyContext?.slice(0, REPLY_CAP) ?? null,
});

const REASONING_DEPTH = score(
  "How much has to be worked out before `message` can be answered or acted on?",
  [
    "Nothing to work out: a greeting, a thank-you, a one-word reply, a remark, or forwarded content that carries no request at all.",
    "One look-up or one plain action, with the answer already sitting somewhere: read the calendar, answer a general-knowledge question, send a message that was dictated, move one event, search the web once.",
    "Several steps that depend on each other: find something, check it against something else, then act on the result; research a question across sources; write a text from material that has to be gathered first.",
    "Work that has to be designed before it can be done: change how a program behaves, find out why something is failing, plan a change across several files or systems, or settle requirements that contradict each other.",
  ]
);

const WORK_SIZE = score(
  "How many separate operations does `message` ask to be carried out? Count the work, not the length of the answer: fetching a list of two hundred rows is one operation.",
  [
    "None: there is nothing to do but reply.",
    "One: one look-up, one search, one question answered, one message written, one event moved, one note or card edited — however long its result runs.",
    "A few: two or three distinct operations, or one operation repeated over a handful of named items.",
    "Many: the same operation repeated over a whole collection — every overdue task, every file in a folder, every row of a sheet. A long instruction that spells out how to do one operation step by step is not this; count what is produced, not how carefully it is described.",
  ]
);

const COST_OF_ERROR = score("What does a wrong answer to `message` cost?", [
  "Almost nothing: the user reads it, sees it is wrong, and asks again.",
  "Time, or a mess the user has to undo: a calendar entry in the wrong place, a note filed wrongly, a look-up that has to be redone.",
  "Something that cannot be taken back: a message actually sent to another person, records changed or deleted in a system the user relies on, money written down wrongly, or the assistant's own program left broken.",
]);

const IS_SMALL_TALK = noul(
  "Is `message` conversation rather than a request for work?",
  {
    false: [
      "It asks for something to be found, answered, written, sent, changed or scheduled, however briefly.",
      "It is a correction or a follow-up to work already under way (`no, not like that`, `go on`, `again`), which continues that work.",
    ],
    true: [
      "A greeting, a farewell, a thank-you, an aside or a reaction with nothing asked of the assistant.",
      "Forwarded content — a news post, a quote, a joke, a picture — pasted in with no instruction attached to it.",
      "A short acknowledgement (`yes`, `ok`, `got it`) that closes the previous exchange instead of starting work.",
    ],
  }
);

const NEEDS_HEAVY_CONNECTOR = noul(
  "Does `message` ask for records to be read from or written to the organisation's database?",
  {
    false: [
      "The everyday personal tools, whatever is done with them: the calendar, Notion, Evernote, Google Reminders, Drive, Docs, Sheets and Contacts, Gmail, Telegram itself.",
      "A general question, a web search, a file on this machine, or the assistant's own settings, memory, reminders and scheduled work.",
      "A file, a note or a skill whose name merely contains the word for the database; nothing is being queried.",
      "A card, a note or a contact about a person — a Notion page, an Evernote note, a Google contact — however much finding and editing it takes.",
    ],
    true: [
      "The organisation's own database or records system, by its name or any spelling or mishearing of it.",
      'The word for a database itself, named as the place the answer comes from: "the database", "in the database", "look it up in the records".',
    ],
  }
);

const PROSE_QUALITY_MATTERS = noul(
  "Must the assistant choose the words itself, for a text another person will read as the user's own writing?",
  {
    false: [
      "The user dictates the words and asks only that they be passed on, sent or written down: the text already exists and nothing has to be composed, however personal it sounds.",
      "The answer is for the user themselves: a look-up, a list, a summary, a report, an explanation.",
      "The work is finding, filing, moving or fixing something — including finding a letter someone else wrote — rather than writing.",
      "The output is code, a command, a file listing or structured data.",
    ],
    true: [
      "Text for the user's book: a chapter, a passage, or notes that will become one.",
      "A letter, an email or a message the assistant composes from a brief, which another person then receives in the user's name.",
      "A speech, a toast, a greeting or a public post the user will deliver as their own words.",
      "Rewriting or editing the user's own text so that it reads better.",
    ],
  }
);

const NEEDS_CODE_CHANGES = noul(
  "Does `message` ask for software to be changed?",
  {
    false: [
      "It asks how something works, or what the assistant can do, without asking for a change.",
      "It asks for data to be changed — a note, a card, an event, a record — rather than a program.",
      "It names a file path, a skill or a rules file only as something to read and follow.",
    ],
    true: [
      "Change how the assistant itself behaves: its bot, its commands, its replies, its scheduled work, its access rules.",
      "Write, fix, review or deploy code, or investigate a failure in a running program.",
    ],
  }
);

/** The questions code reads. One request; they cannot see one another. */
const routeQuestions = () => ({
  cost_of_error: COST_OF_ERROR,
  is_small_talk: IS_SMALL_TALK,
  needs_code_changes: NEEDS_CODE_CHANGES,
  needs_heavy_connector: NEEDS_HEAVY_CONNECTOR,
  prose_quality_matters: PROSE_QUALITY_MATTERS,
  reasoning_depth: REASONING_DEPTH,
  work_size: WORK_SIZE,
});

/** The request as it is sent, so a calibration script measures this question. */
export const routeRequest = (input: RouteInput) => ({
  model: JEV_MODEL,
  questions: routeQuestions(),
  state: buildRouteState(input),
});

type RouteAnswers = SystemOneResult<ReturnType<typeof routeQuestions>>;

/**
 * What the router answers when it cannot ask: the everyday model at the
 * everyday effort. No key, an error, a timeout and a message with nothing in
 * it all land here, and a run never fails because a judgment did.
 */
export const ROUTER_FALLBACK = {
  effort: "medium",
  tier: "terra",
} as const satisfies ModelPick;

/**
 * A Noul at or above this reads as yes. Each flag is cheap in the direction it
 * errs — a false yes buys a stronger model for an easy question — but the two
 * measured on real Russian traffic needed their own bars: everyday tools read
 * as "a business system" below 0.8, and a message dictated word for word reads
 * as composed prose below 0.7.
 */
const YES = 0.6;
const CONNECTOR_YES = 0.8;
const PROSE_YES = 0.7;

/** Small talk is the one flag that takes a model away, so it asks for more. */
const SMALL_TALK_YES = 0.75;

/**
 * Below this the depth score is spread across levels rather than sitting on
 * one, which on this question means the message is ambiguous work — so the
 * pick moves one tier up rather than risking the weaker model.
 */
const DEPTH_CONFIDENT = 0.4;

/**
 * The midpoint between the first and second score level. A Score is a
 * probability-weighted mean, so it lands between levels; a bound here reads
 * the answer as "nearest level" and never interpolates.
 */
const LEVEL_1 = 1.5;

/**
 * Depth at or above which the work stops being everyday. Measured: on real
 * messages the second level ("several steps that depend on each other") covers
 * both an ordinary errand and a genuinely involved job. Measured, they part
 * company above 2.2: closing six overdue tasks scored 1.8, a written-out daily
 * report 2.0, and everything that had to be designed first scored 2.3 and up.
 */
const DEPTH_COMPLEX = 2.25;

/**
 * A wrong answer below this costs nothing but a re-ask, which is what "a
 * lookup" means: read-only questions scored 0.02–0.47 and everything that
 * writes to the calendar, a note or a card scored 0.7 and up.
 */
const ERROR_REVERSIBLE = 0.5;

/** A cost this high raises a `low` effort: nothing final is done at a glance. */
const COST_DEMANDS_CARE = LEVEL_1;

/**
 * Where the effort steps up. Measured, not midpoints: a single question with
 * several parts ("what is it, how dangerous, how does it differ") already
 * reads as two operations, so a plain request stays below 2, and genuinely
 * involved work only separates from a bulk errand above 2.75.
 */
const EFFORT_MEDIUM_ABOVE = 2;
const EFFORT_HIGH_ABOVE = 2.75;

const EFFORT_BY_LEVEL: readonly (readonly [number, RoutedEffort])[] = [
  [EFFORT_MEDIUM_ABOVE, "low"],
  [EFFORT_HIGH_ABOVE, "medium"],
  [Number.POSITIVE_INFINITY, "high"],
];

const atOrAbove = <T>(
  table: readonly (readonly [number, T])[],
  value: number,
  fallback: T
) => table.find(([bound]) => value < bound)?.[1] ?? fallback;

const stepUp = <T>(order: readonly T[], value: T) =>
  order[Math.min(order.indexOf(value) + 1, order.length - 1)] ?? value;

/** The stronger of two tiers; the owner's rules raise a pick, never lower it. */
const atLeast = (tier: ModelTier, floor: ModelTier) =>
  MODEL_TIERS.indexOf(tier) >= MODEL_TIERS.indexOf(floor) ? tier : floor;

/** What the ledger keeps about one routing decision. */
export interface RouteScores {
  costOfError: number;
  depthConfidence: number;
  isSmallTalk: number;
  needsCodeChanges: number;
  needsHeavyConnector: number;
  proseQualityMatters: number;
  reasoningDepth: number;
  workSize: number;
}

/** The pick, and every number that produced it. */
export interface RoutePick extends ModelPick {
  inputTokens: number;
  judgeModel: string;
  scores: RouteScores;
}

const scoresOf = (answers: RouteAnswers["answers"]): RouteScores => ({
  costOfError: answers.cost_of_error.score,
  depthConfidence: answers.reasoning_depth.confidence,
  isSmallTalk: answers.is_small_talk.noul,
  needsCodeChanges: answers.needs_code_changes.noul,
  needsHeavyConnector: answers.needs_heavy_connector.noul,
  proseQualityMatters: answers.prose_quality_matters.noul,
  reasoningDepth: answers.reasoning_depth.score,
  workSize: answers.work_size.score,
});

/**
 * The tier difficulty alone asks for: chat and read-only lookups on Luna,
 * everything everyday on Terra, work past the second level of depth on Sol.
 * A lookup is depth and consequence together — "what is the weather" and "move
 * this meeting" are both one step, and only the second one can be got wrong.
 */
const tierByDifficulty = (scores: RouteScores): ModelTier => {
  if (scores.reasoningDepth >= DEPTH_COMPLEX) {
    return "sol";
  }
  return scores.reasoningDepth < LEVEL_1 &&
    scores.costOfError < ERROR_REVERSIBLE
    ? "luna"
    : "terra";
};

/**
 * How hard the model thinks: the greater of "how much has to be worked out"
 * and "how many operations this unfolds into", since either one alone can make
 * a request demanding.
 *
 * The router stops at `high`. On 58 real first messages no threshold separated
 * `xhigh` from `high` without also catching work that plainly did not need it:
 * the deepest jobs measured 3.00 on depth and anywhere from 1.8 to 2.7 on
 * size, overlapping ordinary bulk errands. `xhigh` stays in `/effort` for a
 * human to choose; the router does not reach for it on its own.
 */
const effortFor = (scores: RouteScores): RoutedEffort => {
  const level = Math.max(scores.reasoningDepth, scores.workSize);
  const effort = atOrAbove(EFFORT_BY_LEVEL, level, "high");
  if (effort !== "low") {
    return effort;
  }
  // Three reasons never to answer at a glance: the step cannot be taken back,
  // it goes into the database, or it changes software.
  return scores.costOfError >= COST_DEMANDS_CARE ||
    scores.needsHeavyConnector >= CONNECTOR_YES ||
    scores.needsCodeChanges >= YES
    ? "medium"
    : "low";
};

/**
 * The policy table. Difficulty sets the tier and the shape of the work sets
 * the effort; then the owner's two standing rules override the tier — the
 * database runs on Sol, anything a person will read as the user's own writing
 * runs on Astra — and an ambiguous depth reading moves the pick one tier up.
 *
 * That step up stops at Sol. Astra is not "one better than Sol"; it is the
 * model the owner picked for prose, and uncertainty about how hard a job is is
 * no reason to send it there.
 */
export const pickFor = (scores: RouteScores): ModelPick => {
  if (
    scores.isSmallTalk >= SMALL_TALK_YES &&
    scores.reasoningDepth < LEVEL_1 &&
    scores.proseQualityMatters < PROSE_YES
  ) {
    return { effort: "low", tier: "luna" };
  }

  let tier = tierByDifficulty(scores);
  if (scores.needsHeavyConnector >= CONNECTOR_YES) {
    tier = atLeast(tier, "sol");
  }
  if (scores.needsCodeChanges >= YES) {
    tier = atLeast(tier, "sol");
  }
  if (scores.depthConfidence < DEPTH_CONFIDENT) {
    tier = atLeast(tier, stepUp(["luna", "terra", "sol"], tier));
  }
  if (scores.proseQualityMatters >= PROSE_YES) {
    tier = atLeast(tier, "astra");
  }
  return { effort: effortFor(scores), tier };
};

/**
 * The weakest tier that reads a sent document: Luna, Haiku on Claude, gives
 * up on a file it could read. A short or missing caption judges as chat, so
 * the floor is set by the file, never by the words.
 */
const DOCUMENT_FLOOR: ModelTier = "terra";

const pickOf = (result: RouteAnswers, input: RouteInput): RoutePick => {
  const scores = scoresOf(result.answers);
  const pick = pickFor(scores);
  return {
    effort: pick.effort,
    inputTokens: result.usage.input_tokens,
    judgeModel: result.model,
    scores,
    tier:
      input.carriesDocument === true
        ? atLeast(pick.tier, DOCUMENT_FLOOR)
        : pick.tier,
  };
};

/**
 * Route one message. `Option.none` means the router could not answer — no key,
 * no budget, a bad call — and the caller uses `ROUTER_FALLBACK`.
 */
export const routeModel = (input: RouteInput) =>
  input.message.trim().length === 0
    ? Effect.succeedNone
    : Effect.map(
        askJev(routeRequest(input), {
          budgetMs: ROUTE_BUDGET_MS,
          retries: 0,
          span: "judge.model-route",
          timeoutMs: ROUTE_TIMEOUT_MS,
        }),
        Option.map((result) => pickOf(result, input))
      );
