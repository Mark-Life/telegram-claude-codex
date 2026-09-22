import type { Database } from "bun:sqlite";
import type { ProviderId } from "../agent/types";
import { isProviderId } from "./provider-id";

/** Identifies one forum topic: the supergroup plus the topic's message thread. */
export interface ThreadKey {
  chatId: number;
  threadId: number;
}

/** What a topic pins: the project it works on and the session it continues. */
export interface ThreadRecord {
  projectPath: string;
  provider: ProviderId;
  sessionId?: string;
  updatedAt: number;
}

/** One stored topic, as `list` hands it back. */
export type ThreadEntry = ThreadKey & ThreadRecord;

interface KeyBinds {
  $chatId: number;
  $threadId: number;
  [param: string]: number;
}

interface PinBinds {
  $chatId: number;
  $projectPath: string;
  $provider: ProviderId;
  $threadId: number;
  $updatedAt: number;
  [param: string]: string | number;
}

interface SessionBinds {
  $chatId: number;
  $sessionId: string;
  $threadId: number;
  $updatedAt: number;
  [param: string]: string | number;
}

interface ThreadRow {
  chat_id: number;
  project_path: string;
  provider: string;
  session_id: string | null;
  thread_id: number;
  updated_at: number;
}

/**
 * A row whose provider is no longer in the build carries a session id nothing
 * can resume, so it reads as absent and the topic starts fresh.
 */
const toEntry = (row: ThreadRow): ThreadEntry | undefined => {
  if (!isProviderId(row.provider)) {
    return undefined;
  }
  return {
    chatId: row.chat_id,
    projectPath: row.project_path,
    provider: row.provider,
    sessionId: row.session_id ?? undefined,
    threadId: row.thread_id,
    updatedAt: row.updated_at,
  };
};

const keyBinds = (key: ThreadKey): KeyBinds => ({
  $chatId: key.chatId,
  $threadId: key.threadId,
});

const COLUMNS =
  "chat_id, thread_id, project_path, provider, session_id, updated_at";
const KEY_SCOPE = "chat_id = $chatId AND thread_id = $threadId";

/**
 * Per-topic ops bound to a db handle. A topic owns its conversation: the row
 * says which project it works on and which session to resume, so two topics of
 * the same chat never share state. Everything outside a topic (private chat,
 * plain group, the General topic) keeps the per-project session store instead.
 */
export const makeThreadOps = (db: Database) => {
  const selectOne = db.query<ThreadRow, KeyBinds>(
    `SELECT ${COLUMNS} FROM threads WHERE ${KEY_SCOPE}`
  );
  const selectByChat = db.query<ThreadRow, { $chatId: number }>(
    `SELECT ${COLUMNS} FROM threads WHERE chat_id = $chatId ORDER BY updated_at DESC`
  );
  // The session survives only while the topic keeps working on the same project
  // with the same provider: a switch makes the stored id unresumable.
  const upsert = db.query<undefined, PinBinds>(
    `INSERT INTO threads (${COLUMNS})
     VALUES ($chatId, $threadId, $projectPath, $provider, NULL, $updatedAt)
     ON CONFLICT(chat_id, thread_id) DO UPDATE SET
       project_path = excluded.project_path,
       provider = excluded.provider,
       session_id = CASE
         WHEN threads.project_path = excluded.project_path
           AND threads.provider = excluded.provider
         THEN threads.session_id
         ELSE NULL
       END,
       updated_at = excluded.updated_at`
  );
  const updateSession = db.query<undefined, SessionBinds>(
    `UPDATE threads SET session_id = $sessionId, updated_at = $updatedAt
     WHERE ${KEY_SCOPE}`
  );
  const dropSession = db.query<undefined, KeyBinds>(
    `UPDATE threads SET session_id = NULL WHERE ${KEY_SCOPE}`
  );
  const remove = db.query<undefined, KeyBinds>(
    `DELETE FROM threads WHERE ${KEY_SCOPE}`
  );

  /** The topic's row, or undefined when it was never used. */
  const get = (key: ThreadKey) => {
    const row = selectOne.get(keyBinds(key));
    return row ? toEntry(row) : undefined;
  };

  /**
   * Pin a topic to a project and provider, creating the row on first use.
   * Returns the row as it now stands, so a caller sees at once whether the
   * pinned session survived the pin.
   */
  const pin = (
    entry: ThreadKey & Pick<ThreadRecord, "projectPath" | "provider">
  ) => {
    upsert.run({
      $chatId: entry.chatId,
      $projectPath: entry.projectPath,
      $provider: entry.provider,
      $threadId: entry.threadId,
      $updatedAt: Date.now(),
    });
    return get(entry);
  };

  /** Record the session a topic continues on; false when the topic has no row. */
  const setSession = (entry: ThreadKey & { sessionId: string }) =>
    updateSession.run({
      $chatId: entry.chatId,
      $sessionId: entry.sessionId,
      $threadId: entry.threadId,
      $updatedAt: Date.now(),
    }).changes > 0;

  /** Forget the topic's session but keep its project pin (`/new`). */
  const clearSession = (key: ThreadKey) => {
    dropSession.run(keyBinds(key));
  };

  /** Every topic of a chat, most recently used first. */
  const list = (chatId: number) =>
    selectByChat
      .all({ $chatId: chatId })
      .map(toEntry)
      .filter((entry) => entry !== undefined);

  /** Drop a topic entirely (the user deleted it). */
  const drop = (key: ThreadKey) => {
    remove.run(keyBinds(key));
  };

  return { clearSession, drop, get, list, pin, setSession } as const;
};
