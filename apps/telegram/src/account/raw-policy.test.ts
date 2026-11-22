import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { RAW_NAMESPACES } from "./raw-policy";
import { namespaceOf, readApiSchema } from "./raw-schema";

describe("raw policy", () => {
  test("covers every namespace of the TL layer mtcute ships", async () => {
    const api = await Effect.runPromise(readApiSchema);
    const uncovered = new Set(
      api.e
        .filter((entry) => entry.kind === "method")
        .map((entry) => namespaceOf(entry.name))
        .filter((namespace) => !RAW_NAMESPACES.has(namespace))
    );
    // A new layer added these: classify or deny them in RAW_NAMESPACES.
    expect([...uncovered]).toEqual([]);
  });
});
