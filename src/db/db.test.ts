import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, quarantineDb } from "./client";
import { makeComposeOps } from "./compose";
import { runLegacyImport } from "./legacy-import";
import { LATEST_VERSION, schemaVersion } from "./migrations";
import { makeSessionOps } from "./sessions";
import { makeSettingsOps } from "./settings";
import { makeThreadOps } from "./threads";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-db-"));
  dbPath = join(dir, "bot.db");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("migrations", () => {
  test("a fresh db is migrated to the latest version", () => {
    const db = openDb(dbPath);
    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )
      .all()
      .map((row) => row.name);
    for (const table of ["threads", "sessions", "compose", "settings"]) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  test("reopening an up-to-date db runs nothing and keeps data", () => {
    const first = openDb(dbPath);
    makeSettingsOps(first).saveActiveProvider("codex");
    first.close();

    const second = openDb(dbPath);
    expect(schemaVersion(second)).toBe(LATEST_VERSION);
    expect(makeSettingsOps(second).loadBotState().activeProvider).toBe("codex");
    second.close();
  });
});

describe("quarantineDb", () => {
  test("moves the file and its WAL sidecars aside", () => {
    const db = openDb(dbPath);
    makeSettingsOps(db).saveActiveProvider("codex");
    db.close();

    const moved = quarantineDb(dbPath);
    expect(moved).toBeString();
    expect(existsSync(dbPath)).toBe(false);
    // The next open starts from a fresh file instead of failing again.
    const fresh = openDb(dbPath);
    expect(schemaVersion(fresh)).toBe(LATEST_VERSION);
    fresh.close();
  });

  test("reports nothing to move when there is no file", () => {
    expect(quarantineDb(join(dir, "absent.db"))).toBeUndefined();
  });
});

describe("thread ops", () => {
  const key = { chatId: -100, threadId: 7 };

  test("a re-pin to the same project and provider keeps the session", () => {
    const db = openDb(dbPath);
    const ops = makeThreadOps(db);
    ops.pin({ ...key, projectPath: "/p/a", provider: "claude" });
    ops.setSession({ ...key, sessionId: "s-1" });

    const repinned = ops.pin({
      ...key,
      projectPath: "/p/a",
      provider: "claude",
    });
    expect(repinned?.sessionId).toBe("s-1");
    db.close();
  });

  test("switching project or provider drops the session", () => {
    const db = openDb(dbPath);
    const ops = makeThreadOps(db);
    ops.pin({ ...key, projectPath: "/p/a", provider: "claude" });
    ops.setSession({ ...key, sessionId: "s-1" });

    expect(
      ops.pin({ ...key, projectPath: "/p/b", provider: "claude" })?.sessionId
    ).toBeUndefined();

    ops.setSession({ ...key, sessionId: "s-2" });
    expect(
      ops.pin({ ...key, projectPath: "/p/b", provider: "codex" })?.sessionId
    ).toBeUndefined();
    expect(ops.get(key)?.provider).toBe("codex");
    db.close();
  });
});

describe("compose ops", () => {
  test("append/list/clear keep arrival order and report the discard count", () => {
    const db = openDb(dbPath);
    const ops = makeComposeOps(db);
    const key = { chatId: 5, threadId: null, userId: 5 };
    ops.append({ ...key, content: "one", type: "text" });
    ops.append({ ...key, content: "two", type: "voice" });
    // a different thread is a separate buffer
    ops.append({
      chatId: 5,
      content: "other",
      threadId: 9,
      type: "text",
      userId: 5,
    });

    expect(ops.list(key)).toEqual([
      { content: "one", type: "text" },
      { content: "two", type: "voice" },
    ]);
    expect(ops.count(key)).toBe(2);
    expect(ops.clear(key)).toBe(2);
    expect(ops.list(key)).toEqual([]);
    expect(ops.count({ chatId: 5, threadId: 9, userId: 5 })).toBe(1);
    db.close();
  });

  test("two chats with no topic keep separate buffers", () => {
    const db = openDb(dbPath);
    const ops = makeComposeOps(db);
    const dm = { chatId: 5, threadId: null, userId: 5 };
    // The forum's General topic carries no thread id either, so only the chat
    // tells the two buffers apart.
    const general = { chatId: -100, threadId: null, userId: 5 };
    ops.append({ ...dm, content: "dm draft", type: "text" });
    ops.append({ ...general, content: "general draft", type: "text" });

    expect(ops.clear(general)).toBe(1);
    expect(ops.list(dm)).toEqual([{ content: "dm draft", type: "text" }]);
    db.close();
  });
});

describe("legacy import", () => {
  const writeStores = () => {
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        activeProject: dir,
        activeProvider: "codex",
        efforts: {},
        models: { claude: "opus" },
        version: 1,
      })
    );
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify({
        sessions: { "/p/a": { claude: { sessionId: "legacy-1" } } },
        version: 1,
      })
    );
  };

  test("imports once, then is a no-op", () => {
    writeStores();
    const db = openDb(dbPath);

    const first = runLegacyImport(db, dir);
    expect(first).toEqual({ imported: 1, skipped: false, state: true });
    const state = makeSettingsOps(db).loadBotState();
    expect(state.activeProvider).toBe("codex");
    expect(state.activeProject).toBe(dir);
    expect(state.models).toEqual({ claude: "opus" });
    expect(makeSessionOps(db).get("/p/a", "claude")).toBe("legacy-1");

    makeSettingsOps(db).saveActiveProvider("claude");
    const second = runLegacyImport(db, dir);
    expect(second.skipped).toBe(true);
    expect(makeSettingsOps(db).loadBotState().activeProvider).toBe("claude");
    db.close();
  });

  test("unreadable stores never throw and are retried on the next boot", () => {
    writeFileSync(join(dir, "state.json"), "{not json");
    const db = openDb(dbPath);
    expect(runLegacyImport(db, dir)).toEqual({
      imported: 0,
      skipped: true,
      state: false,
    });

    // The flag stayed unset, so stores that show up later still get imported.
    writeStores();
    expect(runLegacyImport(db, dir)).toEqual({
      imported: 1,
      skipped: false,
      state: true,
    });
    db.close();
  });
});
