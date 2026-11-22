import { Predicate } from "effect";
import { HttpApi, OpenApi } from "effect/http-api";

import { HealthGroup } from "./groups/health";
import { KeysGroup } from "./groups/keys";
import { MeGroup } from "./groups/me";
import { NotifyGroup } from "./groups/notify";
import { RemindersGroup } from "./groups/reminders";
import { RunsGroup } from "./groups/runs";
import { SettingsGroup } from "./groups/settings";
import { TasksGroup } from "./groups/tasks";
import { InputErrors } from "./middleware";

/**
 * The bearer scheme as `bearer`, not effect's `Bearer`. RFC 7235 makes the
 * name case-insensitive, but Executor's OpenAPI importer matches `bearer`
 * exactly and drops any other spelling, leaving only `x-api-key`.
 */
const lowercaseBearer = <Spec extends { readonly components?: unknown }>(
  spec: Spec
) => {
  const { components } = spec;
  if (
    Predicate.hasProperty(components, "securitySchemes") &&
    Predicate.hasProperty(components.securitySchemes, "bearer") &&
    Predicate.hasProperty(components.securitySchemes.bearer, "scheme") &&
    Predicate.isString(components.securitySchemes.bearer.scheme)
  ) {
    components.securitySchemes.bearer.scheme =
      components.securitySchemes.bearer.scheme.toLowerCase();
  }
  return spec;
};

/**
 * The bot's HTTP API: the same bot as in Telegram, a different door. A key
 * acts exactly as the Telegram user who made it, as if they wrote to the bot
 * in a private chat. The contract only: the server lives in the bot process.
 */
export const BotApi = HttpApi.make("bot")
  .add(
    HealthGroup,
    MeGroup,
    KeysGroup,
    TasksGroup,
    RemindersGroup,
    NotifyGroup,
    RunsGroup,
    SettingsGroup
  )
  .middleware(InputErrors)
  // A body field the endpoint does not know is a typo, never ignored: the
  // published schemas say `additionalProperties: false`, and so does this.
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .annotateMerge(
    OpenApi.annotations({
      description:
        "Your Telegram assistant bot over HTTP. An API key acts exactly as the Telegram user who made it with /apikeys, as if they wrote to the bot in a private chat, so treat a key like the bot itself. Every endpoint but `health.get` needs the key, as `Authorization: Bearer <key>` or `x-api-key: <key>`. Errors are JSON `{_tag, message}`.",
      title: "Telegram assistant bot API",
      transform: lowercaseBearer,
      version: "1.0.0",
    })
  );

/** The API as served at `url`: the OpenAPI document names it as its server. */
export const servedAt = (url: string) =>
  BotApi.annotate(OpenApi.Servers, [{ url }]);
