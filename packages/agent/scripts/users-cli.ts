#!/usr/bin/env bun

// Access management for codex runs: the owner tells their agent "add this
// person as tier 2" and the agent runs this. Only owner runs are ever pointed
// at its skill, `skills/bot-access/SKILL.md` (see run-prompt.ts), and member
// and guest runs are sandboxed away from `.data` and the repo, so a member's
// agent can neither learn nor reach it.

import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { isStoredTier, UsersRepo } from "@workspace/db";
import { DATA_DIR } from "@workspace/env/paths";
import { Console, Effect, Option } from "effect";

import { COMMAND_INDEX, readFlag, refuse, runDbCli } from "./lib/db-cli";

const USAGE = [
  "Usage:",
  "  users-cli.ts list",
  "  users-cli.ts grant --user <id> --tier <executor|member> [--username <name>]",
  "  users-cli.ts set-tier --user <id> --tier <executor|member>",
  "  users-cli.ts revoke --user <id>",
].join("\n");

/** The target user id, validated. */
const readUserId = (argv: readonly string[]) => {
  const raw = readFlag(argv, "--user");
  const parsed = Number(raw);
  return raw !== undefined && Number.isSafeInteger(parsed) && parsed > 0
    ? Effect.succeed(parsed)
    : refuse("--user must be a positive Telegram user id");
};

/** The tier to grant, validated against the tiers this build stores. */
const readTier = (argv: readonly string[]) => {
  const raw = readFlag(argv, "--tier") ?? "";
  return isStoredTier(raw)
    ? Effect.succeed(raw)
    : refuse("--tier must be one of: executor, member");
};

/** Owner id the mutation is attributed to; the CLI runs on the owner's behalf. */
const readAddedBy = (argv: readonly string[]) =>
  Number(readFlag(argv, "--by") ?? process.env.ALLOWED_USER_ID ?? 0) || 0;

/**
 * Append the mutation to the shared wide-event ledger. The bot writes the same
 * shape from `observability.ts`; this is the CLI's copy so a change made
 * through codex is auditable too. Best-effort — the mutation is already done.
 */
const logMutation = (entry: {
  action: "grant" | "revoke" | "set_tier";
  addedBy: number;
  targetUserId: number;
  tier: string | null;
  username: string | null;
}) => {
  const file = path.resolve(
    DATA_DIR,
    process.env.TG_LOG_FILE ?? "events.jsonl"
  );
  const line = `${JSON.stringify({
    ...entry,
    actor: "cli",
    event: "telegram.user",
    host: hostname(),
    ts: new Date().toISOString(),
    version: "cli",
  })}\n`;
  return Effect.tryPromise(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, line);
  }).pipe(
    // The ledger is best-effort; never fail a mutation over it.
    Effect.ignore
  );
};

/** Tell the owner what changed, the same way the send-file helper reports. */
const notifyOwner = (text: string) => {
  const token = process.env.BOT_TOKEN ?? "";
  const chat = process.env.ALLOWED_USER_ID ?? "";
  if (token.length === 0 || chat.length === 0) {
    return Effect.void;
  }
  return Effect.tryPromise(
    async () =>
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        body: JSON.stringify({ chat_id: chat, text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
  ).pipe(
    // Notification is a courtesy; the db write already succeeded.
    Effect.ignore
  );
};

const list = Effect.gen(function* list() {
  const users = yield* UsersRepo;
  const rows = yield* users.list();
  yield* Console.log(
    rows.length === 0
      ? "No managed users. Everyone but the owner is a guest."
      : rows
          .map(
            (row) =>
              `${row.userId}\t${row.tier}\t${row.username ?? "-"}\tadded_by=${row.addedBy}`
          )
          .join("\n")
  );
});

const grant = Effect.fn(function* grant(
  argv: readonly string[],
  command: "grant" | "set-tier"
) {
  const users = yield* UsersRepo;
  const userId = yield* readUserId(argv);
  const tier = yield* readTier(argv);
  const username = readFlag(argv, "--username")?.replace(/^@/u, "");
  // A row whose tier this build does not know reads as no grant, the way the
  // sync ops read it: the upsert below overwrites it, and the ledger calls
  // that a grant. The operator still sees the alien row on stderr.
  const before = yield* users.get(userId).pipe(
    Effect.catchIf(
      (error) => error.reason === "Decode",
      (error) =>
        Effect.logWarning(
          "stored tier unknown to this build",
          error.cause
        ).pipe(Effect.as(Option.none()))
    )
  );
  yield* users.grant({ addedBy: readAddedBy(argv), tier, userId, username });
  const action =
    command === "grant" && Option.isNone(before) ? "grant" : "set_tier";
  yield* logMutation({
    action,
    addedBy: readAddedBy(argv),
    targetUserId: userId,
    tier,
    username: username ?? null,
  });
  const handle = username === undefined ? "" : ` (@${username})`;
  const summary = `Access: ${userId}${handle} is now tier "${tier}".`;
  yield* notifyOwner(summary);
  yield* Console.log(summary);
});

const revoke = Effect.fn(function* revoke(argv: readonly string[]) {
  const users = yield* UsersRepo;
  const userId = yield* readUserId(argv);
  const removed = yield* users.revoke(userId);
  if (removed) {
    yield* logMutation({
      action: "revoke",
      addedBy: readAddedBy(argv),
      targetUserId: userId,
      tier: null,
      username: null,
    });
    yield* notifyOwner(`Access: ${userId} revoked, back to guest.`);
  }
  yield* Console.log(
    removed ? `Revoked ${userId}.` : `${userId} was not a managed user.`
  );
});

/** One CLI invocation; `argv` is the full `process.argv`. */
export const main = Effect.fn("users-cli")(function* main(
  argv: readonly string[]
) {
  const command = argv[COMMAND_INDEX] ?? "";
  switch (command) {
    case "list": {
      return yield* list;
    }
    case "grant":
    case "set-tier": {
      return yield* grant(argv, command);
    }
    case "revoke": {
      return yield* revoke(argv);
    }
    default: {
      return yield* refuse(USAGE);
    }
  }
});

if (import.meta.main) {
  runDbCli(main(process.argv));
}
