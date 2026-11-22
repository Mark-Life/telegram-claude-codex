import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

import { isMissingFile } from "@workspace/core/errors";
import { writeJsonAtomic } from "@workspace/core/fs";
import { DATA_DIR } from "@workspace/env/paths";
import { Effect, Option, Schema } from "effect";

import { runtime } from "./runtime";

// oxlint-disable-next-line no-magic-numbers -- a schema version is the literal
const STATE_VERSION = 2 as const;

/**
 * What survives a restart. Model and effort are deliberately absent: they
 * belong to one thread, not to the bot, and live beside that thread's session
 * (the `threads` row, or the `sessions` row outside a topic). A file written
 * by an older build still carries them; they are read as unknown keys and
 * dropped. So is an older `activeProvider`: a topic reads its provider from
 * its `threads` row, the owner's private chat from the `owner_provider`
 * setting, and an older build reads a missing one as Codex.
 */
interface PersistedState {
  activeProject: string;
  version?: number;
}

export interface BotState {
  activeProject: string;
}

const STATE_FILE = path.join(DATA_DIR, "state.json");

/** Decoders for the untrusted on-disk state file: every field is read on its own
 * so one bad value degrades that field alone, never the whole file. */
const decodeRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown)
);
const decodeString = Schema.decodeUnknownOption(Schema.String);

/**
 * Best-effort operational event. Bridged through the runtime so it flows to the
 * configured logger; a logging fault must never abort a state read or write, so
 * the whole call is guarded.
 */
const logEvent = (fields: Record<string, string | number>) => {
  try {
    runtime.runFork(Effect.logInfo("state").pipe(Effect.annotateLogs(fields)));
  } catch {
    // best-effort: never let observability break persistence
  }
};

/** Parse + normalize the persisted state, throwing only on genuine corruption. */
const parseState = (text: string) => {
  const record = decodeRecord(JSON.parse(text));

  const activeProject = Option.getOrElse(
    Option.filter(
      Option.flatMap(record, (r) => decodeString(r.activeProject)),
      existsSync
    ),
    () => ""
  );
  return { activeProject };
};

/** Discriminated result of reading the raw state file (no side effects beyond corrupt-preservation). */
type StateLoad =
  | { status: "missing" }
  | { status: "corrupt"; preservedTo: string; errorClass: string }
  | ({ status: "ok" } & ReturnType<typeof parseState>);

/**
 * Read + classify the state file, distinguishing a legitimate first run
 * (`missing`) from genuine corruption. A parse/shape fault preserves the bad
 * file as `state.json.corrupt-<ts>` (best-effort — a read-only `.data` must not
 * block boot) and reports `corrupt` so the caller fails open to defaults —
 * never a silent total wipe. Pure of runtime logging so it is directly
 * unit-testable against a temp dir. A real IO fault (not ENOENT) is rethrown
 * rather than masked as empty state.
 */
export const readStateFile = (stateFile = STATE_FILE): StateLoad => {
  let text: string;
  try {
    text = readFileSync(stateFile, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { status: "missing" };
    }
    // real IO fault — surface, don't mask as empty state
    throw error;
  }

  try {
    return { status: "ok", ...parseState(text) };
  } catch (error) {
    // Only a genuine parse/shape fault is corruption. Preserve the bad file.
    const preservedTo = `${stateFile}.corrupt-${Date.now()}`;
    try {
      renameSync(stateFile, preservedTo);
    } catch {
      // keep booting even if preservation fails (read-only / full disk)
    }
    const errorClass = error instanceof Error ? error.name : "UnknownError";
    return { errorClass, preservedTo, status: "corrupt" };
  }
};

/**
 * Load persisted state, distinguishing a legitimate first run from corruption.
 * A missing/corrupt file returns null so the bot still starts with defaults;
 * corruption is preserved (see readStateFile).
 */
export const loadPersistedState = () => {
  const loaded = readStateFile(STATE_FILE);

  if (loaded.status === "missing") {
    logEvent({ event: "state.load", result: "missing" });
    return null;
  }
  if (loaded.status === "corrupt") {
    logEvent({
      errorClass: loaded.errorClass,
      event: "state.load",
      preservedTo: loaded.preservedTo,
      result: "corrupt",
    });
    // fail open: boot with defaults, but the data is preserved
    return null;
  }

  logEvent({ event: "state.load", result: "ok" });
  const state: BotState = { activeProject: loaded.activeProject };
  return state;
};

/** Persist the active project atomically. */
const saveState = (state: BotState) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: PersistedState = {
    activeProject: state.activeProject,
    version: STATE_VERSION,
  };
  const { bytes, durationMs } = writeJsonAtomic(STATE_FILE, data);
  logEvent({ bytes, durationMs, event: "state.save" });
};

/** Set active project and persist. */
export const setActiveProject = (state: BotState, projectPath: string) => {
  state.activeProject = projectPath;
  saveState(state);
};
