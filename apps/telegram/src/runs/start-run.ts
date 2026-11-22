import path from "node:path";

import { AgentInterrupted, runAgent } from "@workspace/agent";
import type { ProviderId, RunPersona } from "@workspace/agent/types";
import { SessionContextRepo, SessionHistoryRepo } from "@workspace/db";
import type { TaskStamp } from "@workspace/db";
import { Effect, Stream } from "effect";

import type { AccessDecision } from "../access/run-access";
import { scratchDirOf } from "../access/scratch";
import { getCurrentBranch } from "../git";
import type { PromptRouting } from "../handlers/deps";
import { readLightChoice } from "../handlers/light-defaults";
import { runModelFor } from "../handlers/model-route";
import { settlePdfTexts } from "../handlers/pdf-text";
import type { RunEventMeta } from "../handlers/run-event";
import { routeView, sessionIdFor } from "../handlers/session-routing";
import type { RunDir } from "../handlers/session-routing";
import { carriesDocument } from "../handlers/uploads";
import type { UserState } from "../handlers/user-state";
import { recordSessionContext } from "../session-context";
import { recordRunSession } from "../session-history";

/**
 * The directory this run works in: a scratch dir when access says sandboxed,
 * the conversation's project otherwise. Everything keyed on the run — the
 * session id above all — uses this, never `state.activeProject`.
 */
export const runDirOf = (decision: AccessDecision, state: UserState): RunDir =>
  decision.scratch === false
    ? { projectPath: state.activeProject, scratch: false }
    : { projectPath: scratchDirOf(decision.scratch, state), scratch: true };

export interface StartRunInput {
  /** What the asker may do; decides the sandbox, the tools and the model class. */
  decision: AccessDecision;
  /** Who the bot is in this run (`loadPersona`). */
  persona: RunPersona;
  projectsDir: string;
  prompt: string;
  /**
   * The provider the run was resolved to, once, before it started. Every
   * session and pick write of the run goes to this provider, whatever the
   * route says by the time the run ends.
   */
  provider: ProviderId;
  routing: PromptRouting;
  /**
   * Whether `/provider` switched the route after `provider` was resolved.
   * Checked last before the start: the session and the pick are read first,
   * and the router may take seconds on a new conversation.
   */
  routeSwitched: () => boolean;
  /** The conversation the run belongs to; its route is the run's slot. */
  state: UserState;
  /** Who a task the run writes is stamped with (`taskStampFor`). */
  taskAuthor: TaskStamp | undefined;
}

/**
 * Whether `/history` lists this run's session: a main run whose session is
 * kept, in the conversation's own directory. Light runs, scratch runs and
 * task fires (which never keep a session) are left out.
 */
const keepsHistory = (decision: AccessDecision) =>
  decision.agent.persistSession &&
  decision.agent.modelClass === "main" &&
  decision.scratch === false;

/**
 * The run's wide-event context before it has started: what a start that never
 * got a run id from the registry is recorded under.
 */
export const pendingRunMeta = ({
  decision,
  prompt,
  provider,
  state,
}: Pick<
  StartRunInput,
  "decision" | "prompt" | "provider" | "state"
>): RunEventMeta => ({
  modelClass: decision.agent.modelClass,
  project: state.activeProject,
  promptChars: prompt.length,
  provider,
  queueDepth: state.queue.length,
  runId: crypto.randomUUID(),
  threadId: state.threadId,
  userId: state.userId,
});

/**
 * Start one prompt run without any chat in sight: pick the directory, resume
 * the session, route the model once per conversation and start the run. The
 * caller consumes `events`; `meta` is the run's wide-event context, keyed by
 * the registry's run id.
 */
export const startPromptRun = Effect.fn("Run.start")(function* (
  input: StartRunInput
) {
  const { decision, projectsDir, provider, routing, state } = input;
  // A PDF sent with the prompt may still be turning into text; a stop or a
  // reset meanwhile finds no run to stop (`cancelPendingStart`).
  const { resets } = state;
  const prompt = yield* Effect.promise(
    async () => await settlePdfTexts(input.prompt)
  );
  if (state.resets !== resets) {
    return yield* new AgentInterrupted({ reason: "stopped" });
  }
  const pending = pendingRunMeta(input);
  const runState = routeView(state, provider);
  const runDir = runDirOf(decision, state);
  const project = runDir.projectPath;
  const sessionId = decision.agent.persistSession
    ? yield* sessionIdFor(runState, runDir)
    : undefined;
  const projectName =
    project === projectsDir ? "general" : path.basename(project);
  const branchName =
    decision.scratch !== false || project === projectsDir
      ? null
      : getCurrentBranch(project);
  // A light run is pinned to the owner's light choice (`/settings`), read
  // only for one.
  const lightChoice =
    decision.agent.modelClass === "light"
      ? yield* Effect.promise(readLightChoice)
      : undefined;
  // A captionless document keeps no pick, so the words after it are routed
  // as reading it too.
  const { unpicked } = state;
  const document =
    carriesDocument(prompt) ||
    (unpicked?.document === true &&
      unpicked.provider === provider &&
      unpicked.project === state.activeProject);
  const { images, ...route } = routing;
  const picked = yield* runModelFor({
    modelClass: decision.agent.modelClass,
    routing: { ...route, carriesDocument: document },
    runDir,
    state: runState,
  });
  state.unpicked =
    picked?.unstored === true
      ? { document, project: state.activeProject, provider }
      : undefined;
  // The route answers through another provider now; the switch already
  // stopped every running run there, and this one goes the same way.
  if (input.routeSwitched()) {
    return yield* new AgentInterrupted({ reason: "switched" });
  }

  const started = yield* runAgent(provider, {
    access: decision.agent,
    chatId: state.chatId,
    effort: picked?.effort,
    images,
    lightChoice,
    model: picked?.model,
    persona: input.persona,
    projectDir: project,
    prompt,
    sessionId,
    taskAuthor: input.taskAuthor,
    threadId: state.threadId,
    userId: state.userId,
    // A conversation stays open for background work it started, as a prompt
    // task's fire does (`runTaskPrompt`); a Business reply never does.
    waitForBackground: true,
  });
  const { runId } = started;
  // `/history` lists every session a remembered conversation runs on: it is
  // recorded when it starts and again when the run ends on it. The repo is
  // taken here, so the stream the chat renders needs no service.
  const history = yield* SessionHistoryRepo;
  // `/context` reads how full the session it resumes is: every run that
  // keeps its session records it, scratch ones too.
  const contexts = yield* SessionContextRepo;
  const measured = decision.agent.persistSession
    ? started.events.pipe(
        Stream.tap((event) =>
          event.kind === "context"
            ? recordSessionContext({
                event,
                model: started.model,
                provider,
              }).pipe(Effect.provideService(SessionContextRepo, contexts))
            : Effect.void
        )
      )
    : started.events;
  // The model the provider reports wins over the pick: pi resolves its
  // default itself and names it only with a context figure.
  let reported: string | undefined;
  const recordOn = (onSession: string) =>
    recordRunSession({
      effort: picked?.effort,
      model: reported ?? picked?.model,
      runDir,
      runState,
      sessionId: onSession,
      text: routing.message,
    }).pipe(Effect.provideService(SessionHistoryRepo, history));
  const events = keepsHistory(decision)
    ? measured.pipe(
        Stream.tap((event) => {
          if (event.kind === "session_init" || event.kind === "result") {
            return recordOn(event.sessionId);
          }
          if (
            event.kind === "context" &&
            event.model !== undefined &&
            event.model !== reported
          ) {
            reported = event.model;
            return recordOn(event.sessionId);
          }
          return Effect.void;
        })
      )
    : measured;

  const meta: RunEventMeta = {
    ...pending,
    effort: picked?.effort,
    model: picked?.model,
    project,
    runId,
  };
  return {
    branchName,
    events,
    meta,
    projectName,
    runDir,
    runState,
    sessionId,
    unread: started.unread,
  };
});
