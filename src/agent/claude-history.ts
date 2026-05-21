import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionInfo } from "./types";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_SESSIONS = 50;

/** Cache of sessionId -> projectPath, populated during listing */
const sessionProjectCache = new Map<string, string>();

/** Look up the project path for a session from cache */
export function getSessionProject(sessionId: string) {
  return sessionProjectCache.get(sessionId);
}

/** Clears the session-to-project cache */
export function clearSessionCache() {
  sessionProjectCache.clear();
}

/** Convert a project path to Claude's storage directory name */
function toStorageDirName(projectPath: string) {
  return projectPath.replace(/\//g, "-");
}

/** Reverse: storage dir name back to project path */
function fromStorageDirName(dirName: string) {
  // "-root-projects-foo" → "/root/projects/foo"
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

/** Strip HTML tags and truncate for display */
function cleanSummary(raw: string) {
  return raw
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, 100);
}

/** Read first N bytes of a file and extract initial JSONL lines */
function readHeadLines(filePath: string, maxBytes = 8192): string[] {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    closeSync(fd);
    const text = buf.toString("utf8", 0, bytesRead);
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Extract session metadata from a JSONL file using only the first few lines */
function parseSessionHead(
  filePath: string,
  mtimeMs: number,
  fallbackProjectPath: string
): SessionInfo | null {
  const lines = readHeadLines(filePath);

  let sessionId = "";
  let summary = "";
  let startedAt = "";
  let projectPath = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!sessionId && obj.sessionId) {
        sessionId = obj.sessionId;
      }
      if (!startedAt && obj.timestamp) {
        startedAt = obj.timestamp;
      }
      if (!projectPath && obj.cwd) {
        projectPath = obj.cwd;
      }
      if (
        !summary &&
        obj.type === "user" &&
        typeof obj.message?.content === "string"
      ) {
        summary = obj.message.content;
      }
      if (sessionId && startedAt && summary && projectPath) {
        break;
      }
    } catch {}
  }

  if (!(summary && sessionId)) {
    return null;
  }
  if (!projectPath) {
    projectPath = fallbackProjectPath;
  }

  return {
    sessionId,
    summary: cleanSummary(summary),
    startedAt,
    lastActiveAt: new Date(mtimeMs).toISOString(),
    projectPath,
    projectName: basename(projectPath),
  };
}

/** Scan a storage directory for JSONL session files, sorted by mtime desc */
function scanStorageDir(
  storageDir: string,
  fallbackProjectPath: string,
  limit: number
): SessionInfo[] {
  let files: string[];
  try {
    files = readdirSync(storageDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const withMtime = files
    .map((f) => {
      try {
        return { name: f, mtime: statSync(join(storageDir, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit * 2);

  const sessions: SessionInfo[] = [];
  for (const { name, mtime } of withMtime) {
    const info = parseSessionHead(
      join(storageDir, name),
      mtime,
      fallbackProjectPath
    );
    if (info) {
      sessions.push(info);
    }
    if (sessions.length >= limit) {
      break;
    }
  }

  return sessions;
}

/** List recent sessions for a specific project directory */
export function listSessions(projectPath: string): SessionInfo[] {
  const dirName = toStorageDirName(projectPath);
  const storageDir = join(CLAUDE_PROJECTS_DIR, dirName);
  const sessions = scanStorageDir(storageDir, projectPath, MAX_SESSIONS);

  for (const s of sessions) {
    sessionProjectCache.set(s.sessionId, s.projectPath);
  }
  return sessions;
}

/** List recent sessions across all projects */
export function listAllSessions(): SessionInfo[] {
  let dirs: string[];
  try {
    dirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  const allSessions: SessionInfo[] = [];
  for (const dir of dirs) {
    const storageDir = join(CLAUDE_PROJECTS_DIR, dir);
    const fallbackPath = fromStorageDirName(dir);
    allSessions.push(...scanStorageDir(storageDir, fallbackPath, MAX_SESSIONS));
  }

  const sorted = allSessions
    .sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    )
    .slice(0, MAX_SESSIONS);

  for (const s of sorted) {
    sessionProjectCache.set(s.sessionId, s.projectPath);
  }
  return sorted;
}
