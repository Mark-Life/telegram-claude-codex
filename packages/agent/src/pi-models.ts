import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";
import { Effect, Option, Schema } from "effect";

import {
  piAgentDir,
  piBin,
  piDefaultModel,
  PI_FIXED_ENV,
  readText,
} from "./pi-account";
import { piLog } from "./pi-log";
import { listPiModels } from "./pi-rpc";
import {
  openPiSandbox,
  PI_HELPER_ACCESS,
  piReachOf,
  piRequestUrl,
  readStoredCredentials,
} from "./pi-sandbox";
import type { PiModelReach } from "./pi-sandbox";
import { runEnv } from "./run-env";
import { LIGHT_ACCESS, OWNER_ACCESS, ROUTED_EFFORTS } from "./types";
import type { RoutedEffort } from "./types";

/**
 * The models pi can run here, as the bot offers them. pi lists them itself
 * (RPC `get_available_models` on a throwaway child, about 0.4 s), but it
 * counts a provider whose key is a `!command` as configured without running
 * the command, so a provider with no working key is listed anyway. The bot
 * runs each such command once per read, as pi would, and leaves out every
 * provider whose credential resolves to nothing. Light runs and helper turns
 * hand pi the minimal env, with no provider key in it, inside the bwrap view
 * when the host has one, so a key is checked for them the same way: in that
 * env, and a `!command` in that view. A model whose key works only in the
 * owner's setting is kept for the owner and marked off for them (`light`).
 * A model whose requests go to a local endpoint (`piReachOf` on
 * `piRequestUrl`, the check a run start makes), to a URL that check cannot
 * read, or whose stored credential moves its endpoint or cannot be read, is
 * left out for everybody: local models are switched off for now. The list lives
 * in memory and is read again in the background when `/model` opens and by
 * the bot's periodic pass; a press carries the list's version, a hash of
 * its ids, so a press on an older list is refused rather than read against
 * a new one.
 */

/** One model as the bot offers it. */
export interface PiModel {
  /** `provider/id`, the value a run is started with. */
  readonly key: string;
  readonly name: string;
  readonly provider: string;
  /**
   * Whether light runs and helper turns can run it: its key and headers
   * resolve in the minimal env they hand pi and in their view, not only in
   * the owner's setting.
   */
  readonly light: boolean;
  /**
   * The router's levels pi can set on it; empty when it has no thinking
   * setting at all.
   */
  readonly levels: readonly RoutedEffort[];
}

/** The list in hand: its version and the models, in pi's order. */
export interface PiModelList {
  readonly checkedAt: number;
  readonly models: readonly PiModel[];
  readonly version: string;
}

/** A provider with more models than this is never listed model by model. */
export const PI_BIG_PROVIDER = 15;

/** pi waits 10 s for a key command; a list read waits less. */
const KEY_COMMAND_TIMEOUT_MS = 3000;
/** A whole read gives up after this, so a refresh always ends. */
const READ_TIMEOUT_MS = 20_000;
/** How long a screen waits for a first list before it shows what it has. */
const FIRST_LOAD_WAIT_MS = 3000;

const RpcModel = Schema.Struct({
  api: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  id: Schema.String,
  name: Schema.optional(Schema.String),
  provider: Schema.String,
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(
    Schema.Record(Schema.String, Schema.NullOr(Schema.String))
  ),
});

const decodeModel = Schema.decodeUnknownOption(RpcModel);

/** `models.json`: each provider's key, as configured. */
const decodeModelsFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      providers: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            apiKey: Schema.optional(Schema.String),
            headers: Schema.optional(
              Schema.Record(Schema.String, Schema.String)
            ),
            models: Schema.optional(Schema.Array(Schema.Unknown)),
          })
        )
      ),
    })
  )
);

/** `auth.json`: a stored key, or an OAuth login, per provider. */
const decodeAuthFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        key: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
      })
    )
  )
);

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      enabledModels: Schema.optional(Schema.Array(Schema.String)),
    })
  )
);

const agentFile = (name: string) => readText(path.join(piAgentDir(), name));

const modelsFile = () =>
  Option.getOrUndefined(decodeModelsFile(agentFile("models.json")));

/** The env a run with full access hands pi; a key command runs in it too. */
const ownerEnv = () => ({
  ...runEnv({ access: OWNER_ACCESS, granted: OWNER_ACCESS, provider: "pi" }),
  ...PI_FIXED_ENV,
});

/** The env a light run or a helper turn hands pi: no provider key in it. */
const lightEnv = () => ({
  ...runEnv({ access: LIGHT_ACCESS, granted: LIGHT_ACCESS, provider: "pi" }),
  ...PI_FIXED_ENV,
});

/**
 * The levels pi runs a model at, as its `getSupportedThinkingLevels` says:
 * a level mapped to `null` is off, and `xhigh` is on only when the model's
 * `thinkingLevelMap` names it (pi clamps an unnamed one down to `high`).
 */
const levelsOf = (model: typeof RpcModel.Type): readonly RoutedEffort[] => {
  if (model.reasoning !== true) {
    return [];
  }
  const map = model.thinkingLevelMap;
  return ROUTED_EFFORTS.filter((level) =>
    level === "xhigh"
      ? map?.[level] !== undefined && map[level] !== null
      : map?.[level] !== null
  );
};

const ENV_RE = /\$\{?(?<name>[A-Za-z_][A-Za-z0-9_]*)\}?/gu;

/** Kill a detached command and everything it started; gone is fine. */
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited.
  }
};

/** Whether `stdout` carries something before it closes, read to the end. */
const printsSomething = async (stdout: ReadableStream<Uint8Array>) => {
  let printed = false;
  // The value is read only to be measured; it is never kept or logged.
  for await (const chunk of stdout) {
    printed ||= new TextDecoder().decode(chunk).trim().length > 0;
  }
  return printed;
};

/**
 * Where a key resolves: the env pi gets, and for a `!command` the view pi
 * runs in (`wrap`), or the host when it runs unwrapped.
 */
interface KeyShell {
  readonly env: Record<string, string>;
  readonly wrap?: (command: readonly string[]) => string[];
}

/**
 * Whether a command prints something, run as pi runs it: `sh -c`, stdin
 * closed, in `shell`. It runs in a process group of its own, so on the
 * deadline the whole group is killed, and the answer never waits past it: a
 * child that left the group could still hold the pipe open.
 */
const commandPrints = async (command: string, shell: KeyShell) => {
  const cmd = ["/bin/sh", "-c", command];
  let proc: ReturnType<typeof spawn<"ignore", "pipe", "ignore">>;
  try {
    proc = spawn({
      cmd: shell.wrap?.(cmd) ?? cmd,
      detached: true,
      env: shell.env,
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
    });
  } catch {
    return false;
  }
  const { pid, stdout } = proc;
  const deadline = Promise.withResolvers<false>();
  const timer = setTimeout(() => {
    killGroup(pid);
    deadline.resolve(false);
  }, KEY_COMMAND_TIMEOUT_MS);
  const answer = (async () => {
    try {
      const printed = await printsSomething(stdout);
      return (await proc.exited) === 0 && printed;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([answer, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Whether a configured key or header resolves to something: a `!command`
 * prints a value, a template's `$NAME`s are all set, a literal is not empty.
 */
const resolves = async (value: string, shell: KeyShell) => {
  if (value.startsWith("!")) {
    return await commandPrints(value.slice(1), shell);
  }
  const names = [...value.matchAll(ENV_RE)].map(
    (match) => match.groups?.name ?? ""
  );
  return (
    names.every((name) => (shell.env[name] ?? "").length > 0) && value !== ""
  );
};

/**
 * Who a provider's key works for: every run, the owner's runs alone (it
 * resolves only in the owner's setting), or nobody.
 */
type KeyReach = "all" | "none" | "owner";

/** Narrowest first, so the smaller index of two reaches is their meet. */
const REACH_ORDER: readonly KeyReach[] = ["none", "owner", "all"];

const narrower = (a: KeyReach, b: KeyReach) =>
  REACH_ORDER.indexOf(a) <= REACH_ORDER.indexOf(b) ? a : b;

/** Where light runs resolve a key, and where the owner's do. */
interface KeyShells {
  readonly light: KeyShell;
  readonly owner: KeyShell;
}

/** Who `values` all resolve for: light first, then the owner. */
const valuesReach = async (
  values: readonly string[],
  shells: KeyShells
): Promise<KeyReach> => {
  const every = async (shell: KeyShell) => {
    const found = await Promise.all(
      values.map(async (value) => await resolves(value, shell))
    );
    return found.every(Boolean);
  };
  if (await every(shells.light)) {
    return "all";
  }
  return (await every(shells.owner)) ? "owner" : "none";
};

/**
 * Run `use` with the light shell: the minimal env, and the `none` view a
 * helper turn gets (pi's agent files bound, a scratch dir of its own) when
 * the host has `bwrap`; else the host, where light runs go unwrapped too.
 */
const withLightShell = async <A>(use: (shell: KeyShell) => Promise<A>) => {
  const bin = piBin();
  const scratch = mkdtempSync(path.join(tmpdir(), "pi-key-check-"));
  try {
    const sandbox =
      bin === undefined
        ? undefined
        : await openPiSandbox({
            access: PI_HELPER_ACCESS,
            bin,
            workingDirectory: scratch,
          });
    try {
      return await use({
        env: { ...lightEnv(), ...sandbox?.env },
        wrap: sandbox?.wrap,
      });
    } finally {
      sandbox?.close();
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

/**
 * Per provider pi listed, who its key works for, in pi's order: a key in
 * `auth.json` (an OAuth login counts), then `models.json`'s `apiKey`, each
 * resolved in the light setting first, then in the owner's, and narrowed by
 * the provider's `models.json` headers, resolved the same way. A provider
 * with no key was listed for one pi found in the env it read, so it works
 * for light runs only when pi lists it in theirs too (`lightListed`).
 */
const keyedProviders = async (input: {
  lightListed: ReadonlySet<string>;
  providers: ReadonlySet<string>;
}) => {
  const auth = Option.getOrUndefined(decodeAuthFile(agentFile("auth.json")));
  const custom = modelsFile()?.providers;
  return await withLightShell(async (light) => {
    const shells: KeyShells = { light, owner: { env: ownerEnv() } };
    const keyReach = async (provider: string): Promise<KeyReach> => {
      const stored = auth?.[provider];
      if (stored !== undefined && stored.type !== "api_key") {
        return "all";
      }
      const key = stored?.key ?? custom?.[provider]?.apiKey;
      if (key === undefined) {
        return input.lightListed.has(provider) ? "all" : "owner";
      }
      return await valuesReach([key], shells);
    };
    const reachOf = async (provider: string) => {
      const headers = Object.values(custom?.[provider]?.headers ?? {});
      const [key, header] = await Promise.all([
        keyReach(provider),
        valuesReach(headers, shells),
      ]);
      return narrower(key, header);
    };
    const checks = [...input.providers].map(
      async (provider) => [provider, await reachOf(provider)] as const
    );
    return new Map(await Promise.all(checks));
  });
};

/** The models pi lists in `env`, read on a throwaway child with nothing loaded. */
const listModels = async (env: Record<string, string>) => {
  const bin = piBin();
  if (bin === undefined) {
    throw new Error("pi CLI not found");
  }
  const listed = await listPiModels({ bin, env });
  return listed.flatMap((raw) => Option.toArray(decodeModel(raw)));
};

const VERSION_RADIX = 36;
/** Enough to tell two lists apart; short enough for any callback. */
const VERSION_CHARS = 6;

/** A short, stable version of a list: the same models, the same version. */
const versionOf = (models: readonly PiModel[]) =>
  Bun.hash(models.map((model) => model.key).join("\n"))
    .toString(VERSION_RADIX)
    .slice(0, VERSION_CHARS);

/** The providers whose key reach is `reach`. */
const reaching = (keyed: ReadonlyMap<string, KeyReach>, reach: KeyReach) =>
  [...keyed].flatMap(([name, found]) => (found === reach ? [name] : []));

/** The models of the last read left out (`PI_LEFT_OUT`), lowercased. */
let localKeys: ReadonlySet<string> = new Set();

/**
 * The reaches the list leaves a model out for, and that take pi's default
 * off: known to be local, a URL the check cannot read (`unusable`), or a
 * credential that moves it or cannot be read. `unresolved` stays listed: a
 * name that does not resolve (DNS down, at boot say) is not known to be
 * local; a run on it is refused at its start.
 */
export const PI_LEFT_OUT = new Set<PiModelReach["kind"]>([
  "local",
  "moved",
  "unreadable",
  "unusable",
]);

/**
 * `listed`, each with its `PiModelReach` in the owner's env (`auth.json`
 * read once, each URL looked up once), without the models whose requests
 * go to a local endpoint or a URL the check cannot read, or whose
 * credential moves it or cannot be read (`PI_LEFT_OUT`);
 * they go to `localKeys`, and to the log.
 */
const withoutLocal = async (listed: readonly (typeof RpcModel.Type)[]) => {
  const env = ownerEnv();
  const stored = readStoredCredentials();
  const byUrl = new Map<string | undefined, Promise<PiModelReach>>();
  const reachOf = async (model: typeof RpcModel.Type) => {
    const request = piRequestUrl({ env, model, stored });
    if (request.kind !== "url") {
      return await piReachOf(request);
    }
    const known = byUrl.get(request.url) ?? piReachOf(request);
    byUrl.set(request.url, known);
    return await known;
  };
  const judged = await Promise.all(
    listed.map(async (model) => ({ model, reach: await reachOf(model) }))
  );
  const keys = judged.flatMap(({ model, reach }) =>
    PI_LEFT_OUT.has(reach.kind) ? [`${model.provider}/${model.id}`] : []
  );
  localKeys = new Set(keys.map((key) => key.toLowerCase()));
  if (keys.length > 0) {
    piLog(
      Effect.logInfo(
        "pi models left out (local endpoint, or one the check cannot read)",
        {
          models: keys,
        }
      )
    );
  }
  return judged.flatMap(({ model, reach }) =>
    PI_LEFT_OUT.has(reach.kind) ? [] : [model]
  );
};

/**
 * Read pi's list, in the owner's env and in the light one at once, and keep
 * only the models whose provider has a key and whose endpoint is not local.
 */
const readList = async (): Promise<PiModelList> => {
  const [all, lightListed] = await Promise.all([
    listModels(ownerEnv()),
    listModels(lightEnv()),
  ]);
  const listed = await withoutLocal(all);
  const keyed = await keyedProviders({
    lightListed: new Set(lightListed.map((model) => model.provider)),
    providers: new Set(listed.map((model) => model.provider)),
  });
  const dropped = reaching(keyed, "none");
  if (dropped.length > 0) {
    piLog(
      Effect.logInfo("pi providers without a working key left out", {
        providers: dropped,
      })
    );
  }
  const ownerOnly = reaching(keyed, "owner");
  if (ownerOnly.length > 0) {
    piLog(
      Effect.logInfo("pi providers keyed by the owner's env only", {
        providers: ownerOnly,
      })
    );
  }
  const models = listed.flatMap((model) => {
    const key = keyed.get(model.provider) ?? "none";
    return key === "none"
      ? []
      : [
          {
            key: `${model.provider}/${model.id}`,
            levels: levelsOf(model),
            light: key === "all",
            name: model.name ?? model.id,
            provider: model.provider,
          },
        ];
  });
  return { checkedAt: Date.now(), models, version: versionOf(models) };
};

const EMPTY: PiModelList = { checkedAt: 0, models: [], version: "0" };

let current = EMPTY;
let inFlight: Promise<void> | undefined;

/** The list in hand; empty until the first read lands. */
export const piModelList = () => current;

/** `work`, or a rejection once `ms` pass; the timer never outlives it. */
const withDeadline = async <A>(work: Promise<A>, ms: number) => {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    deadline.reject(new Error(`pi model list read took over ${ms} ms`));
  }, ms);
  try {
    return await Promise.race([work, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Read the list again when the one in hand is older than `maxAgeMs`. A
 * failed or overlong read keeps the last good list. Never rejects and always
 * ends; a second call while one runs waits for it.
 */
export const refreshPiModels = async ({ maxAgeMs }: { maxAgeMs: number }) => {
  if (Date.now() - current.checkedAt < maxAgeMs) {
    return;
  }
  inFlight ??= (async () => {
    try {
      current = await withDeadline(readList(), READ_TIMEOUT_MS);
      piLog(
        Effect.log("pi.models refreshed", { count: current.models.length })
      );
    } catch (error) {
      piLog(
        Effect.logWarning("pi.models refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      inFlight = undefined;
    }
  })();
  await inFlight;
};

/**
 * The list, read first when none ever arrived. A screen waits for that read
 * at most `FIRST_LOAD_WAIT_MS`, then takes what is in hand, maybe nothing;
 * the read goes on and the next screen gets it.
 */
export const loadPiModels = async () => {
  if (current.models.length === 0) {
    const read = refreshPiModels({ maxAgeMs: 0 });
    const wait = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => {
      wait.resolve();
    }, FIRST_LOAD_WAIT_MS);
    await Promise.race([read, wait.promise]);
    clearTimeout(timer);
  }
  return current;
};

/** The model a `provider/id` names on the list; case is ignored. */
export const findPiModel = (list: PiModelList, key: string | undefined) => {
  const wanted = key?.toLowerCase();
  return list.models.find((model) => model.key.toLowerCase() === wanted);
};

/**
 * The part of `list` light runs and helper turns can run, versioned on its
 * own, so its buttons index into it alone.
 */
export const piLightList = (list: PiModelList): PiModelList => {
  const models = list.models.filter((model) => model.light);
  return models.length === list.models.length
    ? list
    : { checkedAt: list.checkedAt, models, version: versionOf(models) };
};

/**
 * Whether light runs and helper turns can run `key`: false when the list in
 * hand has it and its key comes from the owner's env alone, or when the last
 * read left it out for a local endpoint. Another model the list lacks is not
 * refused here; the run's start checks it.
 */
export const piRunsLight = (key: string) =>
  !localKeys.has(key.toLowerCase()) &&
  findPiModel(current, key)?.light !== false;

/**
 * What light runs and helper turns run on: the first of `named` (the
 * owner's pick in `/settings`), `PI_LIGHT_MODEL` and pi's default that they
 * can run (`piRunsLight`), so a local one is skipped. Undefined when none
 * can.
 */
export const piLightModel = (named?: string) =>
  [named, process.env.PI_LIGHT_MODEL?.trim(), piDefaultModel()].find(
    (key): key is string =>
      key !== undefined && key.length > 0 && piRunsLight(key)
  );

/** pi's thinking levels, which a pattern in `enabledModels` may end in. */
const THINKING_SUFFIX_RE = /:(?:off|minimal|low|medium|high|xhigh|max)$/iu;

const SPECIAL_RE = /[.+?^${}()|[\]\\]/gu;

/** A pattern of `enabledModels` as a test on `provider/id` or the bare id. */
const patternTest = (raw: string) => {
  const pattern = raw.replace(THINKING_SUFFIX_RE, "").toLowerCase();
  if (!pattern.includes("*")) {
    return (model: PiModel) =>
      model.key.toLowerCase() === pattern ||
      model.key.slice(model.provider.length + 1).toLowerCase() === pattern;
  }
  const re = new RegExp(
    `^${pattern.replaceAll(SPECIAL_RE, String.raw`\$&`).replaceAll("*", ".*")}$`,
    "u"
  );
  return (model: PiModel) =>
    re.test(model.key.toLowerCase()) ||
    re.test(model.key.slice(model.provider.length + 1).toLowerCase());
};

/**
 * The owner's favourites: pi's own `enabledModels` (its Ctrl+P scope), each
 * pattern matched against the list, in the order the patterns come.
 */
export const piFavourites = (list: PiModelList): readonly PiModel[] => {
  const patterns =
    Option.getOrUndefined(decodeSettings(agentFile("settings.json")))
      ?.enabledModels ?? [];
  const tests = patterns.map(patternTest);
  return tests.flatMap((test) => list.models.filter(test));
};

/**
 * The models of the providers `models.json` defines that are small enough
 * to show whole, in pi's order.
 */
export const piCustomModels = (list: PiModelList): readonly PiModel[] => {
  const custom = new Set(Object.keys(modelsFile()?.providers ?? {}));
  return list.models.filter(
    (model) =>
      custom.has(model.provider) &&
      list.models.filter((other) => other.provider === model.provider).length <=
        PI_BIG_PROVIDER
  );
};

/**
 * The models every whitespace-separated word of `query` is part of, in the
 * `provider/id` or the display name; case is ignored.
 */
export const searchPiModels = (list: PiModelList, query: string) => {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return list.models.filter((model) => {
    const haystack = `${model.key} ${model.name}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
};

/**
 * The one model `text` names outright: its `provider/id`, or an id only one
 * provider lists.
 */
export const exactPiModel = (list: PiModelList, text: string) => {
  const full = findPiModel(list, text.trim());
  if (full !== undefined) {
    return full;
  }
  const bare = text.trim().toLowerCase();
  const matches = list.models.filter(
    (model) => model.key.slice(model.provider.length + 1).toLowerCase() === bare
  );
  return matches.length === 1 ? matches[0] : undefined;
};
