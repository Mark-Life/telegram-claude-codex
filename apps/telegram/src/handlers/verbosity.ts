import { getSetting } from "../db/bridge";
import {
  parseVerbosity,
  policyFor,
  QUIET_POLICY,
} from "../telegram/render-policy";
import { logRejection } from "./helpers";

/**
 * Verbosity for the running bot: the owner's row in `/settings`. Read from the
 * table on every run, not cached, so a value a dev writes straight into the
 * `verbosity` row applies too.
 */
export const currentVerbosity = async () =>
  parseVerbosity(await getSetting("verbosity"));

/**
 * Render policy matching the verbosity currently stored in the db. A failed
 * read renders quietly — the default, and the view that never shows machinery.
 */
export const currentRenderPolicy = async () => {
  try {
    return policyFor(await currentVerbosity());
  } catch (error) {
    logRejection("Verbosity read failed, rendering quietly")(error);
    return QUIET_POLICY;
  }
};
