import type { Locale } from "../ru";
import { admin } from "./admin";
import { api } from "./api";
import { common } from "./common";
import { conversation } from "./conversation";
import { schedule } from "./schedule";
import { settings } from "./settings";

/** The English copy; each area module matches its Russian source key for key. */
export const en = {
  ...common,
  ...admin,
  ...api,
  ...conversation,
  ...schedule,
  ...settings,
} satisfies Locale;
