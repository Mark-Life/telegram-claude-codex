import { Context, Effect, Layer } from "effect";
import {
  clearStoredSession,
  countStoredSessions,
  getStoredSession,
  setStoredSession,
} from "../db";
import type { ProviderId } from "./types";

const make = Effect.sync(() => ({
  get: (project: string, provider: ProviderId) =>
    Effect.sync(() => getStoredSession(project, provider)),
  set: (args: { project: string; provider: ProviderId; sessionId: string }) =>
    Effect.sync(() => setStoredSession(args)),
  clear: (project: string, provider: ProviderId) =>
    Effect.sync(() => clearStoredSession(project, provider)),
  count: (provider: ProviderId) =>
    Effect.sync(() => countStoredSessions(provider)),
}));

/**
 * SessionStore: durable, provider-namespaced session-id persistence for the chat
 * outside any forum topic, backed by the bot database (a topic keeps its id on
 * its own thread row instead). The bot reaches it through the ManagedRuntime
 * bridge (accessors below); agent/index.ts taps it on the normalized event
 * stream so a session id is recorded as soon as it exists.
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
