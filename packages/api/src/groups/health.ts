import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

export const Health = Schema.Struct({
  status: Schema.Literal("ok").annotate({
    description: "Always `ok` when the bot answers at all.",
  }),
}).annotate({ identifier: "Health" });

/** Public: whether the bot's API answers. Needs no key. */
export const HealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("get", "/v1/health", { success: Health }).annotateMerge(
      OpenApi.annotations({
        description:
          'Check that the bot is up.\n\nNeeds no API key. Answers `{status: "ok"}` while the bot process runs.',
        identifier: "health.get",
        summary: "Check that the bot is up",
      })
    )
  )
  .annotateMerge(
    OpenApi.annotations({
      description: "Liveness of the bot's API. Public.",
      title: "health",
    })
  );
