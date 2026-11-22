import { admin } from "./admin";
import { api } from "./api";
import { common } from "./common";
import { conversation } from "./conversation";
import { schedule } from "./schedule";
import { settings } from "./settings";

/** The Russian copy: the source of every key the other languages must match. */
export const ru = {
  ...common,
  ...admin,
  ...api,
  ...conversation,
  ...schedule,
  ...settings,
};

export type Locale = typeof ru;
