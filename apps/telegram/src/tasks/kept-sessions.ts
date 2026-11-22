import { discardClaudeSession } from "@workspace/agent";
import { Option, Schema } from "effect";

import { getSetting, setSetting } from "../db/bridge";
import { logRejection } from "../handlers/helpers";
import { logInfo } from "../log";

/**
 * The Claude transcripts fresh task fires keep only so a restart can
 * continue them (`task_kept_sessions`, a JSON array of session ids). A fire
 * notes its session as it starts and deletes it at its end; one the process
 * died in (a crash, an OOM kill) never reaches its end, so the boot deletes
 * every noted transcript no park row names (`sweepKeptSessions`).
 */

const KeptSessions = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeKept = Schema.decodeUnknownOption(KeptSessions);
const encodeKept = Schema.encodeSync(KeptSessions);

/** The ids noted by this process: the boot's sweep never deletes these. */
const notedHere = new Set<string>();

// Every read-modify-write of the list runs one at a time, in call order.
let chain: Promise<unknown> = Promise.resolve();

const edit = async <T>(
  change: (ids: readonly string[]) => { ids: readonly string[]; result: T }
) => {
  const next = chain.then(async () => {
    const stored = await getSetting("task_kept_sessions");
    const ids: readonly string[] =
      stored === undefined
        ? []
        : Option.getOrElse(decodeKept(stored), () => []);
    const { ids: kept, result } = change(ids);
    if (kept.length !== ids.length) {
      await setSetting({ key: "task_kept_sessions", value: encodeKept(kept) });
    }
    return result;
  });
  // The chain only orders the edits; each caller sees its own failure.
  chain = Promise.allSettled([next]);
  return await next;
};

/** Note a fresh fire's session as it starts, so a crash cannot leak it. */
export const noteKeptSession = async (sessionId: string) => {
  notedHere.add(sessionId);
  await edit((ids) => ({
    ids: ids.includes(sessionId) ? ids : [...ids, sessionId],
    result: undefined,
  }));
};

/** Delete a fresh fire's transcript, and its note. */
export const discardKeptSession = async (sessionId: string) => {
  await discardClaudeSession(sessionId);
  notedHere.delete(sessionId);
  await edit((ids) => ({
    ids: ids.filter((id) => id !== sessionId),
    result: undefined,
  }));
};

/**
 * At boot: delete every noted transcript an earlier process left behind
 * that no park row (`parked`) still names. One that fails to delete keeps
 * its note for the next boot. Answers how many went.
 */
export const sweepKeptSessions = async (parked: ReadonlySet<string>) => {
  const stale = await edit((ids) => ({
    ids,
    result: ids.filter((id) => !parked.has(id) && !notedHere.has(id)),
  }));
  const deleted: string[] = [];
  for (const id of stale) {
    // oxlint-disable-next-line no-await-in-loop -- few, one at a time
    await discardClaudeSession(id)
      .then(() => deleted.push(id))
      .catch(
        logRejection(`[continuation] leftover task session ${id} not deleted`)
      );
  }
  // Only once deleted: a failed delete leaves its note for the next boot.
  await edit((ids) => ({
    ids: ids.filter((id) => !deleted.includes(id)),
    result: undefined,
  }));
  if (deleted.length > 0) {
    logInfo(
      `[continuation] deleted ${deleted.length} leftover task session(s)`
    );
  }
  return deleted.length;
};
