import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { spawn, which } from "bun";
import { Option, Schema } from "effect";

import { minimalEnv } from "./run-env";
import type { ProviderAvailability } from "./types";

/**
 * The Claude account as the bot sees it, with no SDK loaded. A `claude` on
 * PATH (or in a home bin dir) is the sign the operator installed Claude Code
 * and logged in with `claude auth login`; runs never spawn it. They spawn the
 * CLI the SDK ships, pinned with it, or `CLAUDE_BIN` when the operator set
 * one, and the account check asks that same binary.
 */

/** The bare name of the Claude Code CLI. */
export const CLAUDE_COMMAND = "claude";

/**
 * Where a user-scoped Claude Code install lands, highest priority first: the
 * native installer's link, the usual user bin dirs, and the older local npm
 * install.
 */
export const CLAUDE_HOME_BIN_DIRS = [
  ".local/bin",
  "bin",
  ".bun/bin",
  ".claude/local",
] as const;

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Whether this Linux runs on musl, read the way the SDK reads it: a glibc
 * process reports its glibc version.
 */
const decodeReport = Schema.decodeUnknownOption(
  Schema.Struct({
    header: Schema.Struct({
      glibcVersionRuntime: Schema.optional(Schema.String),
    }),
  })
);

const isMusl = () =>
  Option.match(decodeReport(process.report.getReport()), {
    onNone: () => false,
    onSome: ({ header }) => header.glibcVersionRuntime === undefined,
  });

/** The SDK's platform packages for this host, in the order the SDK tries them. */
const platformPackages = () => {
  const { arch, platform } = process;
  const base = `${SDK_PACKAGE}-${platform}-${arch}`;
  if (platform !== "linux") {
    return [base];
  }
  return isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`];
};

/** `require` as seen from the SDK package; empty when it is not installed. */
const sdkRequire = () => {
  try {
    return [createRequire(import.meta.resolve(SDK_PACKAGE))];
  } catch {
    return [];
  }
};

/**
 * The CLI binary the SDK ships for this host, found the way the SDK finds
 * it, or undefined when no platform package was installed. Resolved to the
 * real file, so a sandbox view can bind it.
 */
const bundledClaude = () =>
  sdkRequire().flatMap((fromSdk) =>
    platformPackages().flatMap((name) => {
      try {
        const bin = fromSdk.resolve(`${name}/claude`);
        return existsSync(bin) ? [realpathSync(bin)] : [];
      } catch {
        // Not installed for this libc.
        return [];
      }
    })
  )[0];

/** A JS or TS entry, which the SDK runs under node or bun instead of directly. */
const SCRIPT_ENTRY = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/**
 * `CLAUDE_BIN` as the absolute real path of a native binary: a bare name is
 * looked up on PATH. Undefined when it names nothing or a script entry, since
 * the sandbox view binds that one file and spawns it directly.
 */
const overrideBin = (override: string) => {
  const found = override.includes("/")
    ? path.resolve(override)
    : (which(override) ?? undefined);
  const real =
    found !== undefined && existsSync(found) ? realpathSync(found) : undefined;
  return real === undefined || SCRIPT_ENTRY.test(real) ? undefined : real;
};

/** Whether the operator set `CLAUDE_BIN`, so runs start that CLI. */
export const claudeBinOverridden = () =>
  (process.env.CLAUDE_BIN?.trim() ?? "").length > 0;

/**
 * The CLI runs spawn: `CLAUDE_BIN` when the operator set one (it then moves
 * with that install's own updates), else the binary the SDK ships. An
 * override that is not a native binary gives none, so Claude reads as
 * `unsupported` rather than failing its sandboxed runs.
 */
export const claudeExecutable = () =>
  claudeBinOverridden()
    ? overrideBin(process.env.CLAUDE_BIN?.trim() ?? "")
    : bundledClaude();

/**
 * `ready` when `auth status` on the run's binary exits 0, `logged_out` when
 * it says no account; `unsupported` when there is no binary a run could
 * spawn. It runs with the env a light run gets, so a token the bot's env
 * carries counts the same way a run would use it. It confirms a login is
 * present, not that it still works: a revoked token reads as ready.
 * `_installed` is the PATH `claude` that made the provider count as
 * installed; it is never run.
 */
export const claudeAvailability = async (
  _installed: string,
  signal?: AbortSignal
): Promise<ProviderAvailability> => {
  const bin = claudeExecutable();
  if (bin === undefined) {
    return "unsupported";
  }
  try {
    const proc = spawn({
      cmd: [bin, "auth", "status"],
      env: minimalEnv("claude"),
      signal,
      stderr: "ignore",
      stdout: "ignore",
    });
    return (await proc.exited) === 0 ? "ready" : "logged_out";
  } catch {
    return "unsupported";
  }
};
