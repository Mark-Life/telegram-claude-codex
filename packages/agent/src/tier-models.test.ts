import { describe, expect, test } from "bun:test";

import { parseTierModels } from "@workspace/env/bot";
import { Option, Result } from "effect";

import {
  DEFAULT_TIER_MODELS,
  defaultTierModels,
  envTierModels,
  resolveOffered,
  tierModelsFor,
} from "./codex-models";
import { clampTier } from "./tier-models";

/** What three real accounts' `models_cache.json` offered under Codex 0.171. */
const GO_PLAN = new Set([
  "gpt-reserve",
  "gpt-6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "codex-auto-review",
]);
const NEWEST = new Set([
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const NO_GPT_6_2 = new Set([
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

describe("defaultTierModels", () => {
  test("with no list, each tier runs its newest candidate", () => {
    expect(defaultTierModels()).toEqual({
      astra: "gpt-6.2-astra",
      luna: "gpt-6-luna",
      sol: "gpt-6.2-sol",
      terra: "gpt-6.1-terra",
    });
  });

  test("a list with the newest models runs each tier on them", () => {
    expect(defaultTierModels(NEWEST)).toEqual({
      astra: "gpt-6.2-astra",
      luna: "gpt-6-luna",
      sol: "gpt-6.2-sol",
      terra: "gpt-6.1-terra",
    });
  });

  test("a list without GPT-6.2 falls back a generation for Sol and Astra", () => {
    expect(defaultTierModels(NO_GPT_6_2)).toEqual({
      astra: "gpt-6-astra",
      luna: "gpt-6-luna",
      sol: "gpt-6.1-sol",
      terra: "gpt-6.1-terra",
    });
  });

  test("a Go plan gets Luna and GPT-5.6 Terra, and no Sol or Astra", () => {
    expect(defaultTierModels(GO_PLAN)).toEqual({
      luna: "gpt-6-luna",
      terra: "gpt-5.6-terra",
    });
  });

  test("a list with none of the candidates keeps the newest ones", () => {
    expect(defaultTierModels(new Set(["gpt-9"]))).toBe(DEFAULT_TIER_MODELS);
  });
});

describe("tierModelsFor", () => {
  test("an env map replaces the candidates, narrowed to the list", () => {
    const env = { luna: "gpt-5.6-luna", sol: "gpt-6.2-sol" };

    expect(tierModelsFor(GO_PLAN, env)).toEqual({ luna: "gpt-5.6-luna" });
    expect(tierModelsFor(undefined, env)).toEqual(env);
  });
});

describe("resolveOffered", () => {
  test("a stored older candidate the list lacks moves within its tier's reach", () => {
    expect(resolveOffered("gpt-6-sol", GO_PLAN)).toBe("gpt-5.6-terra");
    expect(resolveOffered("gpt-6.1-terra", GO_PLAN)).toBe("gpt-5.6-terra");
  });

  test("a stored slug the list offers is kept", () => {
    expect(resolveOffered("gpt-6-sol", NO_GPT_6_2)).toBe("gpt-6-sol");
  });
});

describe("envTierModels", () => {
  test("unset or blank is no map", () => {
    expect(envTierModels()).toBeUndefined();
    expect(envTierModels("  ")).toBeUndefined();
  });

  test("a set map is taken as written", () => {
    expect(envTierModels("luna=gpt-5.6-luna,sol=gpt-5.6-sol")).toEqual({
      luna: "gpt-5.6-luna",
      sol: "gpt-5.6-sol",
    });
  });

  test("a malformed env map throws the parser's message", () => {
    expect(() => envTierModels("mars=gpt-6-mars")).toThrow(
      'CODEX_TIER_MODELS: unknown tier "mars"'
    );
  });
});

describe("parseTierModels", () => {
  test("reads pairs, trimming around the separators", () => {
    const parsed = parseTierModels(" luna = gpt-6-luna , terra=gpt-5.6-terra ");

    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(Option.getOrNull(parsed.success)).toEqual({
        luna: "gpt-6-luna",
        terra: "gpt-5.6-terra",
      });
    }
  });

  test("blank input is no map at all", () => {
    const parsed = parseTierModels("");

    expect(Result.isSuccess(parsed) && Option.isNone(parsed.success)).toBe(
      true
    );
  });

  test.each([
    ["luna", 'malformed pair "luna"'],
    ["luna=", 'malformed pair "luna="'],
    ["luna=a=b", 'malformed pair "luna=a=b"'],
    ["mars=gpt-6-mars", 'unknown tier "mars"'],
    ["sol=gpt-6-sol,sol=gpt-5.6-sol", 'tier "sol" given twice'],
  ])("%p fails", (raw, message) => {
    const parsed = parseTierModels(raw);

    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure).toContain(message);
    }
  });
});

describe("clampTier", () => {
  test("every tier of the defaults is its own slug", () => {
    expect(clampTier(DEFAULT_TIER_MODELS, "luna")).toBe("gpt-6-luna");
    expect(clampTier(DEFAULT_TIER_MODELS, "terra")).toBe("gpt-6.1-terra");
    expect(clampTier(DEFAULT_TIER_MODELS, "sol")).toBe("gpt-6.2-sol");
    expect(clampTier(DEFAULT_TIER_MODELS, "astra")).toBe("gpt-6.2-astra");
  });

  test("a missing tier ties to the stronger neighbour", () => {
    const { terra: _terra, ...withoutTerra } = DEFAULT_TIER_MODELS;

    expect(clampTier(withoutTerra, "terra")).toBe("gpt-6.2-sol");
  });

  test("a missing edge tier moves inward", () => {
    expect(clampTier({ sol: "gpt-6-sol" }, "luna")).toBe("gpt-6-sol");
    expect(clampTier({ luna: "gpt-6-luna" }, "astra")).toBe("gpt-6-luna");
  });

  test("the nearer tier wins over the stronger one", () => {
    expect(
      clampTier({ astra: "gpt-6-astra", luna: "gpt-6-luna" }, "terra")
    ).toBe("gpt-6-luna");
  });

  test("an empty map has no slug", () => {
    expect(clampTier({}, "terra")).toBeUndefined();
  });
});
