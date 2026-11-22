import { Effect } from "effect";

import { createAccessWatcher } from "../access/audit";
import { createReminderScheduler } from "../reminders/scheduler";
import { createTaskScheduler } from "../tasks";
import { sendTo } from "../telegram/bridge";
import { registerAccountHandlers } from "./account";
import { registerApiKeyHandlers } from "./apikeys";
import { registerBusinessHandlers } from "./business";
import { registerComposeHandlers } from "./compose";
import { registerContextHandlers } from "./context";
import type { HandlerDeps } from "./deps";
import { registerGroupHandlers } from "./group";
import { registerHistoryHandlers } from "./history";
import { registerLoginHandlers } from "./login";
import { registerMessageHandlers } from "./messages";
import { registerModelEffortHandlers } from "./model-effort";
import { presentPlan, registerPlanHandlers } from "./plan";
import { registerProviderHandlers } from "./provider";
import { registerReminderHandlers } from "./reminders";
import { createRunPipeline } from "./run";
import { registerSessionCommands } from "./session-commands";
import { registerSettingsHandlers } from "./settings";
import { registerQueueCallbacks } from "./status";
import { registerTaskHandlers } from "./tasks";
import { registerTopicTitleHandlers } from "./topic-titles";
import { registerUploadHandlers } from "./uploads";
import { registerUsageHandlers } from "./usage";
import { registerUserHandlers } from "./users";
import { registerWorkspaceHandlers } from "./workspace";

export type { HandlerDeps, RunPipeline } from "./deps";
export { backfillGroupRegistry } from "./group";
export { cleanupStaleState } from "./user-state";
export { notifyChatId, notifyRoute, sendToNotifyRoute } from "./workspace";

/**
 * Wire every handler group onto the bot, and build the cron loop the task
 * commands mutate. Order matters: the compose interceptor
 * (`bot.on("message")`) must be registered before the typed message handlers so
 * composing swallows non-command messages. The schedulers and the access
 * watcher are returned unstarted: the entrypoint starts each in its own scope
 * once polling is up, and closing that scope stops them.
 */
export const registerHandlers = Effect.fnUntraced(function* (
  deps: HandlerDeps
) {
  const pipeline = createRunPipeline(deps, presentPlan);
  const scheduler = yield* createTaskScheduler(deps, pipeline);
  const reminderScheduler = createReminderScheduler(deps);
  // Straight to the owner's private chat, never the notify route: the change
  // the watcher reports may be the workspace itself being repointed, and the
  // route reads that destination from the db at send time.
  const accessWatcher = createAccessWatcher({
    notify: async (text) => {
      await sendTo({ chatId: deps.ownerId, threadId: null }, text);
    },
    pendingWork: deps.pendingWork,
  });
  // First: while a login waits for the cloud password, the account handler
  // takes that message before compose or a run could see it.
  const account = yield* registerAccountHandlers(deps);
  // Before compose too: while `/settings` waits for a time zone, the owner's
  // answer is taken here.
  yield* registerSettingsHandlers(deps);
  registerTaskHandlers(deps, scheduler);
  registerReminderHandlers(deps);
  registerUserHandlers(deps);
  // Before compose: while `/apikeys` waits for a key's name, the answer is
  // taken here.
  registerApiKeyHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerBusinessHandlers(deps);
  registerGroupHandlers(deps);
  registerTopicTitleHandlers(deps);
  registerComposeHandlers(deps, pipeline);
  registerSessionCommands(deps, pipeline);
  registerContextHandlers(deps);
  registerModelEffortHandlers(deps);
  registerLoginHandlers(deps, account);
  registerProviderHandlers(deps);
  registerHistoryHandlers(deps);
  registerUsageHandlers(deps);
  registerQueueCallbacks(deps);
  registerPlanHandlers(deps, pipeline);
  registerMessageHandlers(deps, pipeline);
  registerUploadHandlers(deps, pipeline);
  return { accessWatcher, pipeline, reminderScheduler, scheduler };
});
