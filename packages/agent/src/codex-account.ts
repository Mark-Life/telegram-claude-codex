import { spawn } from "bun";

import type { DeviceLogin, ProviderAvailability } from "./types";

/**
 * The Codex account as the bot sees it: `codex login status` says whether this
 * host can run, and `codex login --device-auth` connects it from the phone,
 * leaving the credentials in `~/.codex/auth.json` for the next run. Both spawn
 * the CLI the host resolved at boot; runs never do, the SDK carries its own
 * binary.
 */

/** The bare name of the Codex CLI. */
export const CODEX_COMMAND = "codex";

/**
 * Where a user-scoped Codex install lands, highest priority first: the
 * directories `~/.zshrc` prepends, plus Codex's own standalone install.
 */
export const CODEX_HOME_BIN_DIRS = [
  ".local/bin",
  "bin",
  ".bun/bin",
  ".codex/bin",
] as const;

/**
 * `ready` when `codex login status` exits 0; `missing` when it cannot spawn.
 * `signal` kills a check that hangs.
 */
export const codexAvailability = async (
  bin: string,
  signal?: AbortSignal
): Promise<ProviderAvailability> => {
  try {
    const proc = spawn({
      cmd: [bin, "login", "status"],
      signal,
      stderr: "ignore",
      stdout: "ignore",
    });
    return (await proc.exited) === 0 ? "ready" : "logged_out";
  } catch {
    return "missing";
  }
};

/** Run `codex login status` and report what it said. */
const loginStatus = async (bin: string) => {
  try {
    const proc = spawn({
      cmd: [bin, "login", "status"],
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, output: `${stdout}\n${stderr}`.trim() };
  } catch {
    return { exitCode: -1, output: "" };
  }
};

/** The device flow behind `/login`. */
export const codexDeviceLogin: DeviceLogin = {
  start: (bin) =>
    spawn({
      cmd: [bin, "login", "--device-auth"],
      stderr: "pipe",
      stdout: "pipe",
    }),
  status: loginStatus,
};
