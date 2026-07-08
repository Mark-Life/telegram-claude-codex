import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  importLegacySessions,
  type LegacySessions,
} from "./agent/session-store";
import type { ProviderId } from "./agent/types";
import { writeJsonAtomic } from "./atomic-write";
import { runtime } from "./runtime";

const STATE_VERSION = 1 as const;

interface PersistedState {
  activeProject: string;
  activeProvider: ProviderId;
  version?: number;
}

interface BotState {
  activeProject: string;
  activeProvider: ProviderId;
}

const DATA_DIR = join(import.meta.dirname, "..", ".data");
const STATE_FILE = join(DATA_DIR, "state.json");
const DEFAULT_PROVIDER: ProviderId = "claude";

/**
 * Best-effort operational event. Bridged through the runtime so it flows to the
 * phase-1 logger; a logging fault must never abort a state read or write, so the
 * whole call is guarded.
 */
const logEvent = (fields: Record<string, unknown>) => {
  try {
    runtime.runFork(Effect.logInfo("state").pipe(Effect.annotateLogs(fields)));
  } catch {
    // best-effort: never let observability break persistence
  }
};

/** Detect the old flat-session shape (no activeProvider, or a string session value). */
function isOldShape(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (!("activeProvider" in obj)) {
    return true;
  }
  const sessions = obj.sessions;
  if (sessions && typeof sessions === "object") {
    for (const value of Object.values(sessions)) {
      if (typeof value === "string") {
        return true;
      }
    }
  }
  return false;
}

/** Extract legacy session ids from either the old flat shape or the prior nested shape. */
function buildLegacySessions(parsed: unknown): LegacySessions {
  const sessions: LegacySessions = { claude: new Map(), codex: new Map() };
  if (isOldShape(parsed)) {
    const oldSessions =
      (parsed as { sessions?: Record<string, string> }).sessions ?? {};
    sessions.claude = new Map(Object.entries(oldSessions));
    return sessions;
  }
  const nested = parsed as {
    sessions?: Partial<Record<ProviderId, Record<string, string>>>;
  };
  sessions.claude = new Map(Object.entries(nested.sessions?.claude ?? {}));
  sessions.codex = new Map(Object.entries(nested.sessions?.codex ?? {}));
  return sessions;
}

/** Parse + normalize the persisted state, throwing only on genuine corruption. */
function parseState(text: string) {
  const parsed = JSON.parse(text) as unknown;

  const activeProjectRaw =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).activeProject
      : undefined;
  const activeProject =
    typeof activeProjectRaw === "string" && existsSync(activeProjectRaw)
      ? activeProjectRaw
      : "";

  const activeProviderRaw =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).activeProvider
      : undefined;
  const activeProvider: ProviderId =
    activeProviderRaw === "claude" || activeProviderRaw === "codex"
      ? activeProviderRaw
      : DEFAULT_PROVIDER;

  return {
    activeProvider,
    activeProject,
    legacySessions: buildLegacySessions(parsed),
  };
}

/**
 * Load persisted state, distinguishing a legitimate first run from corruption.
 * A missing file returns null (fresh start). A parse/corruption error preserves
 * the bad file as `state.json.corrupt-<ts>` (best-effort — a read-only `.data`
 * must not block boot) and returns null so the bot still starts with defaults —
 * never a silent total wipe. Legacy inline sessions are imported once into the
 * SessionStore on a successful read.
 */
export function loadPersistedState() {
  let text: string;
  try {
    text = readFileSync(STATE_FILE, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      logEvent({ event: "state.load", result: "missing" });
      return null;
    }
    throw e; // real IO fault — surface, don't mask as empty state
  }

  let parsed: ReturnType<typeof parseState>;
  try {
    parsed = parseState(text);
  } catch (err) {
    // Only a genuine parse/shape fault is corruption. Preserve the bad file.
    const corruptPath = `${STATE_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(STATE_FILE, corruptPath);
    } catch {
      // keep booting even if preservation fails (read-only / full disk)
    }
    logEvent({
      event: "state.load",
      result: "corrupt",
      preservedTo: corruptPath,
      errorClass: (err as Error).name,
    });
    return null; // fail open: boot with defaults, but the data is preserved
  }

  // The legacy import writes a SECOND file (sessions.json); a transient write
  // fault there must never be mistaken for state.json corruption, so it is
  // best-effort and outside the corruption guard above.
  try {
    importLegacySessions(parsed.legacySessions);
  } catch (err) {
    logEvent({
      event: "state.load",
      result: "legacy-import-failed",
      errorClass: (err as Error).name,
    });
  }
  logEvent({ event: "state.load", result: "ok" });
  return {
    activeProvider: parsed.activeProvider,
    activeProject: parsed.activeProject,
  };
}

/** Persist active project + provider via a versioned, collision-safe atomic write. */
function saveState(activeProvider: ProviderId, activeProject: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: PersistedState = {
    version: STATE_VERSION,
    activeProvider,
    activeProject,
  };
  const { bytes, durationMs } = writeJsonAtomic(STATE_FILE, data);
  logEvent({ event: "state.save", bytes, durationMs });
}

/** Set active project and persist. */
export function setActiveProject(state: BotState, path: string) {
  state.activeProject = path;
  saveState(state.activeProvider, state.activeProject);
}

/** Set the active provider and persist. */
export function setActiveProvider(state: BotState, providerId: ProviderId) {
  state.activeProvider = providerId;
  saveState(state.activeProvider, state.activeProject);
}
