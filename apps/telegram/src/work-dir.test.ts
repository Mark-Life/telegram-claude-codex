import { afterEach, describe, expect, test } from "bun:test";

import { pinWorkDir, projectPathOr, workDir } from "./work-dir";

afterEach(() => {
  pinWorkDir();
});

describe("pinWorkDir", () => {
  test("nothing pinned leaves the caller's choice alone", () => {
    expect(workDir()).toBeUndefined();
    expect(projectPathOr("/home/agent/projects/site")).toBe(
      "/home/agent/projects/site"
    );
  });

  test("a pinned directory wins over every candidate", () => {
    pinWorkDir("/home/bot/workspace");
    expect(workDir()).toBe("/home/bot/workspace");
    expect(projectPathOr("/home/agent/projects/site")).toBe(
      "/home/bot/workspace"
    );
    expect(projectPathOr("")).toBe("/home/bot/workspace");
  });

  test("a blank value counts as unset", () => {
    pinWorkDir("   ");
    expect(workDir()).toBeUndefined();
    expect(projectPathOr("/tmp/x")).toBe("/tmp/x");
  });
});
