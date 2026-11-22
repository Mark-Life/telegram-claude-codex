import { TASK_AUTHOR_ENV, TASK_AUTHOR_ID_ENV } from "@workspace/db";
import type { TaskStamp } from "@workspace/db";

import type { ProviderId, RunAccess } from "./types";

/**
 * The names an agent child needs whatever the caller's privileges: where its
 * binary and the shell live (`PATH`), where its own credentials and config sit
 * (`HOME`; the provider's own config-dir variable is in `PROVIDER_ENV`), and
 * what a host behind an egress proxy or a private CA needs to reach the API.
 * `PATH` and `HOME` alone are enough to start a turn and find the provider's
 * login under the home directory; the rest travel only when the operator set
 * them.
 */
const RUN_ENV_ALLOWLIST = new Set([
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "TZ",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/**
 * The names only one provider's child reads, added to the allowlist for that
 * provider alone: where it keeps its login and config. For Claude also the
 * two ways an operator can hand it an account without `claude auth login`,
 * and `USER`, which names its login in the macOS keychain.
 */
const PROVIDER_ENV = {
  claude: [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "USER",
  ],
  codex: ["CODEX_HOME"],
  pi: ["PI_CODING_AGENT_DIR"],
} as const satisfies Record<ProviderId, readonly string[]>;

/**
 * Whether a trusted run's child loses the bot's internal secrets. A Claude
 * or pi child is never handed Executor or the owner's account through its
 * env, so it never needs their keys.
 */
const SCRUBS_INHERITED = {
  claude: true,
  codex: false,
  pi: true,
} as const satisfies Record<ProviderId, boolean>;

/**
 * The bot's own secrets no tool the owner runs reads: the Executor key, the
 * account server's bearer and the TypeSafe key. Every other key stays, so the
 * bot's helper scripts (`AppConfig` needs `GROQ_API_KEY`, `TELEGRAM_API_HASH`)
 * and the owner's workspace tools work as on Codex.
 */
const INTERNAL_SECRETS = new Set([
  "EXECUTOR_API_KEY",
  "TELEGRAM_ACCOUNT_MCP_TOKEN",
  "TYPESAFE_API_KEY",
]);

/**
 * The names pi 1.6 (pi-ai and the SDKs under it) reads at request time to
 * send a model's requests somewhere other than the `baseUrl` pi lists for
 * it, which is all the local-model check sees: Azure's base URL and
 * endpoint, the OpenAI, Anthropic and Google SDKs' own base URL (read when
 * pi hands them none), the llama extension's server, and the AWS SDK's
 * endpoint override for Bedrock. A `GOOGLE_CLOUD_LOCATION` that is not a
 * plain region name counts too: Vertex puts it into its host unchecked.
 */
const PI_ENDPOINT_NAMES = new Set([
  "ANTHROPIC_BASE_URL",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_ENDPOINT",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "LLAMA_BASE_URL",
  "OPENAI_BASE_URL",
]);

const AWS_ENDPOINT = /^AWS_ENDPOINT_URL(?:_|$)/u;
const REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Whether `name` set to `value` moves a pi model's endpoint
 * (`PI_ENDPOINT_NAMES`): no pi child gets it, and a credential whose `env`
 * sets it is refused.
 */
export const piMovesEndpoint = (name: string, value: string) =>
  PI_ENDPOINT_NAMES.has(name) ||
  AWS_ENDPOINT.test(name) ||
  (name === "GOOGLE_CLOUD_LOCATION" && !REGION.test(value));

/**
 * The tasks CLI stamps a task with this; only a run whose access granted the
 * owner's account may write a task that runs with it, and it stamps the tier
 * and id of the person it works for. Read from the access the host granted,
 * before it was narrowed to what the provider can wire: that person wrote the
 * task whether or not this provider reaches the account.
 */
const taskAuthorEnv = (
  granted: RunAccess,
  stamp: TaskStamp | undefined
): Record<string, string> =>
  granted.telegramAccount && stamp !== undefined
    ? {
        [TASK_AUTHOR_ENV]: stamp.author,
        [TASK_AUTHOR_ID_ENV]: String(stamp.userId),
      }
    : { [TASK_AUTHOR_ENV]: "executor" };

/** Names only `taskAuthorEnv` sets; one inherited from the host never leaks. */
const STAMP_ENV = new Set([TASK_AUTHOR_ENV, TASK_AUTHOR_ID_ENV]);

const hostEnv = () =>
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !STAMP_ENV.has(entry[0])
  );

/**
 * The allowlist plus the provider's own names: all an untrusted run's child
 * gets, and what a provider's account check runs with.
 */
export const minimalEnv = (provider: ProviderId) => {
  const own: readonly string[] = PROVIDER_ENV[provider];
  return Object.fromEntries(
    hostEnv().filter(
      ([name]) => RUN_ENV_ALLOWLIST.has(name) || own.includes(name)
    )
  );
};

/**
 * The bot's env for a trusted run, minus `CLAUDECODE`, which leaks in when
 * the bot is started from a Claude Code shell and confuses an agent child.
 * A provider that scrubs (`SCRUBS_INHERITED`) has its child lose every
 * `CLAUDE_CODE_*` name and the bot's internal secrets, and get its own
 * account names back. A pi child also loses every name that moves a model's
 * endpoint (`piMovesEndpoint`).
 */
export const inheritEnv = (provider: ProviderId) => {
  const rest = hostEnv().filter(([name]) => name !== "CLAUDECODE");
  if (!SCRUBS_INHERITED[provider]) {
    return Object.fromEntries(rest);
  }
  const scrubbed = rest.filter(
    ([name, value]) =>
      !(
        name.startsWith("CLAUDE_CODE_") ||
        INTERNAL_SECRETS.has(name) ||
        (provider === "pi" && piMovesEndpoint(name, value))
      )
  );
  return { ...Object.fromEntries(scrubbed), ...minimalEnv(provider) };
};

/**
 * The environment one run's agent process starts with. A trusted profile keeps
 * the bot's own env (`inheritEnv`); every other profile gets the allowlist
 * plus the provider's own names only, so a shell command in an untrusted chat
 * has no `BOT_TOKEN`, Groq key or Executor key to print. `access` is the
 * narrowed record the run holds; `granted` is what the host granted before
 * narrowing, and with `stamp` it decides only the task author.
 */
export const runEnv = (input: {
  access: RunAccess;
  granted: RunAccess;
  provider: ProviderId;
  stamp?: TaskStamp;
}) => ({
  ...(input.access.env === "inherit"
    ? inheritEnv(input.provider)
    : minimalEnv(input.provider)),
  ...taskAuthorEnv(input.granted, input.stamp),
});
