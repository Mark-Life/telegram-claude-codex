import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveBin } from "./provider-bin";

/** A real executable file, because the resolver asks the filesystem. */
const plantCodex = (home: string, dir: string) => {
  mkdirSync(path.join(home, dir), { recursive: true });
  const binary = path.join(home, dir, "codex");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  return binary;
};

const emptyHome = () => mkdtempSync(path.join(tmpdir(), "provider-bin-"));

/** No PATH at all, so only the home probe can answer. */
const NO_PATH = "";

const HOME_BIN_DIRS = [".local/bin", "bin", ".bun/bin", ".codex/bin"];

const resolveCodexBin = (lookup: {
  home: string;
  override?: string;
  searchPath: string;
}) => resolveBin({ ...lookup, command: "codex", homeBinDirs: HOME_BIN_DIRS });

describe("resolveBin", () => {
  test("the override wins over everything, unexamined", () => {
    const home = emptyHome();
    plantCodex(home, ".local/bin");
    expect(
      resolveCodexBin({
        home,
        override: "/opt/codex/bin/codex",
        searchPath: NO_PATH,
      })
    ).toBe("/opt/codex/bin/codex");
  });

  test("a blank override counts as unset", () => {
    const home = emptyHome();
    const planted = plantCodex(home, ".local/bin");
    expect(
      resolveCodexBin({ home, override: "   ", searchPath: NO_PATH })
    ).toBe(planted);
  });

  test("PATH beats the home probe", () => {
    const home = emptyHome();
    plantCodex(home, ".local/bin");
    const systemHome = emptyHome();
    const onPath = plantCodex(systemHome, "usr/bin");
    expect(resolveCodexBin({ home, searchPath: path.dirname(onPath) })).toBe(
      onPath
    );
  });

  test("the home probe finds a user install PATH does not mention", () => {
    const home = emptyHome();
    const planted = plantCodex(home, ".bun/bin");
    expect(resolveCodexBin({ home, searchPath: NO_PATH })).toBe(planted);
  });

  test("the probe order follows the shell's own preference", () => {
    const home = emptyHome();
    const preferred = plantCodex(home, ".local/bin");
    plantCodex(home, ".bun/bin");
    expect(resolveCodexBin({ home, searchPath: NO_PATH })).toBe(preferred);
  });

  test("a file that is not executable is not codex", () => {
    const home = emptyHome();
    mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    writeFileSync(path.join(home, ".local/bin/codex"), "not a program");
    chmodSync(path.join(home, ".local/bin/codex"), 0o644);
    expect(resolveCodexBin({ home, searchPath: NO_PATH })).toBeUndefined();
  });

  test("nothing anywhere means not installed", () => {
    expect(
      resolveCodexBin({ home: emptyHome(), searchPath: NO_PATH })
    ).toBeUndefined();
  });
});
