/** One shipped `user_version` migration, as the sync runner applied it. */
export interface LegacyMigration {
  /** Statements applied in order, inside one transaction. */
  readonly statements: readonly string[];
  /** Monotonic version written to the `user_version` pragma once applied. */
  readonly version: number;
}

/**
 * The schema history up to version 11, from the `user_version` era. Frozen:
 * every database in the field already ran it, so an entry is never edited,
 * reordered or deleted. The Effect SQL migrator wraps each entry unchanged as
 * migration `<version>_legacy_v<version>` (`./index.ts`); a new schema change is
 * a new id ≥ 12 there, never an entry here.
 */
export const LEGACY_MIGRATIONS: readonly LegacyMigration[] = [
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS compose (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        thread_id INTEGER,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS compose_buffer_idx
        ON compose (user_id, thread_id, seq)`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
    version: 1,
  },
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS threads (
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        project_path TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, thread_id)
      )`,
    ],
    version: 2,
  },
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        tier TEXT NOT NULL,
        username TEXT,
        added_by INTEGER NOT NULL,
        added_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS groups (
        chat_id INTEGER PRIMARY KEY,
        owner_present INTEGER NOT NULL,
        checked_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS run_quota (
        user_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        used INTEGER NOT NULL,
        PRIMARY KEY (user_id, day)
      )`,
    ],
    version: 3,
  },
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        cron TEXT NOT NULL,
        tz TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        project TEXT,
        enabled INTEGER NOT NULL,
        raw INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_status TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tasks_enabled_idx ON tasks (enabled)`,
    ],
    version: 4,
  },
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS group_messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      )`,
      `CREATE INDEX IF NOT EXISTS group_messages_chat_created_idx
        ON group_messages (chat_id, created_at DESC, message_id DESC)`,
      `CREATE TABLE IF NOT EXISTS group_fact_sheets (
        chat_id INTEGER PRIMARY KEY,
        chat_title TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
    version: 5,
  },
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        due_at INTEGER,
        timezone TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        notified_at INTEGER,
        claim_until INTEGER,
        chat_id INTEGER,
        thread_id INTEGER,
        message_id INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS reminders_due_idx
        ON reminders (notified_at, due_at, claim_until)`,
      `CREATE INDEX IF NOT EXISTS reminders_thread_idx
        ON reminders (chat_id, thread_id)`,
      `CREATE INDEX IF NOT EXISTS reminders_message_idx
        ON reminders (chat_id, message_id)`,
    ],
    version: 6,
  },
  {
    statements: [
      `ALTER TABLE group_messages ADD COLUMN thread_id INTEGER`,
      `ALTER TABLE group_messages ADD COLUMN sender_id INTEGER`,
      `ALTER TABLE group_messages ADD COLUMN sender_username TEXT`,
      `ALTER TABLE group_messages ADD COLUMN sent_at INTEGER`,
      `ALTER TABLE group_messages ADD COLUMN reply_to_message_id INTEGER`,
      `ALTER TABLE group_messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'text'`,
      `UPDATE group_messages SET sent_at = created_at WHERE sent_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS group_messages_chat_sent_idx
        ON group_messages (chat_id, sent_at DESC, message_id DESC)`,
      `CREATE TABLE IF NOT EXISTS group_chats (
        chat_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        username TEXT,
        is_forum INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )`,
      `INSERT OR IGNORE INTO group_chats
        (chat_id, title, chat_type, username, is_forum, first_seen_at, last_seen_at)
       SELECT chat_id, chat_title, 'group', NULL, 0, updated_at, updated_at
       FROM group_fact_sheets`,
      `CREATE INDEX IF NOT EXISTS group_chats_title_idx ON group_chats (title)`,
      `CREATE TABLE IF NOT EXISTS group_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_message_id INTEGER,
        created_by_user_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (chat_id) REFERENCES group_chats(chat_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS group_facts_chat_updated_idx
        ON group_facts (chat_id, updated_at DESC, id DESC)`,
      `INSERT INTO group_facts
       (chat_id, kind, content, source_message_id, created_by_user_id, created_at, updated_at)
       SELECT chat_id, 'legacy_fact_sheet', content, NULL, NULL, updated_at, updated_at
       FROM group_fact_sheets AS sheets
       WHERE trim(content) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM group_facts AS facts
           WHERE facts.chat_id = sheets.chat_id
             AND facts.kind = 'legacy_fact_sheet'
             AND facts.content = sheets.content
         )`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS group_messages_fts USING fts5(
        text,
        sender_name,
        content='group_messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      )`,
      `INSERT INTO group_messages_fts(group_messages_fts) VALUES ('rebuild')`,
      `CREATE TRIGGER IF NOT EXISTS group_messages_fts_insert AFTER INSERT ON group_messages BEGIN
        INSERT INTO group_messages_fts(rowid, text, sender_name)
        VALUES (new.rowid, new.text, new.sender_name);
      END`,
      `CREATE TRIGGER IF NOT EXISTS group_messages_fts_delete AFTER DELETE ON group_messages BEGIN
        INSERT INTO group_messages_fts(group_messages_fts, rowid, text, sender_name)
        VALUES ('delete', old.rowid, old.text, old.sender_name);
      END`,
      `CREATE TRIGGER IF NOT EXISTS group_messages_fts_update AFTER UPDATE ON group_messages BEGIN
        INSERT INTO group_messages_fts(group_messages_fts, rowid, text, sender_name)
        VALUES ('delete', old.rowid, old.text, old.sender_name);
        INSERT INTO group_messages_fts(rowid, text, sender_name)
        VALUES (new.rowid, new.text, new.sender_name);
      END`,
    ],
    version: 7,
  },
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS business_chats (
        business_connection_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        peer_id INTEGER,
        title TEXT NOT NULL,
        username TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (business_connection_id, chat_id)
      )`,
      `CREATE INDEX IF NOT EXISTS business_chats_title_idx
        ON business_chats (title)`,
      `CREATE INDEX IF NOT EXISTS business_chats_last_seen_idx
        ON business_chats (last_seen_at DESC)`,
      `CREATE TABLE IF NOT EXISTS business_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_connection_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        sender_role TEXT NOT NULL,
        sender_id INTEGER,
        sender_name TEXT NOT NULL,
        sender_username TEXT,
        text TEXT NOT NULL DEFAULT '',
        message_kind TEXT NOT NULL,
        reply_to_message_id INTEGER,
        sent_at INTEGER NOT NULL,
        edited_at INTEGER,
        ingested_at INTEGER NOT NULL,
        media_file_id TEXT,
        voice_file_id TEXT,
        voice_data BLOB,
        transcript TEXT,
        transcript_status TEXT NOT NULL DEFAULT 'none',
        UNIQUE (business_connection_id, chat_id, message_id),
        FOREIGN KEY (business_connection_id, chat_id)
          REFERENCES business_chats(business_connection_id, chat_id)
          ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS business_messages_chat_sent_idx
        ON business_messages
          (business_connection_id, chat_id, sent_at DESC, message_id DESC)`,
      `CREATE INDEX IF NOT EXISTS business_messages_sent_idx
        ON business_messages (sent_at)`,
      `CREATE INDEX IF NOT EXISTS business_messages_transcript_idx
        ON business_messages (transcript_status)
        WHERE voice_file_id IS NOT NULL`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS business_messages_fts USING fts5(
        text,
        transcript,
        sender_name,
        content='business_messages',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      )`,
      `INSERT INTO business_messages_fts(business_messages_fts) VALUES ('rebuild')`,
      `CREATE TRIGGER IF NOT EXISTS business_messages_fts_insert
       AFTER INSERT ON business_messages BEGIN
        INSERT INTO business_messages_fts(rowid, text, transcript, sender_name)
        VALUES (new.id, new.text, new.transcript, new.sender_name);
      END`,
      `CREATE TRIGGER IF NOT EXISTS business_messages_fts_delete
       AFTER DELETE ON business_messages BEGIN
        INSERT INTO business_messages_fts(
          business_messages_fts, rowid, text, transcript, sender_name
        ) VALUES (
          'delete', old.id, old.text, old.transcript, old.sender_name
        );
      END`,
      `CREATE TRIGGER IF NOT EXISTS business_messages_fts_update
       AFTER UPDATE ON business_messages BEGIN
        INSERT INTO business_messages_fts(
          business_messages_fts, rowid, text, transcript, sender_name
        ) VALUES (
          'delete', old.id, old.text, old.transcript, old.sender_name
        );
        INSERT INTO business_messages_fts(rowid, text, transcript, sender_name)
        VALUES (new.id, new.text, new.transcript, new.sender_name);
      END`,
    ],
    version: 8,
  },
  {
    statements: [
      `ALTER TABLE tasks ADD COLUMN chat_id INTEGER`,
      `ALTER TABLE tasks ADD COLUMN thread_id INTEGER`,
    ],
    version: 9,
  },
  {
    statements: [
      `ALTER TABLE reminders ADD COLUMN acknowledged_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS reminders_repeat_idx
        ON reminders (acknowledged_at, notified_at, due_at, claim_until)`,
    ],
    version: 10,
  },
  {
    // The model router decides once and the decision is stored: a topic keeps
    // its pick beside the session it belongs to, a task beside the payload it
    // was routed from. NULL means "not routed yet", which is what a new topic,
    // a /new and an edited payload all leave behind.
    statements: [
      `ALTER TABLE threads ADD COLUMN model TEXT`,
      `ALTER TABLE threads ADD COLUMN effort TEXT`,
      `ALTER TABLE tasks ADD COLUMN model TEXT`,
      `ALTER TABLE tasks ADD COLUMN effort TEXT`,
    ],
    version: 11,
  },
];

/**
 * The `user_version` every database rests at from now on: the last legacy
 * step still writes it, and migrations ≥ 12 never touch it, so a rollback to
 * a pre-cutover build finds the schema it expects.
 */
export const LEGACY_USER_VERSION = 11;
