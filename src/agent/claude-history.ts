import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionInfo } from "./types";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_SESSIONS = 50;

const SLASH_RE = /\//g;
const LEADING_DASH_RE = /^-/;
const DASH_RE = /-/g;
const HTML_TAG_RE = /<[^>]+>/g;

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
  return projectPath.replace(SLASH_RE, "-");
}

/** Reverse: storage dir name back to project path */
function fromStorageDirName(dirName: string) {
  // "-root-projects-foo" → "/root/projects/foo"
  return dirName.replace(LEADING_DASH_RE, "/").replace(DASH_RE, "/");
}

/** Strip HTML tags and truncate for display */
function cleanSummary(raw: string) {
  return raw.replace(HTML_TAG_RE, "").trim().slice(0, 100);
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

/** Accumulating metadata gathered while scanning a session's head lines */
interface SessionHead {
  projectPath: string;
  sessionId: string;
  startedAt: string;
  summary: string;
}

/** Shape of a single parsed JSONL record we care about */
interface RawRecord {
  cwd?: string;
  message?: { content?: unknown };
  sessionId?: string;
  timestamp?: string;
  type?: string;
}

/** True once every field of interest has been collected */
const isHeadComplete = (head: SessionHead) =>
  Boolean(head.sessionId && head.startedAt && head.summary && head.projectPath);

/** Merge one parsed JSONL record into the accumulating head (mutates head) */
const applyRecord = (head: SessionHead, rec: RawRecord) => {
  if (!head.sessionId && rec.sessionId) {
    head.sessionId = rec.sessionId;
  }
  if (!head.startedAt && rec.timestamp) {
    head.startedAt = rec.timestamp;
  }
  if (!head.projectPath && rec.cwd) {
    head.projectPath = rec.cwd;
  }
  if (
    !head.summary &&
    rec.type === "user" &&
    typeof rec.message?.content === "string"
  ) {
    head.summary = rec.message.content;
  }
};

/** Parse head lines into a partial SessionHead, stopping once complete */
const collectSessionHead = (lines: string[]): SessionHead => {
  const head: SessionHead = {
    sessionId: "",
    summary: "",
    startedAt: "",
    projectPath: "",
  };

  for (const line of lines) {
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      // Skip malformed JSONL lines; partial files are expected.
      continue;
    }
    applyRecord(head, rec);
    if (isHeadComplete(head)) {
      break;
    }
  }

  return head;
};

/** Extract session metadata from a JSONL file using only the first few lines */
function parseSessionHead(
  filePath: string,
  mtimeMs: number,
  fallbackProjectPath: string
): SessionInfo | null {
  const head = collectSessionHead(readHeadLines(filePath));

  if (!(head.summary && head.sessionId)) {
    return null;
  }

  const projectPath = head.projectPath || fallbackProjectPath;

  return {
    sessionId: head.sessionId,
    summary: cleanSummary(head.summary),
    startedAt: head.startedAt,
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
