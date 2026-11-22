import path from "node:path";

import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import { Predicate } from "effect";

import type { AppServerLaunch } from "./codex-app-server";
import { vendoredCodex } from "./codex-sandbox";

/**
 * How a run's `codex app-server` starts, built from the same `CodexOptions`
 * and `ThreadOptions` the SDK turned into a `codex exec` command line, so
 * the move changes no setting. Config rides `-c` flags flattened exactly as
 * the SDK flattens them; what `codex exec` took as flags of its own (model,
 * sandbox, working directory) goes on `thread/start` or `thread/resume`.
 * `skipGitRepoCheck` has no counterpart: only `codex exec` checks for a repo.
 */

/** The originator the SDK reports its children as, kept for the backend. */
const ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const SDK_ORIGINATOR = "codex_sdk_ts";

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/u;

type ConfigValue = NonNullable<CodexOptions["config"]>[string];

type ConfigTable = Readonly<Record<string, ConfigValue | undefined>>;

const isTable = (
  value: ConfigValue
): value is Readonly<Record<string, ConfigValue>> =>
  Predicate.isObject(value) && !Array.isArray(value);

/** One value as TOML, the way the SDK writes it. */
const toToml = (value: ConfigValue): string => {
  if (Predicate.isString(value)) {
    return JSON.stringify(value);
  }
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(toToml).join(", ")}]`;
  }
  const parts = Object.entries(value).map(
    ([key, child]) =>
      `${TOML_BARE_KEY.test(key) ? key : JSON.stringify(key)} = ${toToml(child)}`
  );
  return `{${parts.join(", ")}}`;
};

/**
 * Config as `key=value` overrides: nested tables become dotted keys, an
 * empty table stays one and an undefined value is left out, as the SDK's
 * `serializeConfigOverrides` does.
 */
const flatten = (table: ConfigTable, prefix = ""): string[] => {
  const entries = Object.entries(table);
  if (prefix.length > 0 && entries.length === 0) {
    return [`${prefix}={}`];
  }
  return entries.flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    const dotted = prefix.length > 0 ? `${prefix}.${key}` : key;
    return isTable(value)
      ? flatten(value, dotted)
      : [`${dotted}=${toToml(value)}`];
  });
};

/** What `thread/start` and `thread/resume` take besides the thread id. */
interface ThreadParams {
  cwd?: string;
  model?: string;
  sandbox?: ThreadOptions["sandboxMode"];
}

/** A run's server and its thread, as `codex.ts` starts them. */
export interface CodexLaunch {
  launch: AppServerLaunch;
  /** Skill roots the server adds to its own once it is up. */
  skillRoots: readonly string[];
  thread: ThreadParams;
}

/**
 * The binary, env and flags of a run's server, and its thread's params. A
 * run in the bwrap view starts through `codexPathOverride`, whose env
 * already puts the vendored helper dirs on `PATH`; otherwise they go first
 * on it, as the SDK puts them.
 */
export const appServerLaunch = (
  options: CodexOptions,
  thread: ThreadOptions,
  skillRoots: readonly string[]
): CodexLaunch => {
  const env = { ...options.env };
  env[ORIGINATOR_ENV] ??= SDK_ORIGINATOR;
  let bin = options.codexPathOverride;
  if (bin === undefined) {
    const vendored = vendoredCodex();
    ({ bin } = vendored);
    if (vendored.pathDirs.length > 0) {
      env.PATH = [...vendored.pathDirs, env.PATH ?? ""]
        .filter((dir) => dir.length > 0)
        .join(path.delimiter);
    }
  }
  // What `codex exec` took as `--config` from `ThreadOptions`; an unset
  // one is left out.
  let webSearch = thread.webSearchMode;
  if (webSearch === undefined && thread.webSearchEnabled !== undefined) {
    webSearch = thread.webSearchEnabled ? "live" : "disabled";
  }
  const config = {
    ...options.config,
    approval_policy: thread.approvalPolicy,
    model_reasoning_effort: thread.modelReasoningEffort,
    web_search: webSearch,
  };
  return {
    launch: {
      args: [
        "app-server",
        ...flatten(config).flatMap((override) => ["--config", override]),
      ],
      bin,
      env,
    },
    skillRoots,
    thread: {
      cwd: thread.workingDirectory,
      model: thread.model,
      sandbox: thread.sandboxMode,
    },
  };
};
