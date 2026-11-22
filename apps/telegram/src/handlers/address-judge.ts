import { judgeAddressedVerdict } from "@workspace/agent";
import type { AddressVerdict, JudgeArgs } from "@workspace/agent";
import { Effect } from "effect";

import { runtime } from "../runtime";
import { recordJudgment } from "./judge-event";
import { helperFor } from "./light-defaults";

/**
 * Promise-facing bridge to the address judge: the two call-name gates are plain
 * async handlers, so they get a boolean here and never see a rejection. Every
 * verdict is also one ledger line — the only way to tune the probability
 * threshold on real traffic. The helper fallback runs on `helperFor`'s
 * pick: the owner's from «Служебные проходы» while it can run, else the
 * detected helper.
 */

/** A judge call plus who asked, which the ledger line is keyed by. */
export interface JudgeRequest extends JudgeArgs {
  userId: number;
}

/** NULL on the helper fallback: it answers yes or no and reports nothing else. */
const metricsOf = (verdict: AddressVerdict) =>
  verdict.via === "typesafe"
    ? {
        inputTokens: verdict.inputTokens,
        model: verdict.model,
        probability: verdict.probability,
      }
    : { inputTokens: null, model: null, probability: null };

const judge = ({ userId, ...args }: JudgeRequest) =>
  Effect.gen(function* judgeAddress() {
    // Never rejects: a failed settings read is Auto.
    const { pick } = yield* Effect.promise(
      async () => await helperFor("judge")
    );
    const [elapsed, verdict] = yield* Effect.timed(
      judgeAddressedVerdict(args, pick)
    );
    yield* recordJudgment({
      chatKind: args.surface.kind,
      decision: verdict.addressed,
      elapsed,
      kind: "address",
      subjectId: null,
      userId,
      via: verdict.via,
      ...metricsOf(verdict),
    });
    return verdict.addressed;
  });

/** Whether the bot was spoken to. A bridge that cannot answer means silence. */
export const judgeAddressedFor = async (request: JudgeRequest) => {
  try {
    return await runtime.runPromise(judge(request));
  } catch {
    // swallow: the judge itself never fails, so this is the runtime going away
    return false;
  }
};
