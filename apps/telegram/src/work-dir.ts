/**
 * The single directory the assistant works in.
 *
 * `WORK_DIR` turns the multi-project setup into one fixed workspace: user files
 * live at its root, the bot's own repo sits in `owner-telegram-bot/`, and the
 * project picker is gone. It is pinned once at boot rather than read here, so
 * every module — including the ones a test imports without any environment —
 * keeps working when nothing is configured.
 */

let pinned: string | undefined;

/** Pin the working directory for the process. Called once, from the entrypoint. */
export const pinWorkDir = (dir?: string) => {
  pinned = dir !== undefined && dir.trim().length > 0 ? dir : undefined;
};

/** The pinned directory, or undefined when the multi-project layout is in use. */
export const workDir = () => pinned;

/** The pinned directory when there is one, else the caller's own choice. */
export const projectPathOr = (candidate: string) => pinned ?? candidate;
