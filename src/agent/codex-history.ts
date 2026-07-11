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
 * Parse a Codex rollout file head into session metadata.
 * Pulls id/cwd/timestamp from `session_meta` and the first user prompt
 * (an `event_msg` with `payload.type === "user_message"`) as the summary.
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
