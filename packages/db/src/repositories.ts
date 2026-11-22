import { Layer } from "effect";

import { AccountActionsRepo } from "./account-actions";
import { ApiKeyService, ApiKeysRepo } from "./api-keys";
import { ApiRunsRepo } from "./api-runs";
import { BackgroundRunsRepo } from "./background-runs";
import { BusinessMemoryRepo } from "./business-memory";
import { ComposeRepo } from "./compose";
import { GroupMemoryRepo } from "./group-memory";
import { GroupsRepo } from "./groups";
import { QuotaRepo } from "./quota";
import { ReminderService } from "./reminder-service";
import { RemindersRepo } from "./reminders";
import { SessionContextRepo } from "./session-context";
import { SessionHistoryRepo } from "./session-history";
import { SettingsRepo } from "./settings";
import { TaskService } from "./task-service";
import { TasksRepo } from "./tasks";
import { TopicsRepo } from "./topics";
import { UserSettingsRepo } from "./user-settings";
import { UsersRepo } from "./users";

/**
 * Every repository `@workspace/db` owns, over one `SqlClient`, as the module
 * `DbRepos`: `DbRepos.layer` to provide them, `DbRepos.Services` to require
 * them. The caller provides the client — `Database.live` in the bot and the
 * CLIs, a temp file in tests. Building a repository does no IO: each one only
 * prepares its queries against the client it is given.
 */
const repositories = Layer.mergeAll(
  AccountActionsRepo.layer,
  ApiKeysRepo.layer,
  ApiRunsRepo.layer,
  BackgroundRunsRepo.layer,
  BusinessMemoryRepo.layer,
  ComposeRepo.layer,
  GroupMemoryRepo.layer,
  GroupsRepo.layer,
  QuotaRepo.layer,
  RemindersRepo.layer,
  SessionContextRepo.layer,
  SessionHistoryRepo.layer,
  SettingsRepo.layer,
  TasksRepo.layer,
  TopicsRepo.layer,
  UserSettingsRepo.layer,
  UsersRepo.layer
);

/**
 * The repositories plus the services that are only rules over them
 * (`ApiKeyService`, `TaskService`, `ReminderService`), so every process that
 * opens the db shares the rules too.
 */
export const layer = Layer.mergeAll(
  ApiKeyService.layer,
  ReminderService.layer,
  TaskService.layer
).pipe(Layer.provideMerge(repositories));

/** The repository tags `layer` provides. */
export type Services = Layer.Success<typeof layer>;
