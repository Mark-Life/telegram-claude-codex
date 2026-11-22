import {
  DEFAULT_MODEL,
  getProvider,
  routeModel,
  ROUTER_FALLBACK,
  tierModel,
} from "@workspace/agent";
import type {
  ModelPick,
  ModelTier,
  ProviderId,
  RouteInput,
  RoutedEffort,
  RunAccess,
  SessionPick,
} from "@workspace/agent";
import { Duration, Effect, Option } from "effect";

import { runtime } from "../runtime";
import { AUTO, PROVIDER_DEFAULT, startPickFor } from "./chat-defaults";
import type { StartPick } from "./chat-defaults";
import type { PromptRouting } from "./deps";
import { recordJudgment } from "./judge-event";
import { storeThreadPick, threadPickFor } from "./session-routing";
import type { RouteState, RunDir } from "./session-routing";

/**
 * The app's side of the model router: a run gets a model slug and an effort
 * here, and a judgment that cannot answer never fails it. Every routing is
 * also one ledger line — the only way to retune a threshold against real
 * traffic.
 */

/** Whether `provider` can be routed at all; one that cannot takes its default. */
export const isRoutable = (provider: ProviderId) =>
  getProvider(provider).capabilities.autoModel;

/** One routing: what to read, who asked, and which provider runs the answer. */
export interface RouteRequest {
  input: RouteInput;
  provider: ProviderId;
  userId: number;
}

/**
 * What the run is started with. `model` is absent only if the provider
 * declares no routed tier at all, which leaves the provider's own default in
 * place; the Codex provider declares every tier, so in practice it is set.
 */
export interface RoutedRun {
  effort: string;
  model?: string;
  /** Routed for this run alone: the conversation keeps no pick. */
  unstored?: true;
}

/**
 * The slug for a tier, or the fallback tier's, or — if the provider declares
 * no tier at all — nothing, which leaves the provider's default in place.
 */
const slugFor = (provider: ProviderId, tier: ModelTier) =>
  tierModel(provider, tier) ?? tierModel(provider, ROUTER_FALLBACK.tier);

/**
 * Ask the router for a tier and an effort, and write its ledger line. A
 * router that cannot answer gives `ROUTER_FALLBACK`.
 */
const judge = ({ input, userId }: RouteRequest) =>
  Effect.gen(function* judgeRun() {
    const [elapsed, picked] = yield* Effect.timed(routeModel(input));
    if (Option.isNone(picked)) {
      return ROUTER_FALLBACK;
    }
    const pick = picked.value;
    yield* recordJudgment({
      chatKind: null,
      decision: null,
      elapsed,
      inputTokens: pick.inputTokens,
      kind: "model_route",
      model: pick.judgeModel,
      pickedEffort: pick.effort,
      probability: null,
      scores: pick.scores,
      subjectId: null,
      tier: pick.tier,
      userId,
      via: "typesafe",
    });
    return { effort: pick.effort, tier: pick.tier };
  });

/** The ledger line of a pick that spent no judgment. */
const recordUnrouted = (request: RouteRequest, effort: string) =>
  recordJudgment({
    chatKind: null,
    decision: null,
    elapsed: Duration.zero,
    inputTokens: null,
    kind: "model_route",
    model: null,
    pickedEffort: effort,
    probability: null,
    scores: null,
    subjectId: null,
    tier: null,
    userId: request.userId,
    via: "default",
  });

/** The provider's own default slug, or `DEFAULT_MODEL` for one with none. */
const defaultSlug = (provider: ProviderId) =>
  getProvider(provider).defaultModel() ?? DEFAULT_MODEL;

/**
 * A pick in the provider's own terms, from the person's defaults, what the
 * conversation already holds (`kept`, a `/model` or `/effort` sent before its
 * first message) and the router's answer when one was asked. A tier runs on
 * the provider's slug for it; the provider's default is its own slug, or
 * `DEFAULT_MODEL` for one with none, so the pick is still complete and stored
 * once and the provider leaves its CLI's default in place. A level of the
 * shared scale is mapped onto the model the pick ends on.
 */
const pickFor = (input: {
  kept: SessionPick;
  provider: ProviderId;
  routed: ModelPick | undefined;
  wanted: StartPick;
}): RoutedRun => {
  const { kept, provider, routed, wanted } = input;
  const target = getProvider(provider);
  const tier = wanted.model === AUTO ? routed?.tier : wanted.model;
  const model =
    kept.model ??
    wanted.models[provider] ??
    (tier === undefined || tier === PROVIDER_DEFAULT
      ? defaultSlug(provider)
      : slugFor(provider, tier));
  const level = wanted.effort === AUTO ? routed?.effort : wanted.effort;
  const effort =
    kept.effort ??
    (level === undefined || level === PROVIDER_DEFAULT
      ? target.defaultEffort
      : target.mapEffort(level, model));
  return { effort, model };
};

/** The person's defaults, read inside the runtime; never fails. */
const wantedBy = (userId: number) =>
  Effect.map(startPickFor(userId), ({ pick }) => pick);

/**
 * `decideRun` from a `wanted` already read; `routed` says a judgment was
 * spent on the answer.
 */
const decideWith = ({
  kept,
  record = true,
  request,
  wanted,
}: {
  kept: SessionPick;
  /** Write the ledger line of a pick that spent no judgment. */
  record?: boolean;
  request: RouteRequest;
  wanted: StartPick;
}) =>
  Effect.gen(function* decide() {
    const leftToRouter =
      (kept.model === undefined && wanted.model === AUTO) ||
      (kept.effort === undefined && wanted.effort === AUTO);
    const routed =
      leftToRouter && isRoutable(request.provider)
        ? yield* judge(request)
        : undefined;
    const pick = pickFor({ kept, provider: request.provider, routed, wanted });
    if (routed === undefined && record) {
      yield* recordUnrouted(request, pick.effort);
    }
    return { pick, routed: routed !== undefined };
  });

/**
 * What a new conversation runs on: the defaults of the person who starts it
 * (`chat-defaults.ts`), under whatever the conversation already holds
 * (`kept`). A half still left to the router is routed while the provider can
 * be routed, and only then is a judgment spent; on a provider that cannot be
 * routed it takes the provider's default. Either way one `model_route`
 * ledger line says which (`via`), and the caller stores the answer once for
 * the whole conversation.
 */
const decideRun = (request: RouteRequest, kept: SessionPick = {}) =>
  Effect.flatMap(wantedBy(request.userId), (wanted) =>
    Effect.map(decideWith({ kept, request, wanted }), ({ pick }) => pick)
  );

/**
 * A task's own model and effort, in the router's terms; an unset half
 * follows the writer.
 */
export interface TaskChoice {
  effort?: RoutedEffort;
  tier?: ModelTier;
}

/** The halves of a task's pick the router decided, to store on its row. */
export interface TaskRouted {
  effort?: string;
  model?: string;
}

/**
 * What one fire of a scheduled task runs on: the task's own choice, else
 * the writer's defaults (`/settings`), read now, so a changed default
 * reaches every task that follows it. A half left to the router takes the
 * routed half `cached` on the row while there is one, and is routed
 * otherwise; `routed`, set only when a judgment was spent, holds the halves
 * worth storing. A fire that cannot store its answer (`keep` false: it
 * landed on a provider the task was not meant for) is never routed, since
 * every such fire would spend a judgment; it takes the provider's default.
 */
export const taskRunFor = async (input: {
  cached: SessionPick;
  choice: TaskChoice;
  keep: boolean;
  request: RouteRequest;
}): Promise<{ pick: RoutedRun; routed?: TaskRouted }> => {
  const { cached, choice, keep, request } = input;
  const unrouted = <T extends string>(half: T) =>
    half === AUTO && !keep ? PROVIDER_DEFAULT : half;

  const program = Effect.gen(function* decideTask() {
    const writer = yield* wantedBy(request.userId);
    const model = choice.tier ?? writer.model;
    const effort = choice.effort ?? writer.effort;
    const kept: SessionPick = {
      effort: effort === AUTO ? cached.effort : undefined,
      model: model === AUTO ? cached.model : undefined,
    };
    // A fire decides nothing new unless it routes: the ledger gets the
    // judgment's line and no line per fire for fixed or kept halves.
    const { pick, routed } = yield* decideWith({
      kept,
      record: false,
      request,
      wanted: {
        effort: unrouted(effort),
        model: unrouted(model),
        // The task's own tier wins over the writer's model by name.
        models: choice.tier === undefined ? writer.models : {},
      },
    });
    // Only a half left to the router is worth keeping: a fixed one is read
    // again at every fire, so a later switch to Авто still routes it.
    const halves: TaskRouted = {
      effort: effort === AUTO ? pick.effort : undefined,
      model: model === AUTO ? pick.model : undefined,
    };
    return { pick, routed: routed ? halves : undefined };
  });
  try {
    return await runtime.runPromise(program);
  } catch {
    // swallow: the router never fails, so this is the runtime going away
    return {
      pick: pickFor({
        kept: {},
        provider: request.provider,
        routed: ROUTER_FALLBACK,
        wanted: { effort: AUTO, model: AUTO, models: {} },
      }),
    };
  }
};

/** Routes a `main` run's conversation; see `runModelFor`. */
const mainRunModel = Effect.fn("runModelFor")(function* (args: {
  routing: PromptRouting;
  runDir?: RunDir;
  state: RouteState;
}) {
  const { routing, runDir, state } = args;
  const stored = yield* threadPickFor(state, runDir);
  if (stored.effort !== undefined && stored.model !== undefined) {
    // The same pick as the provider can run it now: a slug it has since
    // dropped moves to its family's current one, else to its default.
    const target = getProvider(state.activeProvider);
    const kept: RoutedRun = {
      effort: stored.effort,
      model: target.resolveStored(stored.model) ?? target.defaultModel(),
    };
    return kept;
  }
  // A half the human already chose stays theirs; the defaults fill the rest.
  const pick = yield* decideRun(
    { input: routing, provider: state.activeProvider, userId: state.userId },
    stored
  );
  if (routing.provisional === true) {
    return { ...pick, unstored: true } satisfies RoutedRun;
  }
  yield* storeThreadPick(state, pick, runDir);
  return pick;
});

/**
 * What one conversation runs on. A `light` run never asks: `runAgent` pins it
 * to its provider's `lightPick`, and asking would spend a judgment to be
 * ignored. A `main` run reuses whatever the thread already carries — the
 * router's earlier pick, or a `/model` the human ran there — and routes only
 * when a half is still missing, which is the first message of a thread, a
 * `/new`, and a cleared override.
 */
export const runModelFor = ({
  modelClass,
  ...args
}: Parameters<typeof mainRunModel>[0] & {
  modelClass: RunAccess["modelClass"];
}) => (modelClass === "main" ? mainRunModel(args) : Effect.void);
