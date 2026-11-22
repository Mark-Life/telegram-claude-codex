import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  apiRunScratchPath,
  groupDirPath,
  groupsDirPath,
  scratchPath,
} from "@workspace/env/paths";

/**
 * The directory a sandboxed run works in. Never a real project: the bot repo
 * holds `.env`, and a member's agent has no business anywhere near it. One
 * directory per user, so two members cannot read each other's files either.
 */
export const ensureScratchDir = (userId: number) => {
  const dir = scratchPath(userId);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * The directory a group's runs work in, shared by its members: a file one
 * member sends is there for the run another member starts.
 */
export const ensureGroupDir = (chatId: number) => {
  const dir = groupDirPath(chatId);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Drop a group's directory once the bot is no longer in the group. */
export const removeGroupDir = (chatId: number) => {
  rmSync(groupDirPath(chatId), { force: true, recursive: true });
};

/**
 * The scratch directory a sandboxed run works in: the group's for a group
 * run, the caller's own otherwise. Uploads land here too, so the run that
 * reads them is the one that can see them.
 */
export const scratchDirOf = (
  scope: "chat" | "user",
  ids: { chatId: number; userId: number }
) =>
  scope === "chat" ? ensureGroupDir(ids.chatId) : ensureScratchDir(ids.userId);

/**
 * Remove what is under `dir` and older than `cutoff`, then every directory
 * that emptied; the count of files removed.
 */
const pruneTree = (dir: string, cutoff: number): number => {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += pruneTree(entryPath, cutoff);
      if (readdirSync(entryPath).length === 0) {
        rmdirSync(entryPath);
      }
    } else if (statSync(entryPath).mtimeMs < cutoff) {
      rmSync(entryPath, { force: true });
      removed += 1;
    }
  }
  return removed;
};

/**
 * Drop group files sent before `cutoff`: a group keeps sending them, and
 * nothing else ever removes them while the bot stays in it. Returns how
 * many files went.
 */
export const pruneGroupFiles = (cutoff: number) => {
  if (!existsSync(groupsDirPath())) {
    return 0;
  }
  let removed = 0;
  for (const group of readdirSync(groupsDirPath())) {
    const files = path.join(groupsDirPath(), group, "user-sent-files");
    if (existsSync(files)) {
      removed += pruneTree(files, cutoff);
    }
  }
  return removed;
};

/** A fresh scratch directory for one guest-profile API run. */
export const ensureApiRunScratchDir = (runId: number) => {
  const dir = apiRunScratchPath(runId);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Drop a guest-profile API run's scratch directory once the run ended. */
export const removeApiRunScratchDir = (runId: number) => {
  rmSync(apiRunScratchPath(runId), { force: true, recursive: true });
};
