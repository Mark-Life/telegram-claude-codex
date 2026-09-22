import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionInfo } from "./types";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const MAX_SESSIONS = 50;
const MAX_HEAD_LINES = 40;

/**
 * Resolve a path to its macOS-canonical form so Codex-recorded cwds
 * (`/private/var/...`) and bot project paths (`/var/...`) compare equal.
 * Falls back to the raw string when the path can't be resolved.
 */
const normalizePath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Cache of sessionId -> projectPath, populated during listing */
const sessionProjectCache = new Map<string, string>();

/** Look up the project path for a session from cache */
export const getSessionProject = (sessionId: string) =>
  sessionProjectCache.get(sessionId);

/** Clears the session-to-project cache */
export const clearSessionCache = () => {
  sessionProjectCache.clear();
};

/** Strip HTML tags and truncate for display */
const cleanSummary = (raw: string) =>
  raw
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, 100);

/**
 * Read the leading JSONL lines of a rollout file. Codex `session_meta` lines
 * are large (~20KB of base_instructions), so a byte-bounded head is unreliable;
 * read by line and cap the count instead.
 */
const readHeadLines = (filePath: string): string[] => {
  try {
    const text = readFileSync(filePath, "utf8");
    const lines: string[] = [];
    let from = 0;
    while (lines.length < MAX_HEAD_LINES) {
      const nl = text.indexOf("\n", from);
      if (nl === -1) {
        if (from < text.length) {
          lines.push(text.slice(from));
        }
        break;
      }
      lines.push(text.slice(from, nl));
      from = nl + 1;
    }
    return lines.filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Context blocks Codex injects as user-role turns before the real prompt.
 * They are the agent's own scaffolding, never something the operator typed, so
 * they must not become a session's summary.
 */
const INJECTED_CONTEXT_RE = /^<(environment_context|user_instructions)\b/;

/**
 * The operator's prompt out of a `response_item` message, or "" when the item
 * is not one. Codex 0.155.x stopped emitting the `event_msg`/`user_message`
 * event that used to carry it, so the prompt now only survives as a user-role
 * message whose `content` is an array of `input_text` parts.
 */
export const userPromptFromResponseItem = (obj: {
  payload?: { content?: unknown; role?: unknown; type?: unknown };
  type?: unknown;
}): string => {
  const payload = obj.payload;
  if (
    obj.type !== "response_item" ||
    payload?.type !== "message" ||
    payload.role !== "user" ||
    !Array.isArray(payload.content)
  ) {
    return "";
  }
  const text = payload.content
    .map((part: { text?: unknown }) =>
      typeof part?.text === "string" ? part.text : ""
    )
    .join("")
    .trim();
  return INJECTED_CONTEXT_RE.test(text) ? "" : text;
};

/**
 * Parse a Codex rollout file head into session metadata.
 * Pulls id/cwd/timestamp from `session_meta` and the first user prompt as the
 * summary — from the `event_msg`/`user_message` event that Codex ≤0.146 wrote,
 * falling back to the user-role `response_item` that replaced it in 0.155.x.
 * Both are read so rollouts already on disk keep listing after an SDK bump.
 */
const parseRolloutHead = (
  filePath: string,
  mtimeMs: number
): SessionInfo | null => {
  const lines = readHeadLines(filePath);

  let sessionId = "";
  let projectPath = "";
  let startedAt = "";
  let summary = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "session_meta" && obj.payload) {
        sessionId = obj.payload.id ?? sessionId;
        projectPath = obj.payload.cwd ?? projectPath;
        startedAt = obj.payload.timestamp ?? obj.timestamp ?? startedAt;
      } else if (
        !summary &&
        obj.type === "event_msg" &&
        obj.payload?.type === "user_message" &&
        typeof obj.payload.message === "string"
      ) {
        summary = obj.payload.message;
      } else if (!summary) {
        summary = userPromptFromResponseItem(obj);
      }
      if (sessionId && projectPath && summary) {
        break;
      }
    } catch {
      // malformed JSONL line; skip and continue scanning
    }
  }

  if (!(sessionId && summary)) {
    return null;
  }

  return {
    sessionId,
    summary: cleanSummary(summary),
    startedAt,
    lastActiveAt: new Date(mtimeMs).toISOString(),
    projectPath,
    projectName: projectPath ? basename(projectPath) : "",
  };
};

/** Recursively collect rollout-*.jsonl files with their mtime, newest first */
const collectRolloutFiles = (limit: number) => {
  const found: Array<{ path: string; mtime: number }> = [];

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        found.push({ path: full, mtime: stat.mtimeMs });
      }
    }
  };

  walk(CODEX_SESSIONS_DIR);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit * 2);
};

/** List recent Codex sessions across all projects, newest first */
export const listAllSessions = (): SessionInfo[] => {
  const files = collectRolloutFiles(MAX_SESSIONS);

  const sessions: SessionInfo[] = [];
  for (const { path, mtime } of files) {
    const info = parseRolloutHead(path, mtime);
    if (info) {
      sessions.push(info);
    }
    if (sessions.length >= MAX_SESSIONS) {
      break;
    }
  }

  for (const s of sessions) {
    if (s.projectPath) {
      sessionProjectCache.set(s.sessionId, normalizePath(s.projectPath));
    }
  }
  return sessions;
};

/** List recent Codex sessions for a specific project (filtered by canonicalized cwd) */
export const listSessions = (projectPath: string): SessionInfo[] => {
  const target = normalizePath(projectPath);
  return listAllSessions().filter(
    (s) => s.projectPath && normalizePath(s.projectPath) === target
  );
};
