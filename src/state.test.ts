import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStateFile } from "./state";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-"));
  statePath = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readStateFile", () => {
  test("a missing file is a legitimate first run, not corruption", () => {
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("missing");
    // nothing was created or preserved
    expect(readdirSync(dir)).toEqual([]);
  });

  test("valid state round-trips provider and an existing project path", () => {
    // activeProject must exist on disk to survive parseState's existence check.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        activeProvider: "codex",
        activeProject: dir,
        sessions: { claude: { [dir]: "c-1" }, codex: { [dir]: "x-1" } },
      })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProvider).toBe("codex");
      expect(loaded.activeProject).toBe(dir);
      expect(loaded.legacySessions.claude.get(dir)).toBe("c-1");
      expect(loaded.legacySessions.codex.get(dir)).toBe("x-1");
    }
  });

  test("a non-existent activeProject degrades to empty, provider defaults", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ activeProject: "/no/such/dir", activeProvider: "bogus" })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProject).toBe("");
      expect(loaded.activeProvider).toBe("claude");
    }
  });

  test("migrates the old flat session shape into legacySessions.claude", () => {
    // Old shape: no activeProvider, sessions is a flat { <proj>: <id> } map.
    writeFileSync(statePath, JSON.stringify({ sessions: { "/p": "c-1" } }));
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProvider).toBe("claude");
      expect(loaded.legacySessions.claude.get("/p")).toBe("c-1");
      expect(loaded.legacySessions.codex.size).toBe(0);
    }
  });

  test("a real IO fault (not ENOENT) is rethrown, never masked as empty", () => {
    // Reading a directory as a file surfaces EISDIR — a genuine fault the loader
    // must surface rather than silently treat as missing/corrupt state.
    expect(() => readStateFile(dir)).toThrow();
  });

  test("corrupt JSON is preserved, not silently wiped", () => {
    writeFileSync(statePath, "{ not json");
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("corrupt");
    if (loaded.status === "corrupt") {
      expect(loaded.errorClass).toBe("SyntaxError");
      expect(loaded.preservedTo.startsWith(`${statePath}.corrupt-`)).toBe(true);
    }
    // the bad file was renamed aside — a corrupt copy exists, original is gone
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    expect(files).not.toContain("state.json");
  });
});
