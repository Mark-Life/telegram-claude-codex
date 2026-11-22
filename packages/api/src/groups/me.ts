import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

import { ApiAuth } from "../middleware";
import { PrincipalSchema } from "../principal";

/** Who the key acts as. */
export const MeGroup = HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("get", "/v1/me", {
      success: PrincipalSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Show who this API key acts as.\n\nThe Telegram user the key belongs to, their tier as of this request, and the key's id and name. A key acts exactly as that user writing to the bot in a private chat.",
        identifier: "me.get",
        summary: "Show who this API key acts as",
      })
    )
  )
  .middleware(ApiAuth)
  .annotateMerge(
    OpenApi.annotations({
      description: "The identity behind the API key in use.",
      title: "me",
    })
  );
