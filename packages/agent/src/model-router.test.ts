import { describe, expect, test } from "bun:test";

import { pickFor, ROUTER_FALLBACK } from "./model-router";
import type { RouteScores } from "./model-router";

/** A confident one-step request that writes something: everyday work. */
const EVERYDAY: RouteScores = {
  costOfError: 1,
  depthConfidence: 0.9,
  isSmallTalk: 0.05,
  needsCodeChanges: 0.05,
  needsHeavyConnector: 0.05,
  proseQualityMatters: 0.05,
  reasoningDepth: 1,
  workSize: 1,
};

const scores = (overrides: Partial<RouteScores>) => ({
  ...EVERYDAY,
  ...overrides,
});

describe("pickFor", () => {
  test("small talk runs on Luna at low effort", () => {
    expect(pickFor(scores({ isSmallTalk: 0.9, reasoningDepth: 0.2 }))).toEqual({
      effort: "low",
      tier: "luna",
    });
  });

  test("a read-only lookup runs on Luna", () => {
    expect(pickFor(scores({ costOfError: 0.2 })).tier).toBe("luna");
  });

  test("everyday work runs on Terra", () => {
    expect(pickFor(EVERYDAY).tier).toBe("terra");
  });

  test("work past the second level of depth runs on Sol", () => {
    expect(pickFor(scores({ reasoningDepth: 2.6 }))).toEqual({
      effort: "medium",
      tier: "sol",
    });
  });

  test("the database and code changes raise a pick to Sol", () => {
    expect(pickFor(scores({ needsHeavyConnector: 0.9 })).tier).toBe("sol");
    expect(pickFor(scores({ needsCodeChanges: 0.8 })).tier).toBe("sol");
  });

  test("prose the owner signs runs on Astra", () => {
    expect(pickFor(scores({ proseQualityMatters: 0.8 })).tier).toBe("astra");
  });

  test("an unsure depth steps one tier up and stops at Sol", () => {
    expect(
      pickFor(scores({ costOfError: 0.2, depthConfidence: 0.3 })).tier
    ).toBe("terra");
    expect(pickFor(scores({ depthConfidence: 0.3 })).tier).toBe("sol");
    expect(
      pickFor(scores({ depthConfidence: 0.3, reasoningDepth: 2.6 })).tier
    ).toBe("sol");
  });

  test("an irreversible step is never answered at low effort", () => {
    expect(pickFor(scores({ costOfError: 0.2 })).effort).toBe("low");
    expect(pickFor(scores({ costOfError: 1.8 })).effort).toBe("medium");
  });
});

describe("ROUTER_FALLBACK", () => {
  test("is Terra at medium effort", () => {
    expect(ROUTER_FALLBACK).toEqual({ effort: "medium", tier: "terra" });
  });
});
