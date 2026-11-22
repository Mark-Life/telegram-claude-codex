import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunHttpPlatform, BunServices } from "@effect/platform-bun";
import { Providers } from "@workspace/agent";
import type { EffectiveProviders } from "@workspace/agent";
import { ApiAuth, BotApi, CurrentPrincipal } from "@workspace/api";
import type { Principal } from "@workspace/api";
import { Database, SettingsRepo, UserSettingsRepo } from "@workspace/db";
import type { SettingChange, SettingKey } from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import {
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpApiTest } from "effect/http-api";
import * as Etag from "effect/http/Etag";

import { tierIds } from "../settings/options";
import { SettingsPorts, SettingsService } from "../settings/service";
import { InputErrorsLive } from "./server";
import { SettingsLive } from "./settings";

/**
 * The settings endpoints end to end, short of a socket: the real contract,
 * handlers and `SettingsService` over a throwaway SQLite file, with the
 * providers, the key check and the bot's side effects stubbed. Never `.data`.
 */

const OWNER: Principal = {
  keyId: "aaaaaaaaaaaa",
  keyName: "test",
  telegramUserId: 1,
  tier: "owner",
};

const EXECUTOR: Principal = {
  keyId: "bbbbbbbbbbbb",
  keyName: "test",
  telegramUserId: 2,
  tier: "executor",
};

/** Who the next request acts as. */
let actor = OWNER;

/** What the service asked the bot to do. */
const effects: string[] = [];
const written: SettingChange[] = [];

const PROVIDERS: EffectiveProviders = {
  default: "codex",
  helpers: { format: "codex", judge: "codex", title: "codex" },
  light: "codex",
  snapshots: {
    claude: { checkedAt: 1, id: "claude", status: "ready" },
    codex: { checkedAt: 1, id: "codex", status: "ready" },
    pi: { checkedAt: 1, id: "pi", status: "missing" },
  },
};

const config = {
  allowedUserId: OWNER.telegramUserId,
  api: Option.none(),
  botToken: Redacted.make("x"),
  bwrapBin: Option.none(),
  claudeBin: Option.none(),
  codexBin: Option.none(),
  defaultTz: "Europe/Sofia",
  elevenLabsApiKey: Option.none(),
  eventLogPath: "/dev/null",
  executorApiKey: Option.none(),
  executorMcpUrl: Option.none(),
  executorVersion: "v1",
  groqApiKey: Redacted.make("x"),
  maxBackgroundRuns: 20,
  maxConcurrentRuns: 4,
  piBin: Option.none(),
  projectsDir: "/tmp",
  socatBin: Option.none(),
  telegramAccount: Option.none(),
  typesafeApiKey: Option.none(),
  workDir: Option.none(),
} satisfies typeof AppConfig.Service;

const portsLayer = Layer.succeed(
  SettingsPorts,
  SettingsPorts.of({
    account: Effect.succeed({ kind: "off" }),
    languageChanged: (language) =>
      Effect.sync(() => {
        effects.push(`language:${language}`);
      }),
    piModels: Effect.succeed({ checkedAt: 0, models: [], version: "0" }),
    runLimitChanged: (limit) =>
      Effect.sync(() => {
        effects.push(`runLimit:${limit}`);
      }),
    voices: Effect.succeed({ kind: "off" }),
    workspaceCleared: Effect.sync(() => {
      effects.push("workspaceCleared");
    }),
    written: (changes) =>
      Effect.sync(() => {
        written.push(...changes);
      }),
  })
);

const providersLayer = Layer.succeed(
  Providers,
  Providers.of({
    current: Effect.succeed(PROVIDERS),
    reprobe: () => Effect.succeed(PROVIDERS),
  })
);

/** The key check, stubbed: every request acts as `actor`. */
const authLayer = Layer.succeed(
  ApiAuth,
  ApiAuth.of({
    apiKey: (httpEffect) =>
      Effect.provideService(httpEffect, CurrentPrincipal, actor),
    bearer: (httpEffect) =>
      Effect.provideService(httpEffect, CurrentPrincipal, actor),
  })
);

let dir: string;
let runtime: ManagedRuntime.ManagedRuntime<
  SettingsRepo | SettingsService | UserSettingsRepo,
  unknown
>;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "settings-api-"));
  const db = Database.layer({ filename: path.join(dir, "bot.db") });
  const repos = Layer.mergeAll(SettingsRepo.layer, UserSettingsRepo.layer);
  runtime = ManagedRuntime.make(
    SettingsService.layer.pipe(
      Layer.provideMerge(repos),
      Layer.provide(
        Layer.mergeAll(
          portsLayer,
          providersLayer,
          Layer.succeed(AppConfig, config)
        )
      ),
      Layer.provide(db),
      Layer.provide(Logger.layer([]))
    )
  );
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(dir, { force: true, recursive: true });
});

beforeEach(async () => {
  actor = OWNER;
  effects.length = 0;
  written.length = 0;
  // Every test starts from a table with nothing set.
  await runtime.runPromise(
    Effect.gen(function* () {
      const repo = yield* SettingsRepo;
      const keys = [
        "bot_language",
        "codex_settings",
        "default_tz",
        "helper_title_effort",
        "helper_title_model",
        "helper_title_pi_model",
        "helper_title_provider",
        "light_model",
        "light_provider",
        "max_concurrent_runs",
        "steer",
        "tts_model",
        "workspace_chat_id",
        "workspace_thread_id",
      ] as const satisfies readonly SettingKey[];
      yield* repo.apply(keys.map((key) => ({ key, value: null })));
    })
  );
});

const makeClient = () => HttpApiTest.groups(BotApi, ["settings"]);

/**
 * Run `use` with a client of the settings group, over the test runtime;
 * every other group is a placeholder that fails if called.
 */
const call = async <A>(
  use: (
    client: Effect.Success<ReturnType<typeof makeClient>>
  ) => Effect.Effect<A, unknown>
) =>
  await runtime.runPromise(
    Effect.scoped(Effect.flatMap(makeClient(), use)).pipe(
      Effect.provide(
        SettingsLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              authLayer,
              InputErrorsLive,
              BunHttpPlatform.layer,
              Etag.layer,
              BunServices.layer
            )
          )
        )
      )
    )
  );

/** An API error as a client sees it: its tag and message. */
const decodeFailure = Schema.decodeUnknownSync(
  Schema.Struct({ _tag: Schema.String, message: Schema.String })
);

type Failure = ReturnType<typeof decodeFailure>;

/** The tagged error a call failed with. */
const failure = async (
  use: (
    client: Effect.Success<ReturnType<typeof makeClient>>
  ) => Effect.Effect<unknown, unknown>
) => decodeFailure(await call((client) => Effect.flip(use(client))));

const tagOf = (error: Failure) => error._tag;

const messageOf = (error: Failure) => error.message;

describe("settings.getBot / updateBot", () => {
  test("reads the defaults of a bot with nothing set", async () => {
    const bot = await call((client) => client.settings.getBot());
    expect(bot.guests).toBe(true);
    expect(bot.steer).toBe(true);
    expect(bot.language).toBe("en");
    expect(bot.verbosity).toBe("quiet");
    expect(bot.timeZone).toBe("Europe/Sofia");
    expect(bot.maxConcurrentRuns).toBe(4);
    expect(bot.workspace).toBeNull();
    // The account feature is off here: no write mode to show.
    expect(bot.accountWrites).toBeUndefined();
    expect(bot.options.maxConcurrentRuns).toEqual([1, 2, 3, 5]);
  });

  test("changes several fields at once and sets off what follows", async () => {
    const bot = await call((client) =>
      client.settings.updateBot({
        payload: {
          language: "en",
          limits: { groupRunsPerDay: "off", privateRunsPerUser: 100 },
          maxConcurrentRuns: 2,
          steer: false,
          timeZone: "berlin",
        },
      })
    );
    expect(bot.language).toBe("en");
    expect(bot.steer).toBe(false);
    expect(bot.limits.groupRunsPerDay).toBe("off");
    expect(bot.limits.privateRunsPerUser).toBe(100);
    expect(bot.maxConcurrentRuns).toBe(2);
    expect(bot.timeZone).toBe("Europe/Berlin");
    expect(effects).toEqual(["language:en", "runLimit:2"]);
    // The cache hears of every row written.
    expect(written).toContainEqual({ key: "steer", value: "off" });
  });

  test("never reads a count that is not one as no limit", async () => {
    // A forged `settings:<limit>:abc` press reaches the service as NaN.
    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        return yield* Effect.flip(
          settings.updateBot({ limits: { groupRunsPerDay: Number.NaN } })
        );
      })
    );
    expect(refused._tag).toBe("SettingRefused");
    expect(written).toEqual([]);
  });

  test("refuses a value the setting does not offer, storing nothing", async () => {
    const error = await failure((client) =>
      client.settings.updateBot({
        payload: { maxConcurrentRuns: 4, steer: false },
      })
    );
    expect(tagOf(error)).toBe("InvalidInput");
    expect(messageOf(error)).toContain("`maxConcurrentRuns` cannot be `4`");
    const bot = await call((client) => client.settings.getBot());
    expect(bot.steer).toBe(true);
    expect(written).toEqual([]);
  });

  test("refuses an unknown zone and a write mode with no account", async () => {
    const zone = await failure((client) =>
      client.settings.updateBot({ payload: { timeZone: "Atlantis" } })
    );
    expect(tagOf(zone)).toBe("InvalidInput");
    const writes = await failure((client) =>
      client.settings.updateBot({ payload: { accountWrites: "direct" } })
    );
    expect(tagOf(writes)).toBe("Conflict");
  });

  test("forgets the workspace", async () => {
    await runtime.runPromise(
      SettingsRepo.use((repo) =>
        repo.apply([
          { key: "workspace_chat_id", value: "-100123" },
          { key: "workspace_thread_id", value: "7" },
        ])
      )
    );
    const before = await call((client) => client.settings.getBot());
    expect(before.workspace).toEqual({ chatId: -100_123, threadId: 7 });
    const after = await call((client) =>
      client.settings.updateBot({ payload: { workspace: null } })
    );
    expect(after.workspace).toBeNull();
    expect(effects).toEqual(["workspaceCleared"]);
  });

  test("is the owner's alone", async () => {
    actor = EXECUTOR;
    const read = await failure((client) => client.settings.getBot());
    expect(tagOf(read)).toBe("Forbidden");
    const write = await failure((client) =>
      client.settings.updateBot({ payload: { steer: false } })
    );
    expect(tagOf(write)).toBe("Forbidden");
    for (const denied of [
      await failure((client) => client.settings.getLight()),
      await failure((client) => client.settings.getHelpers()),
      await failure((client) => client.settings.getVoice()),
      await failure((client) =>
        client.settings.updateLight({ payload: { provider: "claude" } })
      ),
    ]) {
      expect(tagOf(denied)).toBe("Forbidden");
    }
    actor = OWNER;
    const bot = await call((client) => client.settings.getBot());
    expect(bot.steer).toBe(true);
  });
});

describe("settings.getMine / updateMine", () => {
  test("every key holder has their own", async () => {
    actor = EXECUTOR;
    const mine = await call((client) =>
      client.settings.updateMine({
        payload: { effort: "high", provider: "claude" },
      })
    );
    expect(mine.provider).toBe("claude");
    expect(mine.startsOn).toBe("claude");
    expect(mine.effort).toBe("high");
    actor = OWNER;
    const owners = await call((client) => client.settings.getMine());
    expect(owners.provider).toBeNull();
    expect(owners.startsOn).toBe("codex");
  });

  test("checks the model on the provider new chats start on", async () => {
    const [tier] = tierIds("codex");
    if (tier === undefined) {
      throw new Error("codex lists no tier");
    }
    const mine = await call((client) =>
      client.settings.updateMine({ payload: { model: tier } })
    );
    expect(mine.model).toBe(tier);
    expect(mine.options.model).toContain(tier);
    const error = await failure((client) =>
      client.settings.updateMine({ payload: { model: "gpt-0" } })
    );
    expect(tagOf(error)).toBe("InvalidInput");
  });

  test("refuses a provider that cannot run now", async () => {
    const error = await failure((client) =>
      client.settings.updateMine({ payload: { provider: "pi" } })
    );
    expect(tagOf(error)).toBe("Conflict");
    expect(messageOf(error)).toContain("`pi` cannot run now");
  });
});

describe("settings light, helpers and voice", () => {
  test("light runs take a ready provider", async () => {
    const light = await call((client) =>
      client.settings.updateLight({ payload: { provider: "claude" } })
    );
    expect(light.provider).toBe("claude");
    expect(light.listed).toBe("claude");
    const error = await failure((client) =>
      client.settings.updateLight({ payload: { provider: "pi" } })
    );
    expect(tagOf(error)).toBe("InvalidInput");
  });

  test("a helper pass on Auto has no model of its own", async () => {
    const error = await failure((client) =>
      client.settings.updateHelper({
        params: { use: "title" },
        payload: { model: "default" },
      })
    );
    expect(tagOf(error)).toBe("InvalidInput");
    const passes = await call((client) =>
      client.settings.updateHelper({
        params: { use: "title" },
        payload: { effort: "default", provider: "claude" },
      })
    );
    expect(passes.title.provider).toBe("claude");
    expect(passes.title.runsOn).toEqual({
      auto: false,
      model: null,
      provider: "claude",
    });
    expect(passes.format.runsOn.auto).toBe(true);
  });

  test("a voice needs voice replies set up", async () => {
    const voice = await call((client) =>
      client.settings.updateVoice({ payload: { model: "eleven_v4_turbo" } })
    );
    expect(voice.model).toBe("eleven_v4_turbo");
    expect(voice.configured).toBe(false);
    const error = await failure((client) =>
      client.settings.updateVoice({ payload: { voice: "abc" } })
    );
    expect(tagOf(error)).toBe("Conflict");
  });
});

describe("settings.getProviders / updateProvider", () => {
  test("lists each provider's allowlist", async () => {
    const { providers } = await call((client) =>
      client.settings.getProviders()
    );
    const codex = providers.find(({ provider }) => provider === "codex");
    const verbosity = codex?.settings.find(
      ({ key }) => key === "model_verbosity"
    );
    expect(verbosity?.kind).toBe("choice");
    expect(verbosity?.value).toBeNull();
    expect(verbosity?.options).toContain("low");
  });

  test("sets and unsets a value it offers", async () => {
    const set = await call((client) =>
      client.settings.updateProvider({
        params: { provider: "codex" },
        payload: { model_verbosity: "low" },
      })
    );
    expect(
      set.settings.find(({ key }) => key === "model_verbosity")?.value
    ).toBe("low");
    const unset = await call((client) =>
      client.settings.updateProvider({
        params: { provider: "codex" },
        payload: { model_verbosity: null },
      })
    );
    expect(
      unset.settings.find(({ key }) => key === "model_verbosity")?.value
    ).toBeNull();
  });

  test("refuses a key or value off the allowlist", async () => {
    const key = await failure((client) =>
      client.settings.updateProvider({
        params: { provider: "codex" },
        payload: { sandbox_mode: "danger-full-access" },
      })
    );
    expect(tagOf(key)).toBe("InvalidInput");
    const value = await failure((client) =>
      client.settings.updateProvider({
        params: { provider: "codex" },
        payload: { model_verbosity: "loud" },
      })
    );
    expect(tagOf(value)).toBe("InvalidInput");
    expect(messageOf(value)).toContain("`low`");
  });

  test("is the owner's alone", async () => {
    actor = EXECUTOR;
    const error = await failure((client) =>
      client.settings.updateProvider({
        params: { provider: "codex" },
        payload: { model_verbosity: "low" },
      })
    );
    expect(tagOf(error)).toBe("Forbidden");
  });
});
