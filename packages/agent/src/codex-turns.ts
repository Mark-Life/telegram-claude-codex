import type {
  Codex,
  CodexOptions,
  RunResult,
  TurnOptions,
  ThreadOptions,
} from "@openai/codex-sdk";

import { trackTurn } from "./agent-turns";
import type { TurnSpec } from "./agent-turns";
import { lunaModel } from "./codex-models";
import { openCodexSandbox } from "./codex-sandbox";
import type { CodexSandbox } from "./codex-sandbox";
import { newCodex } from "./codex-sdk";
import { codexOptions } from "./codex-thread";
import { HELPER_INSTRUCTIONS, LIGHT_ACCESS } from "./types";
import type { HelperTurn, OneTurn, OneTurnRequest } from "./types";
import { untilAborted } from "./until-aborted";

/**
 * The one-turn slice of the SDK a helper pass drives. Structural, so a test
 * hands in a fake client instead of spawning Codex.
 */
export interface OneTurnClient {
  startThread: (options: ThreadOptions) => {
    /** One turn; a helper reads the final text and nothing else. */
    run: (
      input: string,
      turnOptions?: TurnOptions
    ) => Promise<Pick<RunResult, "finalResponse">>;
  };
}

/**
 * A client whose every `run` is a tracked turn. Wrapping the client, not the
 * caller's callback, records the turn's real outcome even when the caller
 * swallows the error into a fallback.
 */
export const trackedClient = (
  client: Pick<Codex, "startThread">,
  spec: Omit<TurnSpec, "provider">
): OneTurnClient => ({
  startThread: (options) => {
    const thread = client.startThread(options);
    return {
      run: async (input, turnOptions) =>
        await trackTurn(
          { ...spec, provider: "codex" },
          async () => await thread.run(input, turnOptions),
          turnOptions?.signal
        ),
    };
  },
});

/**
 * Thread options of a helper turn: no rollout, read-only, no tools, the
 * requested model, else Luna.
 */
export const oneTurnThreadOptions = (
  request: Pick<OneTurnRequest, "effort" | "model" | "workingDirectory">
): ThreadOptions => {
  const options: ThreadOptions = {
    approvalPolicy: "never",
    ephemeral: true,
    model: request.model ?? lunaModel(),
    sandboxMode: "read-only",
    skipGitRepoCheck: true,
    webSearchEnabled: false,
    workingDirectory: request.workingDirectory,
  };
  if (request.effort !== undefined) {
    options.modelReasoningEffort = request.effort;
  }
  return options;
};

/**
 * One helper turn on a client: a fresh thread, one run, its final text. An
 * abort rejects at once even if the child's output never closes, so a hung
 * turn cannot hold a side-turn slot.
 */
export const turnOn =
  (client: OneTurnClient): HelperTurn =>
  async (request) => {
    const { signal } = request;
    const run = client
      .startThread(oneTurnThreadOptions(request))
      .run(request.prompt, signal === undefined ? undefined : { signal });
    const turn = await (signal === undefined ? run : untilAborted(signal, run));
    return turn.finalResponse;
  };

/**
 * Config that strips a helper turn down to the request: Codex's own base
 * and developer instructions, the skills list, the project's `AGENTS.md`,
 * the environment context, sub-agents and the shell all stay out. Otherwise
 * a one-line task is read against the owner's workspace and answers from it,
 * such as a topic title in the language of the owner's name or time zone.
 * No key turns off `$CODEX_HOME/AGENTS.md`: only the bwrap view, whose
 * `~/.codex` holds nothing but `auth.json`, leaves that one out.
 */
const HELPER_CONFIG = {
  agents: { enabled: false },
  // Empty, so a value in the owner's `config.toml` is not sent either.
  developer_instructions: "",
  // Replaces the light profile's table whole: its three flags are off too.
  features: {
    apps: false,
    image_generation: false,
    plugins: false,
    shell_tool: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    sleep_tool: false,
    view_image: false,
  },
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  include_permissions_instructions: false,
  instructions: HELPER_INSTRUCTIONS,
  project_doc_max_bytes: 0,
  skills: { bundled: { enabled: false }, include_instructions: false },
} as const;

/** Process options of a helper turn: the `light` profile, made bare. */
export const helperCodexOptions = (sandbox?: CodexSandbox): CodexOptions => {
  const options = codexOptions({ access: LIGHT_ACCESS, sandbox });
  options.config = { ...options.config, ...HELPER_CONFIG };
  return options;
};

let client: Promise<Codex> | undefined;

/**
 * The one client every unwrapped helper turn shares. All of them run on the
 * same `light` profile, so a client per call buys nothing. A client that
 * failed to load is forgotten, so the next helper turn tries again.
 */
const loadHelperClient = async () => {
  try {
    return await newCodex(helperCodexOptions());
  } catch (error) {
    client = undefined;
    throw error;
  }
};

const sharedClient = async () => {
  client ??= loadHelperClient();
  return await client;
};

/**
 * The Codex provider's `oneTurn`: the requested model, else Luna, read-only,
 * registered as a turn. In the bwrap view the client is the turn's own,
 * because the view is built around the turn's working directory.
 */
export const codexOneTurn: OneTurn = async (request) => {
  const sandbox = await openCodexSandbox({
    access: LIGHT_ACCESS,
    workingDirectory: request.workingDirectory,
  });
  try {
    const helper =
      sandbox === undefined
        ? await sharedClient()
        : await newCodex(helperCodexOptions(sandbox));
    return await turnOn(
      trackedClient(helper, { kind: request.kind, label: request.label })
    )(
      sandbox === undefined
        ? request
        : { ...request, workingDirectory: sandbox.workingDirectory }
    );
  } finally {
    sandbox?.close();
  }
};
