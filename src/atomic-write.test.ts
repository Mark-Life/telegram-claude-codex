import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uniqueTmp, writeJsonAtomic } from "./atomic-write";

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
  target = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  test("round-trips the value as pretty JSON", () => {
    const value = { a: 1, nested: { b: ["x", "y"] } };
    writeJsonAtomic(target, value);
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual(value);
  });

  test("reports the on-disk UTF-8 byte size, not code-unit count", () => {
    // Pretty JSON of {hello:"world"} is a fixed 22-byte ASCII string.
    const { bytes, durationMs } = writeJsonAtomic(target, { hello: "world" });
    expect(bytes).toBe(22);
    expect(bytes).toBe(readFileSync(target).length); // matches actual file bytes
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  test("byte size counts multi-byte characters as their encoded length", () => {
    // "é" is 2 UTF-8 bytes but 1 UTF-16 code unit, so bytes != string length.
    const { bytes } = writeJsonAtomic(target, { s: "é" });
    const body = JSON.stringify({ s: "é" }, null, 2);
    expect(bytes).toBe(readFileSync(target).length);
    expect(bytes).toBeGreaterThan(body.length);
  });

  test("leaves no *.tmp file behind (rename completed)", () => {
    for (let i = 0; i < 20; i++) {
      writeJsonAtomic(target, { i });
    }
    const files = readdirSync(dir);
    expect(files).toContain("state.json");
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("overwrites atomically without corrupting a prior value", () => {
    writeJsonAtomic(target, { v: 1 });
    writeJsonAtomic(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ v: 2 });
  });
});

describe("uniqueTmp", () => {
  test("is collision-safe: distinct per call, pid-scoped, .tmp-suffixed", () => {
    const a = uniqueTmp(target);
    const b = uniqueTmp(target);
    expect(a).not.toBe(b);
    expect(a.startsWith(`${target}.${process.pid}.`)).toBe(true);
    expect(a.endsWith(".tmp")).toBe(true);
  });
});
