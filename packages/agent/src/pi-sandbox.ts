import { existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { Effect, Option, Schema } from "effect";

import { ProviderCrashed } from "./errors";
import type { GroupMemoryChat, StdioCommand } from "./group-memory-server";
import { piAgentDir, piCheckEnv, piLaunch, readText } from "./pi-account";
import { piLog } from "./pi-log";
import { listPiModels, PI_GATE, PI_MCP } from "./pi-rpc";
import { minimalEnv, piMovesEndpoint } from "./run-env";
import { openRunView } from "./run-view";
import { sandboxCommand } from "./sandbox/bwrap";
import { runsInView } from "./sandbox/host";
import { hostIsLocal } from "./sandbox/net-proxy";
import type { NetEndpoint, NetPolicy } from "./sandbox/net-proxy";
import { LIGHT_ACCESS } from "./types";
import type { RunAccess } from "./types";

/**
 * A pi child inside the bwrap view. pi has no sandbox of its own: `read`,
 * `edit` and `write` run in its process, so the view around the whole child
 * is the boundary. The view holds pi's release, the bot's two extensions and the
 * agent dir's `auth.json`, `models.json`, `models-store.json`,
 * `settings.json` and `.env.local` (which a `!command` key in `models.json`
 * may source), every one read-only: a member's `bash` could otherwise plant
 * a `!command` key or another `baseUrl` that the owner's unwrapped runs then
 * use. So an OAuth login is never refreshed from inside a view, and the
 * run's directory is all a member writes besides the view's own scratch.
 * Like Claude's credentials, these keys are readable by a member's `read`
 * and `bash`; other light runs get no tools. Everything else of the agent
 * dir is gone: no sessions, extensions, skills or `AGENTS.md`. With `socat`
 * the view reaches only the model's own endpoint, and only when it is
 * public. A model on a local endpoint is refused before any child starts,
 * view or not (`piModelReach`): local models are off for every run.
 */

const HostedModel = Schema.Struct({
  api: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  id: Schema.String,
  provider: Schema.String,
});

const decodeHostedModel = Schema.decodeUnknownOption(HostedModel);

/**
 * The agent dir files whose change can add a model or move its `baseUrl`:
 * `models-store.json` is the per-key list pi refreshes on its own.
 */
const URL_SOURCES = [
  "models.json",
  "models-store.json",
  "auth.json",
  "settings.json",
];

/** When those files last changed; a new stamp reads the URLs again. */
const sourcesStamp = () =>
  URL_SOURCES.map((name) => {
    try {
      return statSync(path.join(piAgentDir(), name)).mtimeMs;
    } catch {
      return 0;
    }
  }).join(":");

/**
 * Each listed model by its lowercased `provider/id`, as pi last listed
 * them: pi matches a model's key whatever its case.
 */
let baseUrls:
  | { stamp: string; urls: Map<string, typeof HostedModel.Type> }
  | undefined;

/**
 * `model` as pi lists it, with the `baseUrl` pi runs it on (maybe none),
 * from pi's own list, read again only when the agent dir's config changed.
 * Its key's case does not count, as for pi. Undefined when pi does not list
 * the model; a list that cannot be read leaves the last one in place.
 */
const listedModel = async (
  bin: string,
  model: { id: string; provider: string }
) => {
  const stamp = sourcesStamp();
  if (baseUrls?.stamp !== stamp) {
    try {
      const listed = await listPiModels({ bin, env: piCheckEnv() });
      const urls = new Map(
        listed.flatMap((raw) =>
          Option.toArray(decodeHostedModel(raw)).map(
            (entry) =>
              [`${entry.provider}/${entry.id}`.toLowerCase(), entry] as const
          )
        )
      );
      baseUrls = { stamp, urls };
    } catch (error) {
      piLog(
        Effect.logWarning("pi model list unreadable", {
          reason: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  return baseUrls?.urls.get(`${model.provider}/${model.id}`.toLowerCase());
};

const BRACKETED = /^\[(?<inner>.*)\]$/u;
const TRAILING_DOT = /\.$/u;
/** A host name DNS can look up; `URL` also lets through `{`, `}`, `!` and more. */
const HOST_NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/u;

/** The schemes pi sends a model's requests over, `ws` as `http`. */
const SCHEMES = {
  "http:": { port: 80, tls: false },
  "https:": { port: 443, tls: true },
  "ws:": { port: 80, tls: false },
  "wss:": { port: 443, tls: true },
} as const;

const isScheme = (protocol: string): protocol is keyof typeof SCHEMES =>
  Object.hasOwn(SCHEMES, protocol);

/**
 * A request URL as the proxy names its target: the host unbracketed and
 * lowercased, the port spelled out (`ws` and `wss` on `http`'s and
 * `https`'s). TLS by name must name the host in its ClientHello; plain
 * HTTP and an IP literal carry no name. Undefined when the URL is empty,
 * does not parse, is not `http`, `https`, `ws` or `wss`, or has a host
 * that is neither an IP nor a name DNS can look up (pi's Vertex
 * `{location}` template).
 */
const endpointOf = (url: string | undefined): NetEndpoint | undefined => {
  const parsed = url === undefined ? null : URL.parse(url);
  if (parsed === null || !isScheme(parsed.protocol)) {
    return undefined;
  }
  const scheme = SCHEMES[parsed.protocol];
  const host = parsed.hostname
    .replace(BRACKETED, "$<inner>")
    .replace(TRAILING_DOT, "")
    .toLowerCase();
  const named = isIP(host) === 0;
  if (named && !HOST_NAME.test(host)) {
    return undefined;
  }
  return {
    host,
    port: parsed.port === "" ? scheme.port : Number(parsed.port),
    sni: scheme.tls && named,
  };
};

/**
 * A URL the check cannot read, as a log names it: its scheme and host, never
 * its path or credentials.
 */
const unusableTarget = (url: string | undefined) => {
  if (url === undefined || url.trim() === "") {
    return "none";
  }
  const parsed = URL.parse(url);
  return parsed === null ? "unparseable" : `${parsed.protocol}//${parsed.host}`;
};

const BOM = /^\uFEFF/u;

/** `auth.json` as pi parses it: any JSON object, its entries unchecked. */
const AuthFile = Schema.fromJsonString(Schema.JsonObject);

const decodeAuthFile = Schema.decodeUnknownOption(AuthFile);

/**
 * What the check reads of one credential: its `env`, as pi passes it, and
 * what pi-ai's GitHub Copilot OAuth builds its request URL from.
 */
const StoredEntry = Schema.Struct({
  access: Schema.optional(Schema.Unknown),
  enterpriseUrl: Schema.optional(Schema.Unknown),
  env: Schema.optional(Schema.JsonObject),
  type: Schema.optional(Schema.Unknown),
});

const decodeStoredEntry = Schema.decodeUnknownOption(StoredEntry);

const isString = Schema.is(Schema.String);

/**
 * `auth.json` as pi reads it: a leading BOM stripped, then parsed, each
 * entry read only for its own provider. A missing or empty file holds no
 * credential. `unreadable` when the file is there but cannot be read or
 * parsed into an object: its credentials cannot be checked, so every model
 * is refused.
 */
export type StoredCredentials =
  | { data: typeof Schema.JsonObject.Type; kind: "read" }
  | { kind: "unreadable" };

/** `auth.json` (`StoredCredentials`), read once for every model it judges. */
export const readStoredCredentials = (): StoredCredentials => {
  const file = path.join(piAgentDir(), "auth.json");
  if (!existsSync(file)) {
    return { data: {}, kind: "read" };
  }
  const text = readText(file)?.replace(BOM, "");
  if (text?.trim() === "") {
    return { data: {}, kind: "read" };
  }
  return Option.match(decodeAuthFile(text), {
    onNone: () => ({ kind: "unreadable" }) as const,
    onSome: (data) => ({ data, kind: "read" }) as const,
  });
};

/**
 * The stored credential of `provider`, as pi reads it (its `env` values
 * need not be strings); empty without an entry. None when the entry or its
 * `env` is not an object, or the file is `unreadable`.
 */
const storedEntry = (
  stored: StoredCredentials,
  provider: string
): Option.Option<typeof StoredEntry.Type> => {
  if (stored.kind === "unreadable") {
    return Option.none();
  }
  const entry = Object.hasOwn(stored.data, provider)
    ? stored.data[provider]
    : undefined;
  return entry === undefined ? Option.some({}) : decodeStoredEntry(entry);
};

const PROXY_EP = /proxy-ep=(?<host>[^;]+)/u;
const PROXY_PREFIX = /^proxy\./u;

/**
 * An `enterpriseUrl` as pi-ai's `normalizeDomain` reads it: its hostname,
 * empty when it is empty or no URL.
 */
const enterpriseDomain = (enterpriseUrl: string) => {
  const trimmed = enterpriseUrl.trim();
  const url =
    trimmed === ""
      ? null
      : URL.parse(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  return url?.hostname ?? "";
};

/**
 * The URL a GitHub Copilot OAuth credential sends every request to, in
 * place of the listed `baseUrl`, as pi-ai's `getGitHubCopilotBaseUrl`
 * builds it in pi 1.2 to 1.6 (`toAuth`): the token's `proxy-ep=` host with
 * a leading `proxy.` made `api.`, else `https://copilot-api.<enterprise>`,
 * else the individual API. No other OAuth provider of pi-ai sets one. A
 * refresh stores a new token; the next run start reads it.
 */
const copilotRequestUrl = (entry: typeof StoredEntry.Type) => {
  const host = isString(entry.access)
    ? PROXY_EP.exec(entry.access)?.groups?.host
    : undefined;
  if (host !== undefined) {
    return `https://${host.replace(PROXY_PREFIX, "api.")}`;
  }
  const enterprise = isString(entry.enterpriseUrl)
    ? enterpriseDomain(entry.enterpriseUrl)
    : "";
  return enterprise === ""
    ? "https://api.individual.githubcopilot.com"
    : `https://copilot-api.${enterprise}`;
};

/**
 * Where pi sends a request for `model` (`api`, `baseUrl` and `provider` as
 * pi lists it), with the child's `env` and the `stored` credentials: its
 * `baseUrl`, except that an Azure model (the `azure` provider, whatever its
 * `api`, or an `azure-openai*` api) with a resource name, from its stored
 * credential's `env` or the child's, goes to
 * `https://<name>.openai.azure.com`, as pi-ai builds it for every api of
 * that provider and for its Azure Responses api, and a GitHub
 * Copilot OAuth credential goes where its token says (`copilotRequestUrl`).
 * `moved` when that credential's `env` sets a name that moves the endpoint
 * (`piMovesEndpoint`; a `GOOGLE_CLOUD_LOCATION` that is not a string too), with
 * those names: pi would use it, the child's env no longer has one.
 * `unreadable` when that credential cannot be read (`storedEntry`).
 */
export const piRequestUrl = (input: {
  env: Record<string, string | undefined>;
  model: Omit<typeof HostedModel.Type, "id">;
  stored: StoredCredentials;
}):
  | { kind: "moved"; names: readonly string[] }
  | { kind: "unreadable" }
  | { kind: "url"; url: string | undefined } => {
  const { model } = input;
  const entry = Option.getOrUndefined(
    storedEntry(input.stored, model.provider)
  );
  if (entry === undefined) {
    return { kind: "unreadable" };
  }
  const own = entry.env ?? {};
  const names = Object.entries(own).flatMap(([name, value]) =>
    piMovesEndpoint(name, isString(value) ? value : "") ? [name] : []
  );
  if (names.length > 0) {
    return { kind: "moved", names };
  }
  if (model.provider === "github-copilot" && entry.type === "oauth") {
    return { kind: "url", url: copilotRequestUrl(entry) };
  }
  const resource =
    model.provider === "azure" || model.api?.startsWith("azure-openai") === true
      ? [own.AZURE_OPENAI_RESOURCE_NAME, input.env.AZURE_OPENAI_RESOURCE_NAME]
          .filter(isString)
          .find((name) => name.length > 0)
      : undefined;
  return {
    kind: "url",
    url:
      resource === undefined
        ? model.baseUrl
        : `https://${resource}.openai.azure.com/openai/v1`,
  };
};

/**
 * Where pi runs a model, as a run start judges it. It fails closed: `remote`,
 * with its endpoint, only for an `http`, `https`, `ws` or `wss` URL whose
 * host resolves to public addresses only. `unusable` when the URL is empty,
 * does not parse, has another scheme or a host DNS cannot look up
 * (`endpointOf`), with its scheme and host; `local` when the host is, or
 * resolves to, an address that is not public (`hostIsLocal`: loopback, the
 * LAN, the tailnet, link-local, unspecified; `localhost` by what it resolves
 * to, a public host on a custom port is remote); `unresolved` when its name
 * resolves to nothing; `moved` or `unreadable` for its credential
 * (`piRequestUrl`); `unlisted` when pi does not list the model, so its
 * endpoint is unknown.
 */
export type PiModelReach =
  | { endpoint: NetEndpoint; kind: "remote" }
  | { kind: "local"; target: string }
  | { kind: "unresolved"; target: string }
  | { kind: "unusable"; target: string }
  | { kind: "moved"; names: readonly string[] }
  | { kind: "unlisted" }
  | { kind: "unreadable" };

/** The `PiModelReach` of a `piRequestUrl` verdict. */
export const piReachOf = async (
  request: ReturnType<typeof piRequestUrl>
): Promise<PiModelReach> => {
  if (request.kind !== "url") {
    return request;
  }
  const endpoint = endpointOf(request.url);
  if (endpoint === undefined) {
    return { kind: "unusable", target: unusableTarget(request.url) };
  }
  const local = await hostIsLocal(endpoint.host);
  const target = `${endpoint.host}:${endpoint.port}`;
  if (local === undefined) {
    return { kind: "unresolved", target };
  }
  return local ? { kind: "local", target } : { endpoint, kind: "remote" };
};

/**
 * Where pi runs `model` (`PiModelReach`), from pi's own list, for a child
 * with `env`.
 */
export const piModelReach = async (input: {
  bin: string;
  env: Record<string, string | undefined>;
  model: { id: string; provider: string };
}): Promise<PiModelReach> => {
  const listed = await listedModel(input.bin, input.model);
  return listed === undefined
    ? { kind: "unlisted" }
    : await piReachOf(
        piRequestUrl({
          env: input.env,
          model: listed,
          stored: readStoredCredentials(),
        })
      );
};

/** Why a run on `key` may not start, for the log; empty when it may. */
export const piRefusalOf = (key: string, reach: PiModelReach) => {
  if (reach.kind === "remote") {
    return "";
  }
  if (reach.kind === "moved") {
    return `pi model ${key}'s stored credential sets ${reach.names.join(", ")}, which moves its endpoint past the check`;
  }
  if (reach.kind === "unreadable") {
    return `pi's auth.json cannot be read, so pi model ${key}'s stored credential cannot be checked`;
  }
  if (reach.kind === "unlisted") {
    return `pi does not list model ${key}, so its endpoint cannot be checked`;
  }
  if (reach.kind === "local") {
    return `pi model ${key} runs on a local endpoint (${reach.target}); local models are switched off`;
  }
  if (reach.kind === "unresolved") {
    return `pi model ${key}'s endpoint ${reach.target} does not resolve (DNS down or no such name), so it cannot be checked for a local address; the run is refused, the next one checks again`;
  }
  return `pi model ${key} has no http, https, ws or wss URL with a host the check can look up (${reach.target}), so it cannot be checked for a local address`;
};

/**
 * The endpoint a run on `model` may reach, after the check every pi child
 * on a model passes, full access included, which no view guards: a model
 * that is not `remote` (`piModelReach`) fails the run with
 * `ProviderCrashed` before pi starts.
 */
const checkedEndpoint = async (input: {
  access: Pick<RunAccess, "env">;
  bin: string;
  model: { id: string; provider: string };
}) => {
  const { model } = input;
  const reach = await piModelReach({
    bin: input.bin,
    env: input.access.env === "inherit" ? piCheckEnv() : minimalEnv("pi"),
    model,
  });
  if (reach.kind !== "remote") {
    throw new ProviderCrashed({
      message: piRefusalOf(`${model.provider}/${model.id}`, reach),
    });
  }
  return reach.endpoint;
};

/**
 * The access a helper turn runs under: no tools, no web, no session. A
 * light key check resolves a `!command` in its view too.
 */
export const PI_HELPER_ACCESS = {
  ...LIGHT_ACCESS,
  sandbox: "none",
  webSearch: false,
} as const;

/** An agent dir file, when it is there. */
const agentFile = (name: string) => {
  const file = path.join(piAgentDir(), name);
  return existsSync(file) ? [file] : [];
};

/** What a run inside the view adds to its launch. */
export interface PiSandbox {
  /** The argv that runs pi with `args` inside the view. */
  argv: (args: readonly string[]) => string[];
  close: () => void;
  env: Record<string, string>;
  /** The chat's memory server through the relay; undefined when not wired. */
  groupMemory: StdioCommand | undefined;
  /** The argv that runs any `command` inside the same view. */
  wrap: (command: readonly string[]) => string[];
}

/**
 * Open the view of one pi child, or undefined when it runs unwrapped: full
 * access, or no `bwrap` on this host, where only `none` (no tools) is ever
 * handed to pi. A `model` is checked first, whatever the posture
 * (`checkedEndpoint`): a local one fails here. The view then reaches only
 * that model's endpoint; without a `model` it reaches no host. `close`
 * stops the network proxy and the chat's memory relay once the child is
 * gone.
 */
export const openPiSandbox = async (input: {
  access: Pick<RunAccess, "env" | "groupMemory" | "sandbox">;
  bin: string;
  groupMemory?: GroupMemoryChat;
  model?: { id: string; provider: string };
  workingDirectory: string;
}): Promise<PiSandbox | undefined> => {
  const { model } = input;
  const endpoint =
    model === undefined
      ? undefined
      : await checkedEndpoint({ access: input.access, bin: input.bin, model });
  // Full access reaches anything; only a view gets the endpoint, the one
  // exact `host:port` of its own model.
  const policy: NetPolicy =
    endpoint !== undefined && runsInView(input.access.sandbox)
      ? { endpoint, hosts: [] }
      : { hosts: [] };
  const run = await openRunView({
    access: input.access,
    groupMemory: input.groupMemory,
    ...policy,
    workingDirectory: input.workingDirectory,
  });
  if (run === undefined) {
    return undefined;
  }
  try {
    const launch = piLaunch(input.bin);
    const view = run.view({
      readOnly: [
        ...launch.readOnly,
        PI_GATE,
        PI_MCP,
        ...agentFile("auth.json"),
        ...agentFile("models.json"),
        ...agentFile("models-store.json"),
        ...agentFile("settings.json"),
        // pi never reads it itself; a `!command` key in `models.json` may.
        ...agentFile(".env.local"),
      ],
      readWrite: [],
    });
    const wrap = (command: readonly string[]) =>
      sandboxCommand({
        bwrap: run.bwrap,
        command: run.command(command),
        posture: run.posture,
        view,
      });
    return {
      argv: (args) => wrap([...launch.argv, ...args]),
      close: run.close,
      env: run.env,
      groupMemory: run.groupMemory,
      wrap,
    };
  } catch (error) {
    run.close();
    throw error;
  }
};
