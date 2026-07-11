import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LegacySessions, makeSessionOps } from "./session-store";

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-store-"));
  storePath = join(dir, "sessions.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const legacy = (
  claude: Record<string, string> = {},
  codex: Record<string, string> = {}
): LegacySessions => ({
  claude: new Map(Object.entries(claude)),
  codex: new Map(Object.entries(codex)),
});

describe("SessionStore ops", () => {
  test("set then get round-trips, provider-namespaced", () => {
    const ops = makeSessionOps(storePath);
    ops.set("/proj", "claude", "c-1");
    ops.set("/proj", "codex", "x-1");

    expect(ops.get("/proj", "claude")).toBe("c-1");
    expect(ops.get("/proj", "codex")).toBe("x-1");
    expect(ops.get("/other", "claude")).toBeUndefined();
  });

  test("leaves no *.tmp files behind after concurrent-ish writes", () => {
    const ops = makeSessionOps(storePath);
    for (let i = 0; i < 20; i++) {
      ops.set(`/proj-${i}`, "claude", `id-${i}`);
    }
    const tmps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmps).toEqual([]);
  });

  test("reads fail open on a corrupt file (never throws)", () => {
    writeFileSync(storePath, "{ this is not json");
    const ops = makeSessionOps(storePath);
    expect(ops.get("/proj", "claude")).toBeUndefined();
    // a subsequent write recovers cleanly on top of the empty store
    ops.set("/proj", "claude", "c-2");
    expect(ops.get("/proj", "claude")).toBe("c-2");
  });

  test("fails open on valid JSON with a missing/null sessions map", () => {
    for (const bad of [
      '{"version":1}',
      '{"version":1,"sessions":null}',
      "[]",
    ]) {
      writeFileSync(storePath, bad);
      const ops = makeSessionOps(storePath);
      expect(ops.get("/proj", "claude")).toBeUndefined();
      expect(ops.count("claude")).toBe(0);
    }
  });

  test("clear removes only the targeted provider", () => {
    const ops = makeSessionOps(storePath);
    ops.set("/proj", "claude", "c-1");
    ops.set("/proj", "codex", "x-1");
    ops.clear("/proj", "claude");
    expect(ops.get("/proj", "claude")).toBeUndefined();
    expect(ops.get("/proj", "codex")).toBe("x-1");
  });

  test("count reflects projects with an id for the provider", () => {
    const ops = makeSessionOps(storePath);
    ops.set("/a", "claude", "1");
    ops.set("/b", "claude", "2");
    ops.set("/c", "codex", "3");
    expect(ops.count("claude")).toBe(2);
    expect(ops.count("codex")).toBe(1);
  });

  test("importLegacy seeds an empty store, then is a no-op", () => {
    const ops = makeSessionOps(storePath);
    ops.importLegacy(legacy({ "/proj": "c-old" }, { "/proj": "x-old" }));
    expect(ops.get("/proj", "claude")).toBe("c-old");
    expect(ops.get("/proj", "codex")).toBe("x-old");

    // second import must not clobber a live id
    ops.set("/proj", "claude", "c-new");
    ops.importLegacy(legacy({ "/proj": "c-old" }));
    expect(ops.get("/proj", "claude")).toBe("c-new");
  });
});
