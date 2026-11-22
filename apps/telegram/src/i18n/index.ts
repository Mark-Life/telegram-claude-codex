import { en } from "./en";
import { ru } from "./ru";
import type { Locale } from "./ru";

/**
 * The language of everything the bot itself says: replies, menus, buttons,
 * notices and command descriptions. Not the language a model answers in; that
 * is the owner's workspace rule. `ru` is the source of every key, and `en`
 * must match its shape, so a missing key fails the typecheck.
 */
export const LANGUAGES = ["ru", "en"] as const;

export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "en";

const LOCALES = { en, ru } as const satisfies Record<Language, Locale>;

export const isLanguage = (raw: string | undefined): raw is Language =>
  LANGUAGES.some((language) => language === raw);

/** A stored value as a language; unset or unknown reads as the default. */
export const parseLanguage = (raw: string | undefined) =>
  isLanguage(raw) ? raw : DEFAULT_LANGUAGE;

/**
 * The language in use. `bot-settings.ts` fills it at boot and on every write;
 * until then, and in tests, it is the default.
 */
interface LanguageInUse {
  language: Language;
}

const current: LanguageInUse = { language: DEFAULT_LANGUAGE };

export const currentLanguage = () => current.language;

export const switchLanguage = (language: Language) => {
  current.language = language;
};

/** The copy of one language. */
export const stringsFor = (language: Language) => LOCALES[language];

/** The copy of the language in use. */
export const t = () => LOCALES[current.language];
