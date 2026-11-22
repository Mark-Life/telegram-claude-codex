import { listProviders } from "@workspace/agent/registry";
import { AUTO_MODEL, DEFAULT_MODEL } from "@workspace/agent/types";
import type { AgentProvider } from "@workspace/agent/types";
import {
  historyTitle,
  SessionHistoryRepo,
  SettingsRepo,
  TasksRepo,
} from "@workspace/db";
import type { SessionHistoryEntry } from "@workspace/db";
import { Effect, Option } from "effect";

import { logPersistenceError } from "./db/bridge";
import type { RouteState, RunDir } from "./handlers/session-routing";

/**
 * The bot's side of `session_history`: every remembered run records the
 * session it is on, and at boot each provider's own past sessions are
 * imported once, so `/history` is a plain read of the table.
 */

/** Where the host's own words begin in a prompt it wrapped in context. */
const CURRENT_REQUEST = "[Current request]\n";

/** A `[Name] … [/Name]` context block: a quoted reply, an attachment. */
const CONTEXT_BLOCK = /\[(?<tag>[^\]\n/][^\]\n]*)\][\s\S]*?\[\/\k<tag>\]/gu;

/**
 * What the user wrote, out of the prompt the bot built around it: the part
 * after the last `[Current request]` (reminders and group memory come before
 * it), with quoted replies and attachment blocks dropped.
 */
export const ownWords = (prompt: string) => {
  const at = prompt.lastIndexOf(CURRENT_REQUEST);
  const request =
    at === -1 ? prompt : prompt.slice(at + CURRENT_REQUEST.length);
  return request.replaceAll(CONTEXT_BLOCK, " ").trim();
};

/** A model the run named, or none for the router's "default" and "auto". */
export const namedModel = (model: string | undefined) =>
  model === DEFAULT_MODEL || model === AUTO_MODEL ? undefined : model;

/**
 * Record that a remembered run is on `sessionId`: a new session gets its row
 * and title, a resumed one a later time, the model and effort it runs on now.
 * Never fails: a lost row costs one line in `/history`, a failed run would
 * cost the answer.
 */
export const recordRunSession = (input: {
  effort: string | undefined;
  model: string | undefined;
  runDir: RunDir;
  runState: RouteState;
  sessionId: string;
  /** What the user wrote to start the run; only a new row keeps it. */
  text: string;
}) =>
  SessionHistoryRepo.use((repo) =>
    repo.record({
      chatId: input.runState.chatId,
      effort: input.effort,
      model: namedModel(input.model),
      projectPath: input.runDir.projectPath,
      provider: input.runState.activeProvider,
      sessionId: input.sessionId,
      threadId: input.runState.threadId ?? undefined,
      title: historyTitle(ownWords(input.text)),
      userId: input.runState.userId,
    })
  ).pipe(
    Effect.catchTag("PersistenceError", logPersistenceError),
    Effect.catchDefect((defect) =>
      Effect.logWarning("session history not recorded", defect)
    )
  );

/** How many sessions each provider's import reads, newest first. */
const IMPORT_LIMIT = 200;

/** The `history_imported` list: providers already imported. */
const importedProviders = SettingsRepo.use((repo) =>
  repo.get("history_imported")
).pipe(
  Effect.map((value) =>
    Option.getOrElse(value, () => "")
      .split(",")
      .filter((id) => id.length > 0)
  )
);

/**
 * The requests task fires start with: a fire runs on a main profile, so its
 * rollout looks like a chat run's and is told apart by its payload. A task
 * deleted before the import leaves its fires indistinguishable.
 */
const taskPayloads = TasksRepo.use((repo) => repo.list()).pipe(
  Effect.map(
    (tasks) =>
      new Set(
        tasks
          .filter((task) => task.type === "prompt")
          .map((task) => task.payload.trim())
      )
  )
);

/**
 * One provider's past sessions as rows, task fires dropped; none when the
 * provider's files cannot be read yet.
 */
const pastRows = (provider: AgentProvider, fires: ReadonlySet<string>) =>
  Effect.tryPromise(
    async () => await provider.pastSessions?.(IMPORT_LIMIT)
  ).pipe(
    Effect.map((sessions) =>
      sessions === undefined
        ? Option.none()
        : Option.some(
            sessions
              .filter((session) => !fires.has(session.request.trim()))
              .map((session): SessionHistoryEntry => ({
                lastActiveAt: session.lastActiveAt,
                projectPath: session.projectPath,
                provider: provider.id,
                sessionId: session.sessionId,
                startedAt: session.startedAt,
                title: historyTitle(ownWords(session.request)),
              }))
          )
    )
  );

/**
 * Import one provider's past sessions and mark it done in `done`. Its files
 * not readable yet (no login so far, a permission error) leave it unmarked,
 * so the next boot tries again.
 */
const importOne = (
  provider: AgentProvider,
  fires: ReadonlySet<string>,
  done: string[]
) =>
  Effect.gen(function* importProviderSessions() {
    const rows = yield* pastRows(provider, fires);
    if (Option.isNone(rows)) {
      yield* Effect.log("session_history.import_deferred").pipe(
        Effect.annotateLogs({ provider: provider.id })
      );
      return;
    }
    yield* SessionHistoryRepo.use((repo) => repo.importPast(rows.value));
    done.push(provider.id);
    yield* SettingsRepo.use((repo) =>
      repo.set({ key: "history_imported", value: done.join(",") })
    );
    yield* Effect.log("session_history.imported").pipe(
      Effect.annotateLogs({
        provider: provider.id,
        sessions: rows.value.length,
      })
    );
  }).pipe(
    Effect.catchTag("PersistenceError", logPersistenceError),
    Effect.catchCause((cause) =>
      Effect.logWarning("past sessions not imported", cause).pipe(
        Effect.annotateLogs({ provider: provider.id })
      )
    )
  );

/**
 * Import the sessions each provider kept before the bot recorded history,
 * once per provider (`history_imported`), so conversations from before this
 * table still show in `/history`. A session already recorded is left as it
 * is. Runs in the background after boot; a provider that fails or cannot be
 * read yet is tried again at the next boot.
 */
export const importPastSessions = Effect.gen(function* importPastSessions() {
  const done = yield* importedProviders;
  const pending = listProviders().filter(
    (provider) =>
      provider.pastSessions !== undefined && !done.includes(provider.id)
  );
  if (pending.length === 0) {
    return;
  }
  const fires = yield* taskPayloads;
  for (const provider of pending) {
    yield* importOne(provider, fires, done);
  }
}).pipe(
  Effect.catchTag("PersistenceError", logPersistenceError),
  Effect.catchCause((cause) =>
    Effect.logWarning("past sessions not imported", cause)
  ),
  Effect.withSpan("SessionHistory.import")
);
