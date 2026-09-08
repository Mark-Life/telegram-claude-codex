import type { Database } from "bun:sqlite";
import type { ProviderId } from "../agent/types";

interface KeyBinds {
  $projectPath: string;
  $provider: ProviderId;
  [param: string]: string;
}

interface UpsertBinds {
  $projectPath: string;
  $provider: ProviderId;
  $sessionId: string;
  $updatedAt: number;
  [param: string]: string | number;
}

const keyBinds = (project: string, provider: ProviderId): KeyBinds => ({
  $projectPath: project,
  $provider: provider,
});

const KEY_SCOPE = "project_path = $projectPath AND provider = $provider";

/**
 * Per-project session ops bound to a db handle. Provider-namespaced so a
 * claude and a codex id for the same project never collide. This is the store
 * used everywhere outside a forum topic; topics keep their own id on the thread
 * row instead.
 */
export const makeSessionOps = (db: Database) => {
  const select = db.query<{ session_id: string }, KeyBinds>(
    `SELECT session_id FROM sessions WHERE ${KEY_SCOPE}`
  );
  const upsert = db.query<undefined, UpsertBinds>(
    `INSERT INTO sessions (project_path, provider, session_id, updated_at)
     VALUES ($projectPath, $provider, $sessionId, $updatedAt)
     ON CONFLICT(project_path, provider) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at = excluded.updated_at`
  );
  const remove = db.query<undefined, KeyBinds>(
    `DELETE FROM sessions WHERE ${KEY_SCOPE}`
  );
  const selectCount = db.query<{ n: number }, { $provider: ProviderId }>(
    "SELECT COUNT(*) AS n FROM sessions WHERE provider = $provider"
  );

  /** The session id to resume for a project, or undefined when there is none. */
  const get = (project: string, provider: ProviderId) =>
    select.get(keyBinds(project, provider))?.session_id;

  /** Record the session a project continues on, replacing any earlier id. */
  const set = (entry: {
    project: string;
    provider: ProviderId;
    sessionId: string;
  }) => {
    upsert.run({
      $projectPath: entry.project,
      $provider: entry.provider,
      $sessionId: entry.sessionId,
      $updatedAt: Date.now(),
    });
  };

  /** Forget a project's session so the next prompt starts fresh (`/new`). */
  const clear = (project: string, provider: ProviderId) => {
    remove.run(keyBinds(project, provider));
  };

  /** How many projects hold a session for this provider. */
  const count = (provider: ProviderId) =>
    selectCount.get({ $provider: provider })?.n ?? 0;

  return { clear, count, get, set } as const;
};
