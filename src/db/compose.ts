import type { Database } from "bun:sqlite";

export const COMPOSE_TYPES = [
  "text",
  "voice",
  "forwarded",
  "file",
  "photo",
] as const;

export type ComposeType = (typeof COMPOSE_TYPES)[number];

/** One buffered compose entry as handlers see it. */
export interface ComposeMessage {
  content: string;
  type: ComposeType;
}

/**
 * Identifies one compose buffer. `chatId` is required because every route with
 * no topic — the private chat, a plain group, the forum's General topic — has a
 * null `threadId`, so without the chat they would all share one buffer.
 * `threadId` is the forum topic a message came from; absent/null is stored as
 * SQL NULL.
 */
export interface ComposeKey {
  chatId: number;
  threadId?: number | null;
  userId: number;
}

// The index signatures are what bun:sqlite's binding constraint checks against.
interface Binds {
  $chatId: number;
  $threadId: number | null;
  $userId: number;
  [param: string]: number | null;
}

interface InsertBinds {
  $chatId: number;
  $content: string;
  $createdAt: number;
  $threadId: number | null;
  $type: ComposeType;
  $userId: number;
  [param: string]: string | number | null;
}

const bindsOf = (key: ComposeKey): Binds => ({
  $chatId: key.chatId,
  $threadId: key.threadId ?? null,
  $userId: key.userId,
});

// `IS` rather than `=` so the plain-chat buffer (thread_id NULL) matches.
const SCOPE =
  "chat_id = $chatId AND user_id = $userId AND thread_id IS $threadId";

/**
 * Compose-buffer ops bound to a db handle. Entries are appended on arrival and
 * removed only by an explicit clear (/send, /cancel, /stop, /new, project
 * switch), so a draft survives restarts and never expires on a timer.
 */
export const makeComposeOps = (db: Database) => {
  const insert = db.query<undefined, InsertBinds>(
    `INSERT INTO compose (chat_id, user_id, thread_id, seq, type, content, created_at)
     VALUES (
       $chatId,
       $userId,
       $threadId,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM compose WHERE ${SCOPE}),
       $type,
       $content,
       $createdAt
     )`
  );
  const selectAll = db.query<ComposeMessage, Binds>(
    `SELECT content, type FROM compose WHERE ${SCOPE} ORDER BY seq`
  );
  const selectCount = db.query<{ n: number }, Binds>(
    `SELECT COUNT(*) AS n FROM compose WHERE ${SCOPE}`
  );
  const remove = db.query<undefined, Binds>(
    `DELETE FROM compose WHERE ${SCOPE}`
  );

  /** Append one message to the buffer; `seq` continues from the last entry. */
  const append = (entry: ComposeKey & ComposeMessage) => {
    insert.run({
      ...bindsOf(entry),
      $content: entry.content,
      $createdAt: Date.now(),
      $type: entry.type,
    });
  };

  /** Buffered messages in arrival order (empty when nothing is composing). */
  const list = (key: ComposeKey) => selectAll.all(bindsOf(key));

  /** How many messages the buffer holds. */
  const count = (key: ComposeKey) => selectCount.get(bindsOf(key))?.n ?? 0;

  /** Drop the whole buffer; returns how many messages were discarded. */
  const clear = (key: ComposeKey) => {
    const discarded = count(key);
    remove.run(bindsOf(key));
    return discarded;
  };

  return { append, clear, count, list } as const;
};
