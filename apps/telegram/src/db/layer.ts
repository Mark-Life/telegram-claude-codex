import { SessionStore } from "@workspace/agent";
import { Database, DbRepos } from "@workspace/db";
import { Layer } from "effect";

import { ThreadsRepo } from "./threads";

/**
 * Every repository the bot uses, over the one process-wide client on
 * `.data/bot.db`: the shared tables from `@workspace/db`, the bot-owned
 * `threads` and the agent's `sessions` (`SessionStore`). `SqlClient` stays
 * hidden (`Layer.provide`): no app code runs raw SQL. Building it opens and
 * migrates the db, so a broken db stops the boot before polling starts.
 *
 * Import rule: `runtime.ts` imports this module only; nothing it imports may
 * import `./bridge` or `./index`.
 */
export const DbLive = Layer.mergeAll(
  DbRepos.layer,
  ThreadsRepo.layer,
  SessionStore.layer
).pipe(Layer.provide(Database.live));
