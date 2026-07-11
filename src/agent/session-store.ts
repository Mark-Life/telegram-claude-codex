import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { writeJsonAtomic } from "../atomic-write";
import type { ProviderId } from "./types";

const STORE_VERSION = 1 as const;

/** Durable session store, provider-namespaced so claude/codex ids never collide. */
const SESSIONS_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  ".data",
  "sessions.json"
);

interface SessionRecord {
  sessionId: string;
}

interface StoreFile {
  sessions: Record<string, Partial<Record<ProviderId, SessionRecord>>>;
  version: number;
}

/** Legacy session shape imported once from state.json. */
export type LegacySessions = Record<ProviderId, Map<string, string>>;

const emptyStore = (): StoreFile => ({ version: STORE_VERSION, sessions: {} });

/**
 * Bring a store of an unrecognized version up to STORE_VERSION. v1 is the first
 * shape, so a well-formed `sessions` map is kept as-is and anything else starts
 * empty rather than risk reading a bad structure.
 */
const migrate = (parsed: unknown): StoreFile => {
  if (parsed && typeof parsed === "object" && "sessions" in parsed) {
    const { sessions } = parsed as StoreFile;
    if (sessions && typeof sessions === "object") {
      return { version: STORE_VERSION, sessions };
    }
  }
  return emptyStore();
};

/**
 * Session ops bound to a concrete store path. Reads fail open (any missing /
 * parse / shape error yields an empty store, never throws); writes are atomic
 * via unique-tmp + rename. The path is a parameter so tests can point at a temp
 * file instead of the real `.data/sessions.json`.
 */
export const makeSessionOps = (path: string) => {
  const readStore = (): StoreFile => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      // migrate validates the sessions shape and is idempotent for a well-formed
      // v1 store, so routing every parse through it keeps the fail-open guarantee
      // even for a version-matched file with a missing/null sessions map.
      return migrate(parsed);
    } catch {
      return emptyStore();
    }
  };

  const writeStore = (store: StoreFile) => {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, store);
  };

  const get = (project: string, provider: ProviderId) =>
    readStore().sessions[project]?.[provider]?.sessionId;

  const set = (project: string, provider: ProviderId, sessionId: string) => {
    const store = readStore();
    const forProject = store.sessions[project] ?? {};
    forProject[provider] = { sessionId };
    store.sessions[project] = forProject;
    writeStore(store);
  };

  const clear = (project: string, provider: ProviderId) => {
    const store = readStore();
    const forProject = store.sessions[project];
    if (forProject?.[provider]) {
      delete forProject[provider];
      writeStore(store);
    }
  };

  const count = (provider: ProviderId) =>
    Object.values(readStore().sessions).filter((p) => p[provider]?.sessionId)
      .length;

  /**
   * One-time import of session ids previously stored inline in state.json.
   * No-op once the store holds any project, so it is safe to run every boot.
   */
  const importLegacy = (legacy: LegacySessions) => {
    const store = readStore();
    if (Object.keys(store.sessions).length > 0) {
      return;
    }
    let imported = false;
    for (const provider of Object.keys(legacy) as ProviderId[]) {
      for (const [project, sessionId] of legacy[provider]) {
        const forProject = store.sessions[project] ?? {};
        forProject[provider] = { sessionId };
        store.sessions[project] = forProject;
        imported = true;
      }
    }
    if (imported) {
      writeStore(store);
    }
  };

  return { get, set, clear, count, importLegacy } as const;
};

const defaultOps = makeSessionOps(SESSIONS_FILE);

/** Boot-time migration entry point for the real store (see makeSessionOps.importLegacy). */
export const importLegacySessions = defaultOps.importLegacy;

const make = Effect.sync(() => ({
  get: (project: string, provider: ProviderId) =>
    Effect.sync(() => defaultOps.get(project, provider)),
  set: (args: { project: string; provider: ProviderId; sessionId: string }) =>
    Effect.sync(() =>
      defaultOps.set(args.project, args.provider, args.sessionId)
    ),
  clear: (project: string, provider: ProviderId) =>
    Effect.sync(() => defaultOps.clear(project, provider)),
  count: (provider: ProviderId) =>
    Effect.sync(() => defaultOps.count(provider)),
}));

/**
 * SessionStore: durable, provider-namespaced session-id persistence backed by
 * `.data/sessions.json` with atomic writes and fail-open reads. The bot reaches
 * it through the ManagedRuntime bridge (accessors below); the runner taps it on
 * the normalized event stream so a session id is recorded as soon as it exists.
 */
export class SessionStore extends Context.Service<
  SessionStore,
  Effect.Success<typeof make>
>()("@tg/SessionStore") {
  static readonly layer = Layer.effect(SessionStore, make);
}

/** Effect accessors — bridged to Promise-land in bot.ts / agent/index.ts. */
export const getSession = (project: string, provider: ProviderId) =>
  Effect.flatMap(SessionStore, (s) => s.get(project, provider));
export const setSession = (args: {
  project: string;
  provider: ProviderId;
  sessionId: string;
}) => Effect.flatMap(SessionStore, (s) => s.set(args));
export const clearSession = (project: string, provider: ProviderId) =>
  Effect.flatMap(SessionStore, (s) => s.clear(project, provider));
export const countSessions = (provider: ProviderId) =>
  Effect.flatMap(SessionStore, (s) => s.count(provider));
