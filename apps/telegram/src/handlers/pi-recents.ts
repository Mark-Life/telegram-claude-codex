import { Option, Schema } from "effect";

import { getSetting, setSetting } from "../db/bridge";
import { logError } from "../log";

/**
 * The last few pi models picked with `/model`, newest first, bot-wide
 * (`pi_recent_models`). pi keeps no recents of its own, and these are what
 * `/model` and the `/settings` pickers offer after the favourites.
 */

const RECENT_LIMIT = 5;

const decodeRecents = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String))
);

/** The recent picks; a failed read is none. */
export const readPiRecents = async (): Promise<readonly string[]> => {
  try {
    return Option.getOrElse(
      decodeRecents(await getSetting("pi_recent_models")),
      () => []
    );
  } catch (error) {
    logError("pi recents read failed", error);
    return [];
  }
};

/** Put `model` first; a failed write is logged and costs nothing else. */
export const rememberPiPick = async (model: string) => {
  try {
    const recents = await readPiRecents();
    const next = [model, ...recents.filter((key) => key !== model)].slice(
      0,
      RECENT_LIMIT
    );
    await setSetting({ key: "pi_recent_models", value: JSON.stringify(next) });
  } catch (error) {
    logError("pi recents write failed", error);
  }
};
