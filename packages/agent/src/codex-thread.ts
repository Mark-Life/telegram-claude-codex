import { readFileSync } from "node:fs";
import path from "node:path";

import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import { Option, Schema } from "effect";

import { codexHiddenSkills } from "./bot-skills";
import type { CodexSandbox } from "./codex-sandbox";
import { mcpTokenEnv, toCodexMcpServers } from "./executor-mcp";
import { groupMemoryCommand } from "./group-memory-server";
import type { GroupMemoryChat } from "./group-memory-server";
import type { OwnerSettings } from "./provider-settings";
import { runEnv } from "./run-env";
import { buildRunPrompt } from "./run-prompt";
import { codexHome } from "./state-roots";
import { DEFAULT_MODEL, isRoutedEffort } from "./types";
import type {
  ProviderCapabilities,
  ProviderWiring,
  RunAccess,
  RunContext,
  RunOptions,
  SandboxMode,
} from "./types";

/** True when an optional string actually carries content. */
export const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

/** What the Codex provider supports; `codexProvider.capabilities` is this. */
export const CODEX_CAPABILITIES = {
  autoModel: true,
  compaction: true,
  cost: false,
  externalTools: true,
  groupMemory: true,
  planMode: true,
  // Codex enforces every posture with its own sandbox, inside the bwrap view
  // when the host has one.
  postures: ["danger-full-access", "read-only", "workspace-write"],
  // Every rollout lives in one `~/.codex/sessions`, which the view leaves out.
  sessionsInView: false,
  telegramAccount: true,
  thinking: true,
} as const satisfies ProviderCapabilities & ProviderWiring;

/**
 * Where a Codex run writes a plan it was asked for, relative to its working
 * directory; `codex.ts` turns the file into `plan_ready`.
 */
export const CODEX_PLAN_FILE = ".codex/plans/PLAN.md";

/** Context size, in tokens, past which Codex compacts a session on its own. */
export const AUTO_COMPACT_TOKENS_DEFAULT = 150_000;

/**
 * The auto-compaction threshold: `CODEX_AUTO_COMPACT_TOKENS` when it is a
 * positive integer, the default otherwise. Codex compacts in place, so the
 * session keeps its id.
 */
export const autoCompactTokenLimit = (
  raw: string | undefined = process.env.CODEX_AUTO_COMPACT_TOKENS
) => {
  const value = Number(raw?.trim());
  return isSet(raw) && Number.isInteger(value) && value > 0
    ? value
    : AUTO_COMPACT_TOKENS_DEFAULT;
};

/**
 * The first words of the turn that seeds a compacted session, so a reader of
 * Codex's files can tell that turn from a user's.
 */
export const COMPACT_SEED_OPENER =
  "This session continues an earlier conversation. Here is the handoff summary of it:";

/**
 * Compose the Codex prompt. Codex has no system-prompt hook, so the run's
 * standing instructions are prepended to the message instead. File routing is
 * repeated on every eligible turn so an already-running session immediately
 * learns its current Telegram topic. The other helper-script and plan-mode
 * instructions are prepended only on the first turn; resumed sessions carry
 * them in replayed conversation context.
 */
export const buildCodexPrompt = (
  opts: RunOptions,
  ctx?: Pick<RunContext, "telegramAccount">
) => {
  const { routing, system, request } = buildRunPrompt(opts, ctx, {
    planFile: CODEX_PLAN_FILE,
  });
  if (isSet(opts.sessionId)) {
    return routing.length === 0 ? request : `${routing}\n\n${request}`;
  }
  const prefix = [...(routing.length === 0 ? [] : [routing]), ...system].join(
    "\n\n"
  );
  return prefix.length === 0 ? request : `${prefix}\n\n${request}`;
};

/**
 * The Codex SDK's posture for a run. Codex has no posture without local
 * tools, and `none` is not in its `postures`, so asking for it is a bug that
 * fails the run rather than handing it more than it was given.
 */
const codexSandboxMode = (sandbox: SandboxMode) => {
  if (sandbox === "none") {
    throw new Error("Codex cannot run the none sandbox posture");
  }
  return sandbox;
};

/**
 * Per-thread options: working dir plus the approvals/sandbox posture this run
 * was granted. The sandbox is the real privilege boundary — a full-access run
 * can read `.env` whatever else is gated — so it comes from `opts.access`,
 * resolved by the host from who asked and where. `skipGitRepoCheck` mirrors the
 * old `--skip-git-repo-check` flag.
 */
export const threadOptions = (opts: RunOptions): ThreadOptions => {
  const options: ThreadOptions = {
    approvalPolicy: "never",
    sandboxMode: codexSandboxMode(opts.access.sandbox),
    skipGitRepoCheck: true,
    webSearchEnabled: opts.access.webSearch,
    workingDirectory: opts.projectDir,
  };
  if (opts.access.webSearch) {
    options.webSearchMode = "live";
  }
  // A light run arrives already pinned to `lightPick` by `runAgent`.
  // `DEFAULT_MODEL` leaves the Codex default in place.
  if (isSet(opts.model) && opts.model !== DEFAULT_MODEL) {
    options.model = opts.model;
  }
  if (isRoutedEffort(opts.effort)) {
    options.modelReasoningEffort = opts.effort;
  }
  return options;
};

/** The env var the `telegram_account` MCP bearer token reaches Codex in. */
const ACCOUNT_MCP_TOKEN_ENV = "TELEGRAM_ACCOUNT_MCP_TOKEN";

/** The part of `config.toml` that says which MCP servers it defines. */
const decodeAccountConfig = Schema.decodeUnknownOption(
  Schema.Struct({
    mcp_servers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  })
);

/**
 * The MCP server names in `$CODEX_HOME/config.toml`, or none when the file is
 * missing or unreadable (Codex then fails on it by itself).
 */
const inheritedMcpServers = (): string[] => {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(
      readFileSync(path.join(codexHome(), "config.toml"), "utf-8")
    );
  } catch {
    return [];
  }
  return Option.match(decodeAccountConfig(parsed), {
    onNone: () => [],
    onSome: (config) => Object.keys(config.mcp_servers ?? {}),
  });
};

/**
 * Build the Codex process options. Passing `env` means the SDK does not
 * additionally inherit `process.env`, so `access.env` is the whole secret
 * boundary of the child process. Codex's default shell-environment policy
 * strips `*TOKEN*` names, which would hide `BOT_TOKEN` from the send-file
 * script, so it is force-set for the shell tool — but only for the profiles
 * that are told about that script in the first place. The Executor MCP server,
 * when configured, rides the same config object, its key in `env`. A run in
 * the bwrap view starts through `sandbox`, and its group memory server is the
 * relay the bot runs outside the view, or none.
 */
export const codexOptions = (input: {
  access: RunAccess;
  /** What the host granted before narrowing; absent means `access`. */
  granted?: RunAccess;
  groupMemory?: GroupMemoryChat;
  mcpServers?: RunContext["mcpServers"];
  /** The owner's settings (`/settings`); absent keeps every default. */
  owner?: OwnerSettings;
  sandbox?: CodexSandbox;
  /** Who a task the run writes is stamped with; see `RunOptions`. */
  stamp?: RunOptions["taskAuthor"];
  telegramAccount?: RunContext["telegramAccount"];
}): CodexOptions => {
  const account = input.telegramAccount;
  const withAccount = input.access.telegramAccount && account !== undefined;
  const env = runEnv({
    access: input.access,
    granted: input.granted ?? input.access,
    provider: "codex",
    stamp: input.stamp,
  });
  if (withAccount) {
    // Codex reads the MCP bearer from here, so it never sits on the argv.
    Object.assign(env, { [ACCOUNT_MCP_TOKEN_ENV]: account.token });
  }
  const botToken =
    input.access.env === "inherit" ? process.env.BOT_TOKEN : undefined;
  const mcp = input.access.externalTools
    ? toCodexMcpServers(input.mcpServers)
    : undefined;
  if (mcp !== undefined) {
    // The servers' bearer tokens ride the env: the config lands on argv.
    Object.assign(env, mcpTokenEnv(input.mcpServers));
  }
  // The owner's settings sit over the env's defaults and under everything
  // the bot forces, which is set after them.
  const config: NonNullable<CodexOptions["config"]> = {
    model_auto_compact_token_limit: autoCompactTokenLimit(),
    ...input.owner,
    features: {
      apps: input.access.externalTools,
      plugins: input.access.externalTools,
      skill_mcp_dependency_install: input.access.externalTools,
    },
  };
  const hidden = codexHiddenSkills(input.access);
  if (hidden.length > 0) {
    config.skills = {
      config: hidden.map((file) => ({ enabled: false, path: file })),
    };
  }
  if (isSet(botToken)) {
    // `env` already carries BOT_TOKEN. Turning off Codex's `*TOKEN*` default
    // excludes lets shell commands see it without a copy in the config,
    // which lands on argv where any local user can read it.
    config.shell_environment_policy = {
      ignore_default_excludes: true,
      inherit: "all",
    };
  }
  const { sandbox } = input;
  if (sandbox !== undefined) {
    Object.assign(env, sandbox.env);
  }
  const memoryCommand = groupMemoryCommand(input, sandbox);
  const memoryServer =
    memoryCommand === undefined
      ? undefined
      : {
          group_memory: {
            ...memoryCommand,
            // Runs use approvalPolicy "never", so any tool Codex decides needs
            // approval is rejected outright. The server is already locked to
            // one chat, so its tools are pre-approved.
            default_tools_approval_mode: "approve",
          },
        };
  const configuredServers = mcp ? { ...mcp } : {};
  if (memoryServer) {
    Object.assign(configuredServers, memoryServer);
  }
  if (withAccount) {
    Object.assign(configuredServers, {
      telegram_account: {
        // Pre-approved for the same reason as group_memory: runs never ask,
        // so a tool Codex decides needs approval would be rejected outright.
        // Writes have their own gate: the owner's button under `confirm`.
        bearer_token_env_var: ACCOUNT_MCP_TOKEN_ENV,
        default_tools_approval_mode: "approve",
        url: account.url,
      },
    });
  }
  // `--config` overrides merge into the account's `config.toml`, so a
  // restricted run has to turn each inherited server off by name to get only
  // the servers set up above. Only names the file defines: an entry with no
  // transport fails the config. The view's `~/.codex` is empty, so a run in
  // it has nothing to turn off.
  if (!input.access.externalTools && sandbox === undefined) {
    for (const name of inheritedMcpServers()) {
      if (!(name in configuredServers)) {
        Object.assign(configuredServers, { [name]: { enabled: false } });
      }
    }
  }
  config.mcp_servers = configuredServers;
  const options: CodexOptions = { config, env };
  if (sandbox !== undefined) {
    options.codexPathOverride = sandbox.codexPathOverride;
  }
  return options;
};
