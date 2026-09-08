import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSessionOps, openDb } from "../db";

// SessionStore is a thin Effect wrapper over these ops, and the wrapper cannot
// be pointed at a temp database, so the behaviour it depends on is exercised
// directly against one.
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-store-"));
  dbPath = join(dir, "bot.db");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("session ops backing SessionStore", () => {
  test("set then get round-trips, provider-namespaced", () => {
    const db = openDb(dbPath);
    const ops = makeSessionOps(db);
    ops.set({ project: "/proj", provider: "claude", sessionId: "c-1" });
    ops.set({ project: "/proj", provider: "codex", sessionId: "x-1" });

    expect(ops.get("/proj", "claude")).toBe("c-1");
    expect(ops.get("/proj", "codex")).toBe("x-1");
    expect(ops.get("/other", "claude")).toBeUndefined();
    db.close();
  });

  test("set replaces the project's earlier id for that provider", () => {
    const db = openDb(dbPath);
    const ops = makeSessionOps(db);
    ops.set({ project: "/proj", provider: "claude", sessionId: "c-1" });
    ops.set({ project: "/proj", provider: "claude", sessionId: "c-2" });

    expect(ops.get("/proj", "claude")).toBe("c-2");
    expect(ops.count("claude")).toBe(1);
    db.close();
  });

  test("clear removes only the targeted provider", () => {
    const db = openDb(dbPath);
    const ops = makeSessionOps(db);
    ops.set({ project: "/proj", provider: "claude", sessionId: "c-1" });
    ops.set({ project: "/proj", provider: "codex", sessionId: "x-1" });
    ops.clear("/proj", "claude");

    expect(ops.get("/proj", "claude")).toBeUndefined();
    expect(ops.get("/proj", "codex")).toBe("x-1");
    db.close();
  });

  test("count reflects projects with an id for the provider", () => {
    const db = openDb(dbPath);
    const ops = makeSessionOps(db);
    ops.set({ project: "/a", provider: "claude", sessionId: "1" });
    ops.set({ project: "/b", provider: "claude", sessionId: "2" });
    ops.set({ project: "/c", provider: "codex", sessionId: "3" });

    expect(ops.count("claude")).toBe(2);
    expect(ops.count("codex")).toBe(1);
    db.close();
  });

  test("ids survive reopening the database", () => {
    const first = openDb(dbPath);
    makeSessionOps(first).set({
      project: "/proj",
      provider: "claude",
      sessionId: "c-1",
    });
    first.close();

    const second = openDb(dbPath);
    expect(makeSessionOps(second).get("/proj", "claude")).toBe("c-1");
    second.close();
  });
});
