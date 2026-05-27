import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "./agent/types";

interface PersistedState {
  activeProject: string;
  activeProvider: ProviderId;
  sessions: Record<ProviderId, Record<string, string>>;
}

interface BotState {
  activeProject: string;
  activeProvider: ProviderId;
  sessions: Record<ProviderId, Map<string, string>>;
}

const DATA_DIR = join(import.meta.dirname, "..", ".data");
const STATE_FILE = join(DATA_DIR, "state.json");
const DEFAULT_PROVIDER: ProviderId = "claude";

/** Detect the old flat-session shape (no activeProvider, or a session value is
 * a string instead of a nested object). */
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

/** Build empty per-provider session maps. */
function emptySessions(): Record<ProviderId, Map<string, string>> {
  return { claude: new Map(), codex: new Map() };
}

/** Load persisted state from disk, migrating the old flat-session shape to the
 * provider-namespaced shape. Returns null if the file is missing or corrupt. */
export function loadPersistedState() {
  try {
    const text = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(text) as unknown;

    const activeProjectRaw =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).activeProject
        : undefined;
    const activeProject =
      typeof activeProjectRaw === "string" && existsSync(activeProjectRaw)
        ? activeProjectRaw
        : "";

    if (isOldShape(parsed)) {
      const oldSessions =
        (parsed as { sessions?: Record<string, string> }).sessions ?? {};
      const sessions = emptySessions();
      sessions.claude = new Map(Object.entries(oldSessions));
      return { activeProvider: DEFAULT_PROVIDER, activeProject, sessions };
    }

    const persisted = parsed as PersistedState;
    const activeProvider = persisted.activeProvider ?? DEFAULT_PROVIDER;
    const sessions = emptySessions();
    sessions.claude = new Map(Object.entries(persisted.sessions?.claude ?? {}));
    sessions.codex = new Map(Object.entries(persisted.sessions?.codex ?? {}));

    return { activeProvider, activeProject, sessions };
  } catch {
    return null;
  }
}

/** Persist the provider-namespaced state via an atomic tmp+rename write */
function saveState(
  activeProvider: ProviderId,
  activeProject: string,
  sessions: Record<ProviderId, Map<string, string>>
) {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: PersistedState = {
    activeProvider,
    activeProject,
    sessions: {
      claude: Object.fromEntries(sessions.claude),
      codex: Object.fromEntries(sessions.codex),
    },
  };
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, STATE_FILE);
}

/** Set active project and persist. */
export function setActiveProject(state: BotState, path: string) {
  state.activeProject = path;
  saveState(state.activeProvider, state.activeProject, state.sessions);
}

/** Set the active provider and persist. */
export function setActiveProvider(state: BotState, providerId: ProviderId) {
  state.activeProvider = providerId;
  saveState(state.activeProvider, state.activeProject, state.sessions);
}

/** Update or delete a session mapping for a provider and persist. */
export function updateSession(
  state: BotState,
  providerId: ProviderId,
  projectPath: string,
  sessionId?: string
) {
  const providerSessions = state.sessions[providerId];
  if (sessionId) {
    providerSessions.set(projectPath, sessionId);
  } else {
    providerSessions.delete(projectPath);
  }
  saveState(state.activeProvider, state.activeProject, state.sessions);
}
