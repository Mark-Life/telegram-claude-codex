import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { spawn, which } from "bun";
import { Effect, Option, Schema } from "effect";

import { piLog } from "./pi-log";
import { inheritEnv } from "./run-env";
import type { ProviderAvailability } from "./types";

/**
 * pi as the bot sees it before a run: where its CLI and its agent dir are,
 * which model it answers on, how a child is started, and whether the account
 * is ready. pi is installed by its own managed installer, pinned at 1.6.x:
 * `~/.pi/agent/bin/pi`, a launcher that execs the release it names.
 */

/** The bare name of pi's CLI. */
export const PI_COMMAND = "pi";

/**
 * Where a user-scoped pi lands, highest priority first: the managed
 * installer's launcher, then the usual user bin dirs.
 */
export const PI_HOME_BIN_DIRS = [
  ".pi/agent/bin",
  ".local/bin",
  "bin",
  ".bun/bin",
] as const;

/** The release the bot was checked against; boot warns outside its minor. */
export const PI_PINNED_VERSION = "1.6.0";
const PINNED_MINOR = "1.6.";

/**
 * What every pi child runs with: no package installs or catalog fetches at
 * startup, no install telemetry or attribution headers, no version check,
 * and no Bedrock endpoint from `~/.aws/config` (`endpoint_url`), which
 * would move a model past the `baseUrl` the local-model check reads.
 */
export const PI_FIXED_ENV = {
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
} as const;

/** pi's agent dir: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export const piAgentDir = () =>
  process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      defaultModel: Schema.optional(Schema.String),
      defaultProvider: Schema.optional(Schema.String),
    })
  )
);

/** A small config file's text; undefined when it cannot be read. */
export const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
};

/**
 * The model pi runs on, as `provider/id`: `PI_DEFAULT_MODEL`, else the
 * default in pi's own `settings.json`. Undefined leaves pi unavailable.
 */
export const piDefaultModel = () => {
  const set = process.env.PI_DEFAULT_MODEL?.trim() ?? "";
  if (set.length > 0) {
    return set;
  }
  const settings = Option.getOrUndefined(
    decodeSettings(readText(path.join(piAgentDir(), "settings.json")))
  );
  return settings?.defaultProvider !== undefined &&
    settings.defaultModel !== undefined
    ? `${settings.defaultProvider}/${settings.defaultModel}`
    : undefined;
};

/**
 * `provider/id` split at its first slash: the id may hold more of them
 * (`openrouter/z-ai/glm-5.2`). Undefined when either half is empty.
 */
export const splitPiModel = (model: string) => {
  const at = model.indexOf("/");
  return at > 0 && at < model.length - 1
    ? { id: model.slice(at + 1), provider: model.slice(0, at) }
    : undefined;
};

const isExecutable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The CLI runs start, found as the host found it at boot: `PI_BIN`, else
 * PATH, else the home bin dirs. Always an absolute path, since a view
 * resolves it outside PATH: a bare `PI_BIN` is looked up on PATH here.
 * Undefined when pi is not installed.
 */
export const piBin = () => {
  const set = process.env.PI_BIN?.trim() ?? "";
  if (set.length > 0) {
    return set.includes("/") ? path.resolve(set) : (which(set) ?? undefined);
  }
  return (
    which(PI_COMMAND) ??
    PI_HOME_BIN_DIRS.map((dir) => path.join(homedir(), dir, PI_COMMAND)).find(
      isExecutable
    )
  );
};

/** The managed launcher reads the version it runs from this file. */
const MANAGED_MARKER = "install/current-version";

/** The outermost `node_modules` holding `file`, which carries its deps. */
const packagesRoot = (file: string) => {
  const parts = file.split(path.sep);
  const at = parts.indexOf("node_modules");
  return at > 0 ? parts.slice(0, at + 1).join(path.sep) : path.dirname(file);
};

/** The node the managed release runs on: the installer's own, else PATH's. */
const nodeBin = () => {
  const data =
    process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
  const managed = path.join(data, "pi-node", "current", "bin", "node");
  const found = isExecutable(managed)
    ? managed
    : (which("node") ?? process.execPath);
  return realpathSync(found);
};

/**
 * What a view binds back for node: the resolved binary alone, when it sits
 * under the emptied home dir. Never a dir around it: that can be `~/.local`
 * or the home dir itself (`~/bin/node`), and node needs nothing beside it.
 */
const nodeFiles = (node: string) =>
  node.startsWith(`${homedir()}${path.sep}`) ? [node] : [];

/**
 * How a pi child starts without its launcher, and what a bwrap view binds
 * read-only for it: the release the managed launcher names, on node, else
 * the real file `bin` points at, with the `node_modules` around it. The
 * launcher itself sits in the agent dir, which a view hides.
 */
export const piLaunch = (bin: string) => {
  const real = realpathSync(bin);
  const agentDir = path.dirname(path.dirname(real));
  const version = readText(path.join(agentDir, MANAGED_MARKER))?.trim();
  if (version === undefined || version.length === 0) {
    return { argv: [real], readOnly: [packagesRoot(real)] };
  }
  const release = path.join(agentDir, "install", "releases", version);
  const entry = realpathSync(
    path.join(release, "node_modules", ".bin", PI_COMMAND)
  );
  const node = nodeBin();
  return { argv: [node, entry], readOnly: [release, ...nodeFiles(node)] };
};

/**
 * The env a check runs with: the owner's runs', plus pi's fixed names, so a
 * key pi reads from a variable (`$OPENROUTER_API_KEY` in `models.json`, or
 * a built-in provider's own) counts as it does for those runs.
 */
export const piCheckEnv = () => ({ ...inheritEnv("pi"), ...PI_FIXED_ENV });

const warned = new Set<string>();

/** Warn once per version that pi is outside the minor the bot was checked on. */
const checkVersion = async (bin: string, signal?: AbortSignal) => {
  const proc = spawn({
    cmd: [bin, "--version"],
    env: piCheckEnv(),
    signal,
    stderr: "ignore",
    stdout: "pipe",
  });
  const printed = await new Response(proc.stdout).text();
  const version = printed.trim();
  if ((await proc.exited) !== 0) {
    return false;
  }
  if (!version.startsWith(PINNED_MINOR) && !warned.has(version)) {
    warned.add(version);
    piLog(
      Effect.logWarning("pi version outside the pinned 1.6.x; runs may break", {
        version,
      })
    );
  }
  return true;
};

/**
 * `ready` when pi has a model to run and `auth check` finds its credentials,
 * `logged_out` when there is no model or no credentials, `missing` when the
 * CLI does not start. The check never refreshes an OAuth login and never
 * prints a credential.
 */
export const piAvailability = async (
  bin: string,
  signal?: AbortSignal
): Promise<ProviderAvailability> => {
  try {
    if (!(await checkVersion(bin, signal))) {
      return "missing";
    }
    const model = splitPiModel(piDefaultModel() ?? "");
    if (model === undefined) {
      return "logged_out";
    }
    const proc = spawn({
      cmd: [
        bin,
        "auth",
        "check",
        "--provider",
        model.provider,
        "--model",
        model.id,
        "--json",
        "--no-refresh",
      ],
      env: piCheckEnv(),
      signal,
      stderr: "ignore",
      stdout: "ignore",
    });
    return (await proc.exited) === 0 ? "ready" : "logged_out";
  } catch {
    return "missing";
  }
};
