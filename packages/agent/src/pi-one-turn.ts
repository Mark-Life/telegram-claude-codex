import { spawn } from "bun";
import { Option } from "effect";

import { trackTurn } from "./agent-turns";
import { lines, stderrTail } from "./codex-app-server";
import { ProviderCrashed } from "./errors";
import { piBin, PI_FIXED_ENV, splitPiModel } from "./pi-account";
import { assistantEndOf } from "./pi-events";
import { findPiModel, piLightModel, piModelList } from "./pi-models";
import { openPiSandbox, PI_HELPER_ACCESS } from "./pi-sandbox";
import { runEnv } from "./run-env";
import { HELPER_INSTRUCTIONS, ROUTED_EFFORTS } from "./types";
import type { OneTurn, OneTurnRequest, RoutedEffort } from "./types";

/**
 * A reasoning model may send its thinking inline, ahead of the answer; cut
 * off by the output limit, the block never closes and is all there is.
 */
const THINK_RE = /^\s*<think>(?:[\s\S]*?<\/think>|[\s\S]*$)\s*/u;

type PiAnswer = Option.Option.Value<ReturnType<typeof assistantEndOf>>;

/**
 * The text a helper takes from pi's last answer: `stop` is the answer;
 * `length`, the part the output limit left, does for a title but fails the
 * format pass, which must keep every fact; anything else fails, with the
 * answer's error, else the tail of pi's stderr. Inline thinking is
 * dropped, and an answer that was nothing else fails.
 */
const answerText = (input: {
  answer: PiAnswer | undefined;
  kind: OneTurnRequest["kind"];
  stderr: string;
}) => {
  const { answer } = input;
  const usable =
    answer?.stopReason === "stop" ||
    (answer?.stopReason === "length" && input.kind !== "format");
  const text = answer?.text.replace(THINK_RE, "") ?? "";
  if (!usable || text.trim().length === 0) {
    throw new ProviderCrashed({
      message: `pi helper turn failed (${answer?.stopReason ?? "no answer"}${usable ? ", no answer text" : ""}): ${answer?.errorMessage ?? input.stderr}`,
    });
  }
  return text;
};

/**
 * The thinking level a helper turn on `key` runs at: off unless the owner set
 * a depth for this helper, else that depth, or the deepest level the model
 * lists below it (off when none is). A model the list does not know takes
 * the depth as set, as the picker offered it, and pi clamps it.
 */
const helperThinking = (key: string, wanted: RoutedEffort | undefined) => {
  if (wanted === undefined) {
    return "off";
  }
  const levels = findPiModel(piModelList(), key)?.levels;
  if (levels === undefined || levels.includes(wanted)) {
    return wanted;
  }
  // The levels are lightest first: the last one at or below the depth.
  const ceiling = ROUTED_EFFORTS.indexOf(wanted);
  let thinking: RoutedEffort | "off" = "off";
  for (const level of levels) {
    if (ROUTED_EFFORTS.indexOf(level) <= ceiling) {
      thinking = level;
    }
  }
  return thinking;
};

/**
 * pi's `oneTurn`: one `pi --mode json` child, nothing loaded, no tools, no
 * session, thinking off unless the owner set a depth for this helper
 * (`helperThinking`), in the `none` view when the host has one. JSON mode
 * always exits 0, so the answer's own `stopReason` decides
 * (`answerText`). The prompt goes in on stdin, which is closed right after,
 * never in argv, where any local user could read it in `/proc`. The model is
 * the first a helper can run (`piLightModel`): one keyed by the owner's env
 * alone would find no key here. Each call spawns pi; it serves titles, the
 * format pass and the judge.
 */
export const piOneTurn: OneTurn = async (request) =>
  await trackTurn(
    { kind: request.kind, label: request.label, provider: "pi" },
    async () => {
      const bin = piBin();
      const key = piLightModel(request.model);
      const model = splitPiModel(key ?? "");
      if (bin === undefined || key === undefined || model === undefined) {
        throw new ProviderCrashed({
          message: "pi has no CLI or no model a helper turn can run",
        });
      }
      const args = [
        "--mode",
        "json",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--offline",
        "--thinking",
        helperThinking(key, request.ownEffort),
        "--provider",
        model.provider,
        "--model",
        model.id,
        "--system-prompt",
        HELPER_INSTRUCTIONS,
      ];
      const sandbox = await openPiSandbox({
        access: PI_HELPER_ACCESS,
        bin,
        model,
        workingDirectory: request.workingDirectory,
      });
      try {
        const proc = spawn({
          cmd: sandbox === undefined ? [bin, ...args] : sandbox.argv(args),
          cwd: request.workingDirectory,
          env: {
            ...runEnv({
              access: PI_HELPER_ACCESS,
              granted: PI_HELPER_ACCESS,
              provider: "pi",
            }),
            ...PI_FIXED_ENV,
            ...sandbox?.env,
          },
          signal: request.signal,
          stderr: "pipe",
          stdin: "pipe",
          stdout: "pipe",
        });
        const stderr = stderrTail(proc.stderr);
        // pi reads the prompt to stdin's end, while stdout is read.
        const fed = (async () => {
          try {
            await proc.stdin.write(request.prompt);
            await proc.stdin.end();
          } catch {
            // The pipe closed with the child; its missing answer reports it.
          }
        })();
        let last: ReturnType<typeof assistantEndOf> = Option.none();
        for await (const line of lines(proc.stdout)) {
          const end = assistantEndOf(line);
          last = Option.isSome(end) ? end : last;
        }
        await Promise.allSettled([proc.exited, stderr.done, fed]);
        request.signal?.throwIfAborted();
        return answerText({
          answer: Option.getOrUndefined(last),
          kind: request.kind,
          stderr: stderr.text(),
        });
      } finally {
        sandbox?.close();
      }
    },
    request.signal
  );
