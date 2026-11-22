import { readFileSync, readdirSync, statSync } from "node:fs";
import { open, readdir, stat as statAsync } from "node:fs/promises";
import path from "node:path";

import { Option, Schema } from "effect";

import { COMPACT_SEED_OPENER } from "./codex-thread";
import { splitRunPrompt } from "./run-prompt";
import { codexHome } from "./state-roots";
import type { PastSession } from "./types";

/**
 * The rollout lines a session's head is read from, decoded straight from
 * their raw JSONL text: a malformed or off-shape line yields Option.none, so
 * no field is ever read off an `any`.
 *
 * - `session_meta`: the session id, its working directory and start.
 * - `event_msg` `user_message`: the prompt, as older Codex CLIs wrote it.
 * - `response_item` `message` with `role: "user"`: the prompt as current CLIs
 *   write it, beside the blocks Codex adds on its own.
 */
const decodeHeadLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        payload: Schema.Struct({
          cwd: Schema.optional(Schema.String),
          id: Schema.optional(Schema.String),
          timestamp: Schema.optional(Schema.String),
        }),
        timestamp: Schema.optional(Schema.String),
        type: Schema.Literal("session_meta"),
      }),
      Schema.Struct({
        payload: Schema.Struct({
          message: Schema.String,
          type: Schema.Literal("user_message"),
        }),
        type: Schema.Literal("event_msg"),
      }),
      Schema.Struct({
        payload: Schema.Struct({
          content: Schema.Array(
            Schema.Struct({
              text: Schema.optional(Schema.String),
              type: Schema.String,
            })
          ),
          role: Schema.Literal("user"),
          type: Schema.Literal("message"),
        }),
        type: Schema.Literal("response_item"),
      }),
    ])
  )
);

/**
 * The rollout line carrying token usage. `last_token_usage` is the input size
 * of one turn; `total_token_usage` on the same line accumulates over the whole
 * session, which is not a context size.
 */
const decodeTokenCount = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      payload: Schema.Struct({
        info: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              last_token_usage: Schema.Struct({
                input_tokens: Schema.Number,
              }),
            })
          )
        ),
        type: Schema.Literal("token_count"),
      }),
      type: Schema.Literal("event_msg"),
    })
  )
);

/**
 * The thread's running token total on a rollout's `token_count` line: what
 * Codex restores on a resume and replays as `thread/tokenUsage/updated`.
 */
const decodeTokenTotal = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      payload: Schema.Struct({
        info: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              total_token_usage: Schema.Struct({
                input_tokens: Schema.Number,
                output_tokens: Schema.Number,
              }),
            })
          )
        ),
        type: Schema.Literal("token_count"),
      }),
      type: Schema.Literal("event_msg"),
    })
  )
);

/** `$CODEX_HOME/sessions`, where Codex writes a rollout per session. */
const codexSessionsDir = () => path.join(codexHome(), "sessions");
const MAX_HEAD_LINES = 60;
/**
 * The head is read in two steps: most sessions name their prompt within the
 * first, and a session whose `session_meta` and Codex's own blocks are long
 * gets the second.
 */
const FIRST_HEAD_BYTES = 131_072;
const FULL_HEAD_BYTES = 524_288;
/**
 * How many rollout files are read per session wanted: helper turns (judge,
 * format, titles) and other Codex clients leave rollouts too and are skipped.
 */
const ROLLOUT_SCAN_FACTOR = 5;

/**
 * A text part Codex adds to a user message on its own: an XML-style block
 * (`<environment_context>`, `<user_instructions>`, ...) or the workspace's
 * AGENTS.md.
 */
const INJECTED_PART = /^(?:<[a-z_]+>|# AGENTS\.md instructions)/u;

/** The first `maxBytes` of a file, cut back to whole lines; empty on error. */
const readHead = async (filePath: string, maxBytes: number) => {
  try {
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf-8");
      const whole =
        bytesRead < maxBytes ? text : text.slice(0, text.lastIndexOf("\n"));
      return whole.split("\n").slice(0, MAX_HEAD_LINES).filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
};

/** The prompt text of a user message, Codex's own blocks dropped. */
const promptOf = (
  content: readonly { text?: string | undefined; type: string }[]
) =>
  content
    .flatMap((part) => {
      if (part.type !== "input_text") {
        return [];
      }
      const text = (part.text ?? "").trim();
      return text.length > 0 && !INJECTED_PART.test(text) ? [text] : [];
    })
    .join("\n\n");

/** What a rollout's head says: its id, directory, start and first prompt. */
const scanHead = (lines: readonly string[]) => {
  let sessionId = "";
  let projectPath = "";
  let startedAt = "";
  let prompt = "";
  for (const line of lines) {
    const decoded = decodeHeadLine(line);
    if (Option.isNone(decoded)) {
      continue;
    }
    const record = decoded.value;
    if (record.type === "session_meta") {
      sessionId = record.payload.id ?? sessionId;
      projectPath = record.payload.cwd ?? projectPath;
      startedAt = record.payload.timestamp ?? record.timestamp ?? startedAt;
    } else if (prompt.length === 0) {
      prompt =
        record.type === "event_msg"
          ? record.payload.message.trim()
          : promptOf(record.payload.content);
    }
    if (sessionId.length > 0 && prompt.length > 0) {
      break;
    }
  }
  return { projectPath, prompt, sessionId, startedAt };
};

/**
 * One rollout as a past session, or null when it is not a conversation a main
 * bot run started: no id, no prompt, a first prompt without the blocks
 * `buildRunPrompt` gives a main run (a group's light run, a helper turn), or
 * the turn that seeds a compacted session.
 */
const parseRollout = async (
  filePath: string,
  mtimeMs: number
): Promise<PastSession | null> => {
  let head = scanHead(await readHead(filePath, FIRST_HEAD_BYTES));
  if (head.prompt.length === 0) {
    head = scanHead(await readHead(filePath, FULL_HEAD_BYTES));
  }
  if (head.sessionId.length === 0 || head.prompt.length === 0) {
    return null;
  }
  const { fromMainRun, request } = splitRunPrompt(head.prompt);
  if (!fromMainRun || request.startsWith(COMPACT_SEED_OPENER)) {
    return null;
  }
  const started = Date.parse(head.startedAt);
  return {
    lastActiveAt: Math.trunc(mtimeMs),
    projectPath: head.projectPath,
    request,
    sessionId: head.sessionId,
    startedAt: Number.isNaN(started) ? Math.trunc(mtimeMs) : started,
  };
};

/** Every rollout-*.jsonl file under `dir` with its mtime. */
const collectRolloutFiles = async (
  dir: string
): Promise<{ file: string; mtime: number }[]> => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry);
      try {
        const info = await statAsync(full);
        if (info.isDirectory()) {
          return await collectRolloutFiles(full);
        }
        return entry.startsWith("rollout-") && entry.endsWith(".jsonl")
          ? [{ file: full, mtime: info.mtimeMs }]
          : [];
      } catch {
        return [];
      }
    })
  );
  return nested.flat();
};

/** The newest `limit` main-run sessions under `root`, newest first. */
const scanSessions = async (root: string, limit: number) => {
  const files = await collectRolloutFiles(root);
  // oxlint-disable-next-line unicorn/no-array-sort -- `files` is local to this call; nothing shared is mutated
  files.sort((a, b) => b.mtime - a.mtime);
  const newest = files.slice(0, limit * ROLLOUT_SCAN_FACTOR);
  const sessions: PastSession[] = [];
  for (const { file, mtime } of newest) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time, on purpose
    const session = await parseRollout(file, mtime);
    if (session) {
      sessions.push(session);
    }
    if (sessions.length >= limit) {
      break;
    }
  }
  return sessions;
};

/**
 * The newest `limit` sessions main bot runs left in `$CODEX_HOME/sessions`,
 * newest first; undefined when that directory cannot be read, so the import
 * tries again later. Files are read one at a time, so the scan never floods
 * the disk.
 */
export const pastSessions = async (limit: number) => {
  const root = codexSessionsDir();
  const readable = await readdir(root)
    .then(() => true)
    .catch(() => false);
  return readable ? await scanSessions(root, limit) : undefined;
};

/** Locate a session's rollout file; its name ends with the session id. */
const findRolloutFile = (sessionId: string): string | undefined => {
  const suffix = `-${sessionId}.jsonl`;
  const walk = (dir: string): string | undefined => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry.startsWith("rollout-") && entry.endsWith(suffix)) {
        return full;
      }
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const hit = walk(full);
        if (hit !== undefined) {
          return hit;
        }
      }
    }
    return undefined;
  };
  return walk(codexSessionsDir());
};

/**
 * Input tokens of the session's most recent turn, as Codex recorded them: the
 * size of the context that turn was sent. The SDK cannot supply this — its
 * `Turn.usage` accumulates over every turn of the session, including the ones
 * that ran before a resume.
 */
export const readLastTurnInputTokens = (
  sessionId: string
): number | undefined => {
  const file = findRolloutFile(sessionId);
  if (file === undefined) {
    return undefined;
  }
  let lines: string[];
  try {
    lines = readFileSync(file, "utf-8").split("\n");
  } catch {
    return undefined;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || !line.includes('"token_count"')) {
      continue;
    }
    const parsed = decodeTokenCount(line);
    if (Option.isSome(parsed)) {
      const { info } = parsed.value.payload;
      if (info) {
        return info.last_token_usage.input_tokens;
      }
    }
  }
  return undefined;
};

/** How much of a rollout's end is read back, one chunk at a time. */
const TAIL_CHUNK_BYTES = 262_144;
/**
 * Where the backward read gives up: past a turn's last request only its
 * tool results (about 1 MB each at most) and a few short events follow.
 */
const MAX_TAIL_BYTES = 16_777_216;
const NEWLINE = 0x0a;

/** The token total on one rollout line, if it is a `token_count` with one. */
const tokenTotalOn = (line: Buffer): number | undefined => {
  if (!line.includes('"token_count"')) {
    return undefined;
  }
  const parsed = decodeTokenTotal(line.toString("utf-8"));
  if (Option.isNone(parsed) || !parsed.value.payload.info) {
    return undefined;
  }
  const total = parsed.value.payload.info.total_token_usage;
  return total.input_tokens + total.output_tokens;
};

/**
 * The thread's token total as its rollout last recorded it, prompt tokens
 * (cached ones among them) plus output (reasoning among it): the newest
 * `token_count` that carries one, as Codex restores it on a resume. Read
 * backwards from the end, so a long rollout costs only its tail; undefined
 * when the file cannot be read or holds none in its last `MAX_TAIL_BYTES`.
 */
export const readRolloutTokenTotal = async (
  filePath: string
): Promise<number | undefined> => {
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const floor = Math.max(0, size - MAX_TAIL_BYTES);
      // The start of the line the previous chunk began inside.
      let carry = Buffer.alloc(0);
      for (let end = size; end > floor;) {
        const begin = Math.max(floor, end - TAIL_CHUNK_BYTES);
        const chunk = Buffer.alloc(end - begin);
        // oxlint-disable-next-line no-await-in-loop -- each chunk sits before the last one
        await handle.read(chunk, 0, chunk.length, begin);
        const text = Buffer.concat([chunk, carry]);
        let cut = text.length;
        let newline = cut > 0 ? text.lastIndexOf(NEWLINE, cut - 1) : -1;
        while (newline >= 0) {
          const total = tokenTotalOn(text.subarray(newline + 1, cut));
          if (total !== undefined) {
            return total;
          }
          cut = newline;
          newline = cut > 0 ? text.lastIndexOf(NEWLINE, cut - 1) : -1;
        }
        carry = text.subarray(0, cut);
        end = begin;
      }
      // The file's first line has no newline before it.
      return floor === 0 ? tokenTotalOn(carry) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};
