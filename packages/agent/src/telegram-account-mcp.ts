import type { TaskStamp } from "@workspace/db";
import type { AccountWriteMode } from "@workspace/env/bot";
import { Context } from "effect";
import type { Effect, Option } from "effect";

/**
 * Where a run reaches the owner's own Telegram account: the MCP server the
 * bot process serves on loopback, with a bearer token minted for the user the
 * run works for, so a write it asks for names that user in the confirmation.
 * `writes` is what the run prompt tells the model about sends and edits.
 */
export interface AccountMcpEndpoint {
  readonly token: string;
  readonly url: string;
  readonly writes: AccountWriteMode;
}

/**
 * The host's answer to "may a run be given the account tools right now". The
 * app provides it: this package never imports the app, so the server, the
 * session and the login state stay there. `endpoint` is none while the
 * feature is off or the account is logged out. `requester` is the run's
 * stamp: the owner or an executor, by id. Optional: a registry built without
 * it wires no account tools.
 */
export class TelegramAccountMcp extends Context.Service<
  TelegramAccountMcp,
  {
    readonly endpoint: (
      requester: TaskStamp
    ) => Effect.Effect<Option.Option<AccountMcpEndpoint>>;
  }
>()("@workspace/agent/TelegramAccountMcp") {}
