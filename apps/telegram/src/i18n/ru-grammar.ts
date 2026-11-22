/**
 * The Russian grammar the bot's copy needs: gendered verb forms and the cases
 * a first name takes. English copy has no use for any of it.
 */

export type PersonaGender = "female" | "male";

/** Pick the female or male form of one phrase. */
export const byGender = (
  gender: PersonaGender,
  female: string,
  male: string
) => (gender === "male" ? male : female);

/** Letters after which Russian spelling writes "и", never "ы". */
const SOFTENING_CONSONANTS = new Set(["г", "ж", "к", "х", "ч", "ш", "щ"]);

const CYRILLIC_CONSONANT_RE = /[бвгджзклмнпрстфхцчшщ]$/iu;

/**
 * Accusative of a first name: "Саша" -> "Сашу", "Иван" -> "Ивана". A name
 * the rules do not cover (foreign, indeclinable) is returned as is.
 */
export const accusativeName = (name: string) => {
  const last = name.at(-1)?.toLowerCase();
  const stem = name.slice(0, -1);
  if (last === "а") {
    return `${stem}у`;
  }
  if (last === "я") {
    return `${stem}ю`;
  }
  if (last === "й" || last === "ь") {
    return `${stem}я`;
  }
  return CYRILLIC_CONSONANT_RE.test(name) ? `${name}а` : name;
};

/** Genitive of a first name: "Иван" -> "Ивана", "Маша" -> "Маши". */
export const genitiveName = (name: string) => {
  const last = name.at(-1)?.toLowerCase();
  const stem = name.slice(0, -1);
  const beforeLast = stem.at(-1)?.toLowerCase() ?? "";
  if (last === "а") {
    return `${stem}${SOFTENING_CONSONANTS.has(beforeLast) ? "и" : "ы"}`;
  }
  if (last === "я") {
    return `${stem}и`;
  }
  if (last === "й" || last === "ь") {
    return `${stem}я`;
  }
  return CYRILLIC_CONSONANT_RE.test(name) ? `${name}а` : name;
};
