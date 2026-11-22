import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readStateFile } from "./state";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "state-"));
  statePath = path.join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("readStateFile", () => {
  test("a missing file is a legitimate first run, not corruption", () => {
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("missing");
    // nothing was created or preserved
    expect(readdirSync(dir)).toEqual([]);
  });

  test("valid state round-trips an existing project path", () => {
    // activeProject must exist on disk to survive parseState's existence check.
    writeFileSync(
      statePath,
      JSON.stringify({
        activeProject: dir,
        activeProvider: "codex",
        version: 1,
      })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProject).toBe(dir);
    }
  });

  test("a non-existent activeProject degrades to empty", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ activeProject: "/no/such/dir", activeProvider: "bogus" })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProject).toBe("");
    }
  });

  test("a stale provider, model and effort from an older build are ignored", () => {
    // Model and effort moved onto the thread; a file written before that still
    // carries them, and reading it must not resurrect a global default.
    writeFileSync(
      statePath,
      JSON.stringify({
        activeProject: dir,
        activeProvider: "codex",
        efforts: { codex: "high" },
        models: { codex: "sol" },
      })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded).toEqual({
        activeProject: dir,
        status: "ok",
      });
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
