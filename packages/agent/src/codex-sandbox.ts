import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderCrashed } from "./errors";
import type { GroupMemoryChat, StdioCommand } from "./group-memory-server";
import { openRunView } from "./run-view";
import { sandboxCommand } from "./sandbox/bwrap";
import { codexStateRoots } from "./state-roots";
import type { RunAccess, RunOptions } from "./types";

/**
 * A Codex child inside the bwrap view. The SDK (helper turns, compaction)
 * and a run's `codex app-server` launch both spawn `codexPathOverride` with
 * the env they were given, so the override is `sandbox/exec.sh` and the
 * view rides `BOT_SANDBOX_ARGV`. The view holds the vendored Codex the SDK
 * would have run, the real `auth.json` read-write, and an empty `~/.codex`
 * otherwise: every rollout of every user lives in `~/.codex/sessions`, so a
 * run in the view starts fresh and keeps no session. With `socat` on the host
 * the view has its own network and reaches only `CODEX_HOSTS`.
 */

const WRAPPER = fileURLToPath(new URL("sandbox/exec.sh", import.meta.url));

/** The variable `exec.sh` reads the view from. */
const SANDBOX_ARGV_ENV = "BOT_SANDBOX_ARGV";

/**
 * The SDK's vendored package per platform and CPU, as its own lookup names
 * them. Runs use the binary on macOS too; the view needs Linux anyway.
 */
const VENDORED_TARGETS = {
  darwin: {
    arm64: {
      package: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
    },
    x64: { package: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" },
  },
  linux: {
    arm64: {
      package: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
    },
    x64: {
      package: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
    },
  },
} as const;

const targetOf = (platform: string, arch: string) => {
  const byArch =
    platform === "darwin" || platform === "linux"
      ? VENDORED_TARGETS[platform]
      : undefined;
  return byArch !== undefined && (arch === "arm64" || arch === "x64")
    ? byArch[arch]
    : undefined;
};

/**
 * The Codex binary the SDK runs when it is given no path, found the way the
 * SDK finds it: `@openai/codex` next to the SDK, then its platform package.
 * `pathDirs` are the helper dirs the SDK puts first on `PATH`.
 */
export const vendoredCodex = () => {
  const { arch, platform } = process;
  const target = targetOf(platform, arch);
  if (target === undefined) {
    throw new ProviderCrashed({
      message: `No vendored Codex for ${platform}/${arch}`,
    });
  }
  const fromSdk = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const codexPackage = fromSdk.resolve("@openai/codex/package.json");
  const platformPackage = createRequire(codexPackage).resolve(
    `${target.package}/package.json`
  );
  const root = realpathSync(
    path.join(path.dirname(platformPackage), "vendor", target.triple)
  );
  const layouts = [
    { bin: path.join(root, "bin", "codex"), dirs: ["codex-path"] },
    { bin: path.join(root, "codex", "codex"), dirs: ["path"] },
  ];
  const found = layouts.find((layout) => existsSync(layout.bin));
  if (found === undefined) {
    throw new ProviderCrashed({ message: `No Codex binary under ${root}` });
  }
  return {
    bin: found.bin,
    pathDirs: found.dirs
      .map((dir) => path.join(root, dir))
      .filter((dir) => existsSync(dir)),
    root,
  };
};

/**
 * The Codex binary runs use, the one this build's protocol was written
 * against, whatever `codex` is on PATH; undefined off Linux and macOS, or
 * when the vendored package is missing.
 */
export const vendoredCodexBin = (): string | undefined => {
  try {
    return vendoredCodex().bin;
  } catch {
    return undefined;
  }
};

/**
 * What Codex itself talks to: the API, the ChatGPT backend and the login
 * refresh. Web search runs on OpenAI's side, so a view needs no web hosts,
 * and Codex's own sandbox keeps the model's shell offline inside it anyway.
 */
const CODEX_HOSTS = ["api.openai.com", "auth.openai.com", "chatgpt.com"];

/** The real credentials file, bound read-write so a token refresh lands. */
const authBinds = () =>
  codexStateRoots()
    .map((root) => path.join(root, "auth.json"))
    .filter((file) => existsSync(file))
    .map((file) => ({ source: file, target: file }));

/** Every argument rides one line of `BOT_SANDBOX_ARGV`. */
const joinArgv = (argv: readonly string[]) => {
  if (argv.some((arg) => arg.length === 0 || arg.includes("\n"))) {
    throw new ProviderCrashed({
      message: "A sandbox argument is empty or spans lines",
    });
  }
  return argv.join("\n");
};

/** What a run inside the view adds to its Codex options. */
export interface CodexSandbox {
  close: () => void;
  codexPathOverride: string;
  env: Record<string, string>;
  /** The `group_memory` server through the relay; absent when not wired. */
  groupMemory?: StdioCommand;
  /**
   * The working directory as the view binds it, symlinks resolved. Codex gets
   * this one as `--cd`: the caller's spelling may run through a symlink in a
   * tree the view empties.
   */
  workingDirectory: string;
}

/** A run's options with the project dir the view binds, when it has one. */
export const inView = (opts: RunOptions, sandbox: CodexSandbox | undefined) =>
  sandbox === undefined
    ? opts
    : { ...opts, projectDir: sandbox.workingDirectory };

/**
 * Open the view of one Codex child, or undefined when it runs unwrapped: full
 * access, or no `bwrap` on this host, where Codex's own sandbox is the only
 * one, as before. `groupMemory` starts the chat's memory server outside the
 * view; `close` stops it and the network proxy once the child is gone.
 */
export const openCodexSandbox = async (input: {
  access: RunAccess;
  groupMemory?: GroupMemoryChat;
  workingDirectory: string;
}): Promise<CodexSandbox | undefined> => {
  const run = await openRunView({ ...input, hosts: CODEX_HOSTS });
  if (run === undefined) {
    return undefined;
  }
  try {
    const codex = vendoredCodex();
    const view = run.view({ readOnly: [codex.root], readWrite: authBinds() });
    const argv = sandboxCommand({
      bwrap: run.bwrap,
      command: run.command([codex.bin]),
      posture: run.posture,
      view,
    });
    const sandbox: CodexSandbox = {
      close: run.close,
      codexPathOverride: WRAPPER,
      env: {
        PATH: [...codex.pathDirs, process.env.PATH ?? ""].join(path.delimiter),
        [SANDBOX_ARGV_ENV]: joinArgv(argv),
        ...run.env,
      },
      workingDirectory: view.cwd,
    };
    if (run.groupMemory !== undefined) {
      sandbox.groupMemory = run.groupMemory;
    }
    return sandbox;
  } catch (error) {
    run.close();
    throw error;
  }
};
