/**
 * Who the bot is in the copy people read: its name, its grammatical gender and
 * whose assistant it is. All three are settings the owner changes through
 * `profile-cli.ts set-persona`; an unset name is the neutral default of the
 * language in use ("Ассистент", "Assistant"), an unset gender is male, and an
 * unset owner name drops every clause that would mention the owner.
 */
import { getSetting } from "./db/bridge";
import { LANGUAGES, stringsFor, t } from "./i18n";
import type { PersonaGender } from "./i18n/ru-grammar";

export interface Persona {
  readonly callName: string;
  readonly gender: PersonaGender;
  /** Unset drops every clause that would name the owner. */
  readonly ownerName: string | undefined;
}

/** Every language's default name; an unset name answers to all of them. */
const DEFAULT_CALL_NAMES = LANGUAGES.map(
  (language) => stringsFor(language).defaultCallName
);

/** Anything but an explicit "female" reads as the default, male. */
export const personaGenderOf = (raw: string | undefined): PersonaGender =>
  raw === "female" ? "female" : "male";

const nonBlank = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** Build a persona from raw setting values. */
export const personaOf = (raw: {
  callName?: string;
  gender?: string;
  ownerName?: string;
}): Persona => ({
  callName: nonBlank(raw.callName) ?? t().defaultCallName,
  gender: personaGenderOf(raw.gender),
  ownerName: nonBlank(raw.ownerName),
});

/** The name the bot answers to now: the setting, or the default when unset. */
export const loadCallName = async () =>
  nonBlank(await getSetting("call_name")) ?? t().defaultCallName;

/**
 * Every name a message may call the bot by: the setting, or with none set the
 * default of each language, so switching the language never deafens it.
 */
export const loadHeardNames = async () => {
  const stored = nonBlank(await getSetting("call_name"));
  return stored === undefined ? DEFAULT_CALL_NAMES : [stored];
};

/** The persona as stored now. */
export const loadPersona = async () => {
  const [callName, gender, ownerName] = await Promise.all([
    getSetting("call_name"),
    getSetting("persona_gender"),
    getSetting("owner_name"),
  ]);
  return personaOf({ callName, gender, ownerName });
};
