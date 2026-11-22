/**
 * The cheap half of the call-name trigger: does the bot's spoken name appear in
 * this message at all? Russian names decline ("Саша", "Саше", "Сашу"), so the
 * scan matches the stem plus one of the endings a first name takes, and only as
 * a whole word — "сашими" is not the bot. A hit is a candidate, never an
 * answer: the LLM judge decides whether the bot was actually spoken to.
 *
 * Reading names at all needs privacy mode OFF in BotFather; with it on, the bot
 * only sees commands and replies to itself, and this scanner never fires.
 */

/**
 * Endings a first name picks up when declined, plus the diminutive ones: the
 * soft-sign vocative ("Дань" for "Даня"), "-ка" ("Сашка"), "-ька" ("Данька")
 * and "-ечка" ("Данечка"), each in the cases people actually address with.
 */
const DECLENSION_SUFFIXES = [
  "",
  "ь",
  "а",
  "е",
  "и",
  "у",
  "ы",
  "ю",
  "я",
  "ей",
  "ой",
  "ею",
  "ам",
  "ах",
  "ами",
  "ка",
  "ке",
  "ку",
  "кой",
  "ька",
  "ьке",
  "ьки",
  "ьку",
  "ькой",
  "ечка",
  "ечке",
  "ечки",
  "ечку",
  "ечкой",
  "s",
] as const;

/** Vowels a name may end on; the stem is the name without it. */
const TRAILING_VOWELS = new Set([
  "а",
  "е",
  "и",
  "о",
  "у",
  "ы",
  "э",
  "ю",
  "я",
  "ё",
  "a",
  "e",
  "i",
  "o",
  "u",
  "y",
]);

/**
 * Stem endings a soft sign never follows in a name: a vocative is "Саш", never
 * "Сашь", and a word ending in "-шь" is a verb ("дашь", "you will give") that
 * would make every such message a candidate.
 */
const HUSHING_CONSONANTS = new Set(["ж", "ч", "ш", "щ"]);

/** Shortest stem worth matching, so a two-letter name cannot match everything. */
const MIN_STEM_LENGTH = 3;

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/gu;

/** The part of a name that survives declension: "Саша" -> "Саш". */
export const callNameStem = (name: string) => {
  const trimmed = name.trim();
  const last = trimmed.at(-1)?.toLowerCase() ?? "";
  return trimmed.length > MIN_STEM_LENGTH && TRAILING_VOWELS.has(last)
    ? trimmed.slice(0, -1)
    : trimmed;
};

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

const WORD_START = "(?<![\\p{L}\\p{N}])";
const WORD_END = "(?![\\p{L}\\p{N}])";

/**
 * Whole-word matcher for a call name and its declensions. Word boundaries are
 * lookarounds over letters and digits, because `\b` is ASCII-only and would
 * treat every Cyrillic letter as a boundary. A name in another script does
 * not decline: it matches whole, plus a plural or possessive "s", so "Max"
 * never turns into the word "maximum".
 */
export const buildCallNameMatcher = (name: string) => {
  if (!CYRILLIC_RE.test(name)) {
    const whole = name.trim().replaceAll(ESCAPE_RE, String.raw`\$&`);
    return new RegExp(`${WORD_START}${whole}s?${WORD_END}`, "iu");
  }
  const bare = callNameStem(name);
  const hushing = HUSHING_CONSONANTS.has(bare.at(-1)?.toLowerCase() ?? "");
  const stem = bare.replaceAll(ESCAPE_RE, String.raw`\$&`);
  const suffixes = DECLENSION_SUFFIXES.flatMap((suffix) =>
    suffix.length === 0 || (hushing && suffix.startsWith("ь"))
      ? []
      : [suffix.replaceAll(ESCAPE_RE, String.raw`\$&`)]
  ).join("|");
  return new RegExp(`${WORD_START}${stem}(?:${suffixes})?${WORD_END}`, "iu");
};

/** Whether the bot's spoken name appears in the text. Blank names never match. */
export const mentionsCallName = (text: string, name?: string) => {
  if (name === undefined) {
    return false;
  }
  const stem = callNameStem(name);
  if (stem.length < MIN_STEM_LENGTH) {
    return false;
  }
  return buildCallNameMatcher(name).test(text);
};

/** The first of `names` the text calls the bot by, if any. */
export const heardCallName = (text: string, names: readonly string[]) =>
  names.find((name) => mentionsCallName(text, name));
