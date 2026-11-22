import { readFileSync } from "node:fs";

import { isMissingFile } from "@workspace/core/errors";
import { writeJsonAtomic } from "@workspace/core/fs";
import { dataPath } from "@workspace/env/paths";
import { Effect, Option, Schedule, Schema } from "effect";

import {
  getSetting,
  listAllApiKeys,
  listApiKeyFingerprints,
  listUsers,
} from "../db/bridge";
import { t } from "../i18n";
import { logWarning } from "../log";
import type { PendingWork } from "../pending-work";
import { tierLabel, TIERS } from "./tier";

/**
 * Visibility over the things that decide who the bot obeys: the trusted
 * group list plus the workspace chat (settings), the managed tiers (users)
 * and the HTTP API keys (api_keys). All are plain sqlite rows a run with the
 * machine can write (a forged key row is a forged owner), so the
 * bot keeps its own copy of what it last saw and tells the owner, in their
 * chat, when the db says something else. This reports, it never enforces — the
 * db stays the source of truth.
 *
 * The copy lives in `.data` and is disposable: losing it re-baselines on the
 * next check and costs one missed notice, so it is not worth backing up.
 */

/** How often the db is compared with the last snapshot. */
export const AUDIT_INTERVAL_MS = 60_000;

const SNAPSHOT_FILE = dataPath("access-snapshot.json");

/**
 * What the bot last saw. Both lists are compared by membership, never by
 * position, so a row order the db happens to change is not a difference.
 */
export interface AccessSnapshot {
  /**
   * One `<keyId>:<userId>:<live|revoked>:<fingerprint>` entry per API key,
   * the fingerprint being the first 8 hex chars of the stored secret hash.
   * Absent in a snapshot an older build wrote: the keys are then taken as
   * they are; an entry without a fingerprint re-baselines it quietly.
   */
  apiKeys?: readonly string[];
  /** Group ids from `trusted_group_ids`, trimmed, blanks dropped. */
  trustedGroupIds: readonly string[];
  /** One `<userId>:<tier>` entry per managed user. */
  users: readonly string[];
  /** `<chatId>` or `<chatId>/<threadId>`; empty when no workspace is set. */
  workspace: string;
}

const SnapshotSchema = Schema.Struct({
  apiKeys: Schema.optional(Schema.Array(Schema.String)),
  trustedGroupIds: Schema.Array(Schema.String),
  users: Schema.Array(Schema.String),
  workspace: Schema.String,
});

const decodeSnapshot = Schema.decodeUnknownOption(SnapshotSchema);

/** Ids in the comma-separated trusted list, blanks dropped. */
const trustedIds = (stored: string | undefined) =>
  (stored ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

/** The workspace as one comparable string; the topic only when there is one. */
const workspaceOf = async () => {
  const chatId = (await getSetting("workspace_chat_id")) ?? "";
  const threadId = (await getSetting("workspace_thread_id")) ?? "";
  if (chatId.length === 0) {
    return "";
  }
  return threadId.length === 0 ? chatId : `${chatId}/${threadId}`;
};

/** The access state as the db has it right now. */
export const readAccessState = async (): Promise<AccessSnapshot> => {
  const users = await listUsers();
  const keys = await listAllApiKeys();
  const hashes = await listApiKeyFingerprints();
  const fingerprints = new Map(hashes.map((row) => [row.id, row.fingerprint]));
  return {
    apiKeys: keys.map(
      (key) =>
        `${key.id}:${key.userId}:${key.revokedAt === undefined ? "live" : "revoked"}:${fingerprints.get(key.id) ?? ""}`
    ),
    trustedGroupIds: trustedIds(await getSetting("trusted_group_ids")),
    users: users.map((entry) => `${entry.userId}:${entry.tier}`),
    workspace: await workspaceOf(),
  };
};

/** `<userId>:<tier>` entries as a lookup, so a tier change reads as one line. */
const tiersOf = (users: readonly string[]) =>
  new Map(
    users.map((entry) => {
      const [userId = "", tier = ""] = entry.split(":");
      return [userId, tier] as const;
    })
  );

/**
 * `<keyId>:<userId>:<state>:<fingerprint>` entries by key id. An empty
 * fingerprint means unknown (an older snapshot), never a change.
 */
const keysOf = (entries: readonly string[]) =>
  new Map(
    entries.map((entry) => {
      const [keyId = "", userId = "", state = "", fingerprint = ""] =
        entry.split(":");
      return [keyId, { fingerprint, state, userId }] as const;
    })
  );

/**
 * One line per API key added, removed, moved to another user, re-stated or
 * given another secret hash. The hash itself never goes into a line.
 */
const diffKeys = (
  before: readonly string[],
  after: readonly string[]
): readonly string[] => {
  const copy = t().audit;
  const was = keysOf(before);
  const now = keysOf(after);
  const lines: string[] = [];
  for (const [keyId, key] of now) {
    const old = was.get(keyId);
    if (old === undefined) {
      lines.push(copy.apiKeyAdded({ keyId, userId: key.userId }));
    } else if (old.userId !== key.userId) {
      lines.push(
        copy.apiKeyMoved({ after: key.userId, before: old.userId, keyId })
      );
    } else if (old.state !== key.state) {
      lines.push(
        key.state === "revoked"
          ? copy.apiKeyRevoked(keyId)
          : copy.apiKeyRestored(keyId)
      );
    } else if (
      old.fingerprint.length > 0 &&
      key.fingerprint.length > 0 &&
      old.fingerprint !== key.fingerprint
    ) {
      lines.push(copy.apiKeySecretReplaced(keyId));
    }
  }
  for (const keyId of was.keys()) {
    if (!now.has(keyId)) {
      lines.push(copy.apiKeyRemoved(keyId));
    }
  }
  return lines;
};

/** Human name of a stored tier; an unknown one is shown as written. */
const nameOfTier = (tier: string) => {
  const known = TIERS.find((name) => name === tier);
  return known === undefined ? tier : tierLabel(known);
};

/** One line per difference; empty when the two snapshots agree. */
export const diffAccess = (
  before: AccessSnapshot,
  after: AccessSnapshot
): readonly string[] => {
  const copy = t().audit;
  const lines: string[] = [];
  for (const id of after.trustedGroupIds) {
    if (!before.trustedGroupIds.includes(id)) {
      lines.push(copy.groupTrusted(id));
    }
  }
  for (const id of before.trustedGroupIds) {
    if (!after.trustedGroupIds.includes(id)) {
      lines.push(copy.groupUntrusted(id));
    }
  }
  if (before.workspace !== after.workspace) {
    lines.push(
      copy.workspaceMoved({
        after: after.workspace || copy.noWorkspace,
        before: before.workspace || copy.noWorkspace,
      })
    );
  }
  const wasTier = tiersOf(before.users);
  const nowTier = tiersOf(after.users);
  for (const [userId, tier] of nowTier) {
    const was = wasTier.get(userId);
    if (was === undefined) {
      lines.push(copy.granted({ tier: nameOfTier(tier), userId }));
    } else if (was !== tier) {
      lines.push(
        copy.tierChanged({
          after: nameOfTier(tier),
          before: nameOfTier(was),
          userId,
        })
      );
    }
  }
  for (const userId of wasTier.keys()) {
    if (!nowTier.has(userId)) {
      lines.push(copy.revoked(userId));
    }
  }
  // A snapshot from before keys were watched has none to compare.
  if (before.apiKeys !== undefined) {
    lines.push(...diffKeys(before.apiKeys, after.apiKeys ?? []));
  }
  return lines;
};

let cached: AccessSnapshot | undefined;

/** The stored snapshot; undefined when there is none or it cannot be read. */
const loadSnapshot = () => {
  if (cached) {
    return cached;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8"));
    cached = Option.getOrUndefined(decodeSnapshot(parsed));
  } catch (error) {
    if (!isMissingFile(error)) {
      logWarning("Access snapshot unreadable, re-baselining", error);
    }
    cached = undefined;
  }
  return cached;
};

/** Remember one state as the baseline every later check is compared with. */
const saveSnapshot = (snapshot: AccessSnapshot) => {
  cached = snapshot;
  try {
    writeJsonAtomic(SNAPSHOT_FILE, snapshot);
  } catch (error) {
    logWarning("Failed to persist the access snapshot", error);
  }
};

/**
 * Re-baseline after the bot itself changed access. Called by the commands that
 * write those tables, so their own change is never reported back as an edit
 * made behind the bot's back.
 */
export const syncAccessSnapshot = async () => {
  saveSnapshot(await readAccessState());
};

/** What the watcher needs: where a notice goes, and what a shutdown drains. */
export interface AccessWatcherDeps {
  notify: (text: string) => Promise<void>;
  pendingWork: PendingWork["Service"];
}

/**
 * Build the periodic access check. Nothing runs until `start`; the first check
 * of a fresh install only records the baseline, so an existing db is never
 * reported as a change.
 */
export const createAccessWatcher = ({
  notify,
  pendingWork,
}: AccessWatcherDeps) => {
  /** Compare the db with the baseline, then adopt it as the new baseline. */
  const check = async () => {
    const before = loadSnapshot();
    const current = await readAccessState();
    const lines = before === undefined ? [] : diffAccess(before, current);
    if (lines.length === 0) {
      saveSnapshot(current);
      return;
    }
    logWarning(`Access changed outside the bot: ${lines.join(" ")}`);
    await notify([t().audit.changedOutside, ...lines].join("\n"));
    // The baseline moves only once the owner has been told, so a send that
    // fails is retried on the next tick instead of being lost.
    saveSnapshot(current);
  };

  // A failed check is logged and forgotten; the next pass tries again. The
  // check is pending work, so a notice already on its way is not cut.
  const pass = pendingWork
    .run(Effect.tryPromise(check))
    .pipe(
      Effect.catch((error) => Effect.logError("Access check failed", error))
    );

  /** Check every `AUDIT_INTERVAL_MS`, first after one interval, until the scope closes. */
  const start = Effect.sleep(AUDIT_INTERVAL_MS).pipe(
    Effect.andThen(pass.pipe(Effect.repeat(Schedule.fixed(AUDIT_INTERVAL_MS)))),
    Effect.forkScoped,
    Effect.asVoid
  );

  return { start } as const;
};
