import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

import { Conflict, Forbidden, InvalidInput, Unavailable } from "../errors";
import { ApiAuth } from "../middleware";
import { TASK_EFFORTS, TASK_PROVIDERS } from "./tasks";

/**
 * The bot's settings, the same ones `/settings` shows in Telegram, under the
 * same rules: every operator reads and changes their own new-chat defaults
 * («Мои настройки»), the owner alone everything else. A change is checked
 * against what the setting offers now (each read lists it in `options`),
 * applied at once, without a restart, and answered with the setting as it
 * now stands. A change of several fields is checked whole before anything is
 * stored.
 */

/** The languages the bot speaks, as `/settings` cycles through them. */
export const SETTING_LANGUAGES = ["ru", "en"] as const;

/** How much of a run the chat shows. */
export const SETTING_VERBOSITIES = ["full", "quiet"] as const;

/** The owner's Telegram account write modes. */
export const SETTING_ACCOUNT_WRITES = ["confirm", "direct"] as const;

/** The helper passes, each with a choice of its own. */
export const HELPER_USES = ["format", "judge", "title"] as const;

const Provider = Schema.Literals(TASK_PROVIDERS).annotate({
  description: "A provider, as the bot names it.",
});

const Options = Schema.Array(Schema.String);

const OWNER_ONLY =
  "Owner only: anyone else gets `Forbidden`, as in Telegram, where only the owner sees this part of /settings.";

const REFUSALS =
  "`InvalidInput` when a value is not one the setting offers now (`message` lists them; a read shows them in `options`), `Conflict` when the bot's state does not allow it.";

// «Мои настройки» -----------------------------------------------------------

export const MySettingsSchema = Schema.Struct({
  effort: Schema.String.annotate({
    description:
      "What a new conversation's effort is: `auto` (the model router picks), `default` (the provider's own) or a level (`low`, `medium`, `high`, `xhigh`).",
  }),
  model: Schema.String.annotate({
    description:
      "What a new conversation's model is: `auto` (the model router picks), `default` (the provider's own) or a tier (`luna`, `terra`, `sol`, `astra`, weakest first), which each provider runs on its own model.",
  }),
  options: Schema.Struct({
    effort: Options,
    model: Options.annotate({
      description:
        "The values `model` takes now, on `startsOn`. On pi, which has no tiers, also every pi model by name (`provider/id`).",
    }),
    provider: Options,
  }).annotate({ description: "The values each field takes now." }),
  piModel: Schema.NullOr(Schema.String).annotate({
    description:
      "The pi model (`provider/id`) a new conversation on pi starts on; null keeps pi's default.",
  }),
  provider: Schema.NullOr(Schema.String).annotate({
    description:
      "The provider new conversations start on: a provider, `auto` (the one the bot detected), or null when nothing is chosen (they start where they always did).",
  }),
  startsOn: Provider.annotate({
    description:
      "The provider a new conversation would start on now; `options.model` lists its models.",
  }),
}).annotate({ identifier: "MySettings" });

export type MySettings = typeof MySettingsSchema.Type;

export const MySettingsUpdate = Schema.Struct({
  effort: Schema.optionalKey(
    Schema.Literals(["auto", "default", ...TASK_EFFORTS]).annotate({
      description:
        "`auto`, `default` or a level; `auto` only where the provider can be routed.",
    })
  ),
  model: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "`auto`, `default` or a tier the provider has; on pi a pi model by name. Checked on the provider new chats start on once `provider` is applied.",
    })
  ),
  provider: Schema.optionalKey(
    Schema.Literals(["auto", "none", ...TASK_PROVIDERS]).annotate({
      description:
        "A provider that can run now, `auto` for the detected one, or `none` to choose nothing.",
    })
  ),
}).annotate({ identifier: "MySettingsUpdate" });

// «Настройки бота» ----------------------------------------------------------

const Limit = Schema.Union([Schema.Int, Schema.Literal("off")]).annotate({
  description: "Runs a day, or `off` for no limit.",
});

const limitsOf = <S extends Schema.Top>(schema: S) =>
  Schema.Struct({
    groupRunsPerDay: schema.annotate({
      description: "Group runs a day, everyone together.",
    }),
    groupRunsPerUser: schema.annotate({
      description: "Group runs a day per person.",
    }),
    privateRunsPerDay: schema.annotate({
      description: "Private-chat runs a day, everyone together.",
    }),
    privateRunsPerUser: schema.annotate({
      description:
        "Private-chat runs a day per person; the owner and executors are exempt.",
    }),
  });

const Workspace = Schema.Struct({
  chatId: Schema.Int.annotate({ description: "The workspace group's id." }),
  threadId: Schema.NullOr(Schema.Int).annotate({
    description: "The topic it was set from; null for the whole group.",
  }),
}).annotate({ identifier: "Workspace" });

export const BotSettingsSchema = Schema.Struct({
  account: Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    status: Schema.Literals(["connected", "logged-out", "off"]).annotate({
      description:
        "The owner's Telegram account: `connected`, `logged-out` (log in with /login) or `off` (not configured). Read only.",
    }),
  }),
  accountWrites: Schema.optionalKey(
    Schema.Literals(SETTING_ACCOUNT_WRITES).annotate({
      description:
        "Whether a chat run's writes on the owner's Telegram account wait for the owner's button (`confirm`) or go at once (`direct`). Absent while the account feature is off. A run started over the API always waits for the button.",
    })
  ),
  guests: Schema.Boolean.annotate({
    description:
      "Whether strangers (guest tier) may write to the bot in private.",
  }),
  language: Schema.Literals(SETTING_LANGUAGES).annotate({
    description: "The language the bot itself speaks.",
  }),
  limits: limitsOf(Limit).annotate({ description: "The daily run budgets." }),
  markRead: Schema.Boolean.annotate({
    description:
      "Whether a chat the bot reads on the owner's Telegram account is marked read.",
  }),
  maxConcurrentRuns: Schema.Int.annotate({
    description: "Agent runs allowed at once.",
  }),
  options: Schema.Struct({
    limits: limitsOf(Schema.Array(Limit)),
    maxConcurrentRuns: Schema.Array(Schema.Int),
  }).annotate({
    description: "The values the budgets and the run limit take.",
  }),
  steer: Schema.Boolean.annotate({
    description:
      "Whether a message sent while a run works is folded into it (`true`) or waits for it to end.",
  }),
  timeZone: Schema.String.annotate({
    description:
      "The home time zone (IANA): reminders and tasks without a zone of their own use it.",
  }),
  verbosity: Schema.Literals(SETTING_VERBOSITIES).annotate({
    description:
      "`full` shows a run's steps, drafts and footer; `quiet` the answer alone.",
  }),
  voiceTranscript: Schema.Boolean.annotate({
    description: "Whether a voice note's transcript is shown in the chat.",
  }),
  workspace: Schema.NullOr(Workspace).annotate({
    description:
      "The workspace group set with /setworkspace; null when none is set.",
  }),
}).annotate({ identifier: "BotSettings" });

export type BotSettings = typeof BotSettingsSchema.Type;

export const BotSettingsUpdate = Schema.Struct({
  accountWrites: Schema.optionalKey(Schema.Literals(SETTING_ACCOUNT_WRITES)),
  guests: Schema.optionalKey(Schema.Boolean),
  language: Schema.optionalKey(Schema.Literals(SETTING_LANGUAGES)),
  limits: Schema.optionalKey(
    Schema.Struct({
      groupRunsPerDay: Schema.optionalKey(Limit),
      groupRunsPerUser: Schema.optionalKey(Limit),
      privateRunsPerDay: Schema.optionalKey(Limit),
      privateRunsPerUser: Schema.optionalKey(Limit),
    }).annotate({
      description: "Budgets to change, each one of `options.limits`.",
    })
  ),
  markRead: Schema.optionalKey(Schema.Boolean),
  maxConcurrentRuns: Schema.optionalKey(
    Schema.Int.annotate({ description: "One of `options.maxConcurrentRuns`." })
  ),
  steer: Schema.optionalKey(Schema.Boolean),
  timeZone: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "An IANA zone (`Europe/Berlin`), or a city only one zone ends in (`Berlin`).",
    })
  ),
  verbosity: Schema.optionalKey(Schema.Literals(SETTING_VERBOSITIES)),
  voiceTranscript: Schema.optionalKey(Schema.Boolean),
  workspace: Schema.optionalKey(
    Schema.Null.annotate({
      description:
        "`null` forgets the workspace. A workspace is set only with /setworkspace in the group.",
    })
  ),
}).annotate({ identifier: "BotSettingsUpdate" });

// «Группы и гости», «Служебные проходы» ------------------------------------

const ChoiceFields = {
  effort: Schema.String.annotate({
    description: "`default` (the usual) or a level.",
  }),
  model: Schema.String.annotate({
    description: "`default` (the usual) or a tier.",
  }),
  options: Schema.Struct({
    effort: Options,
    model: Options.annotate({
      description:
        "The values `model` takes now; on pi, which has no tiers, every pi model it can run, by name (`provider/id`).",
    }),
    provider: Options,
  }).annotate({ description: "The values each field takes now." }),
  piModel: Schema.NullOr(Schema.String).annotate({
    description:
      "The pi model named outright (`provider/id`), used on pi instead of a tier; null for none.",
  }),
  provider: Schema.String.annotate({
    description: "`default` (the bot's own choice) or a provider.",
  }),
};

export const LightSettingsSchema = Schema.Struct({
  ...ChoiceFields,
  detected: Provider.annotate({
    description: "The light provider the bot detected; `default` means it.",
  }),
  listed: Provider.annotate({
    description:
      "The provider `options.model` and `options.effort` are for: the chosen one, else `detected`.",
  }),
}).annotate({ identifier: "LightSettings" });

export type LightSettings = typeof LightSettingsSchema.Type;

export const HelperSettingsSchema = Schema.Struct({
  ...ChoiceFields,
  provider: Schema.String.annotate({
    description:
      "`default` (Auto: the bot picks, from the light choice and what can run) or a provider of the pass's own. On Auto `options.model` and `options.effort` are empty.",
  }),
  runsOn: Schema.Struct({
    auto: Schema.Boolean.annotate({
      description: "Whether the pass runs on Auto now.",
    }),
    model: Schema.NullOr(Schema.String),
    provider: Schema.NullOr(Provider).annotate({
      description: "Where the pass runs now; null when no provider serves it.",
    }),
  }),
}).annotate({ identifier: "HelperSettings" });

export const HelpersSettings = Schema.Struct({
  format: HelperSettingsSchema,
  judge: HelperSettingsSchema,
  title: HelperSettingsSchema,
}).annotate({ identifier: "HelpersSettings" });

export type HelpersSettingsView = typeof HelpersSettings.Type;

export const ChoiceUpdate = Schema.Struct({
  effort: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "`default`, a tier, or on pi a pi model by name. Checked on the provider after `provider` is applied.",
    })
  ),
  provider: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "ChoiceUpdate" });

const HelperUseParams = {
  use: Schema.Literals(HELPER_USES).annotate({
    description:
      "The helper pass: `format` (formats replies), `judge` (decides whether a group message is for the bot) or `title` (names topics).",
  }),
};

// «Голосовые ответы» --------------------------------------------------------

const Voice = Schema.Struct({
  gender: Schema.NullOr(Schema.String),
  id: Schema.String,
  name: Schema.String,
  own: Schema.Boolean.annotate({
    description:
      "A voice the owner made; one saved from the library may not speak on a free plan.",
  }),
}).annotate({ identifier: "Voice" });

export const VoiceSettingsSchema = Schema.Struct({
  configured: Schema.Boolean.annotate({
    description:
      "Whether voice replies are set up (`ELEVENLABS_API_KEY` is set). The key itself is never shown.",
  }),
  model: Schema.String.annotate({
    description: "The ElevenLabs model a voice reply is spoken with.",
  }),
  options: Schema.Struct({ model: Options }),
  storedVoiceId: Schema.NullOr(Schema.String).annotate({
    description: "The voice chosen, as stored; null for none.",
  }),
  voice: Schema.NullOr(Voice).annotate({
    description:
      "The voice a reply is spoken with now: the chosen one while the account has it, else the first matching the persona's gender.",
  }),
  voices: Schema.Array(Voice).annotate({
    description: "The account's voices, the values `voice` takes.",
  }),
  voicesError: Schema.optionalKey(
    Schema.String.annotate({
      description: "Why ElevenLabs did not list the voices, when it did not.",
    })
  ),
}).annotate({ identifier: "VoiceSettings" });

export type VoiceSettings = typeof VoiceSettingsSchema.Type;

export const VoiceSettingsUpdate = Schema.Struct({
  model: Schema.optionalKey(
    Schema.String.annotate({ description: "One of `options.model`." })
  ),
  voice: Schema.optionalKey(
    Schema.String.annotate({ description: "A voice id from `voices`." })
  ),
}).annotate({ identifier: "VoiceSettingsUpdate" });

// «Провайдеры» --------------------------------------------------------------

const ProviderSettingValue = Schema.Union([
  Schema.Boolean,
  Schema.Number,
  Schema.String,
]);

export const ProviderSettingsSchema = Schema.Struct({
  overridden: Schema.Boolean.annotate({
    description:
      "Whether runs start another binary than the pinned one (`CLAUDE_BIN`), whose settings may differ.",
  }),
  provider: Provider,
  settings: Schema.Array(
    Schema.Struct({
      key: Schema.String.annotate({
        description: "The provider's own setting name.",
      }),
      kind: Schema.Literals(["toggle", "choice", "ladder"]),
      options: Schema.Array(ProviderSettingValue).annotate({
        description: "Every value it takes.",
      }),
      value: Schema.NullOr(ProviderSettingValue).annotate({
        description: "The value set; null keeps the provider's own default.",
      }),
    }).annotate({ identifier: "ProviderSetting" })
  ).annotate({
    description:
      "The settings the bot lets change, from its allowlist; everything else (the model, effort, sandbox, permissions, hooks) the bot forces and never offers.",
  }),
  version: Schema.String.annotate({
    description: "The CLI version runs start, the allowlist is typed against.",
  }),
}).annotate({ identifier: "ProviderSettings" });

export type ProviderSettings = typeof ProviderSettingsSchema.Type;

export const ProviderSettingsList = Schema.Struct({
  providers: Schema.Array(ProviderSettingsSchema),
}).annotate({ identifier: "ProviderSettingsList" });

export const ProviderSettingsUpdate = Schema.Record(
  Schema.String,
  Schema.NullOr(ProviderSettingValue)
).annotate({
  description:
    "Settings to change, by key: a value from its `options`, or null to go back to the provider's own default.",
  identifier: "ProviderSettingsUpdate",
});

const ProviderParams = {
  provider: Provider,
};

// The group -----------------------------------------------------------------

const ERRORS = [Conflict, Forbidden, InvalidInput, Unavailable];

export const SettingsGroup = HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("getMine", "/v1/settings/mine", {
      error: Forbidden,
      success: MySettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Read your own defaults for new conversations.\n\nThe provider, model and effort a new conversation of yours starts on («Мои настройки» in /settings). The owner and executors each have their own.",
        identifier: "settings.getMine",
        summary: "Read your new-chat defaults",
      })
    ),
    HttpApiEndpoint.patch("updateMine", "/v1/settings/mine", {
      error: ERRORS,
      payload: MySettingsUpdate,
      success: MySettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Change your own defaults for new conversations.\n\nOnly the fields sent change; a conversation already running keeps what it runs on. ${REFUSALS} A provider that cannot run now is \`Conflict\`.`,
        identifier: "settings.updateMine",
        summary: "Change your new-chat defaults",
      })
    ),
    HttpApiEndpoint.get("getBot", "/v1/settings/bot", {
      error: Forbidden,
      success: BotSettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Read the bot's own settings.\n\nThe switches, language, verbosity, daily budgets, run limit, home time zone, account write mode and workspace («Настройки бота» in /settings). ${OWNER_ONLY}`,
        identifier: "settings.getBot",
        summary: "Read the bot's settings",
      })
    ),
    HttpApiEndpoint.patch("updateBot", "/v1/settings/bot", {
      error: ERRORS,
      payload: BotSettingsUpdate,
      success: BotSettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Change the bot's own settings.\n\nOnly the fields sent change, at once. ${REFUSALS} \`accountWrites\` while the account feature is off is \`Conflict\`. ${OWNER_ONLY}`,
        identifier: "settings.updateBot",
        summary: "Change the bot's settings",
      })
    ),
    HttpApiEndpoint.get("getLight", "/v1/settings/light", {
      error: Forbidden,
      success: LightSettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Read what light runs run on.\n\nThe provider, model and effort of every light run: groups, guests, members and Business replies («Группы и гости»). ${OWNER_ONLY}`,
        identifier: "settings.getLight",
        summary: "Read the light-run choice",
      })
    ),
    HttpApiEndpoint.patch("updateLight", "/v1/settings/light", {
      error: ERRORS,
      payload: ChoiceUpdate,
      success: LightSettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Change what light runs run on.\n\nOnly the fields sent change; the next light run reads them. ${REFUSALS} ${OWNER_ONLY}`,
        identifier: "settings.updateLight",
        summary: "Change the light-run choice",
      })
    ),
    HttpApiEndpoint.get("getHelpers", "/v1/settings/helpers", {
      error: Forbidden,
      success: HelpersSettings,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Read where each helper pass runs.\n\nThe format, judge and title passes: each one's own choice and where it runs now («Служебные проходы»). ${OWNER_ONLY}`,
        identifier: "settings.getHelpers",
        summary: "Read the helper passes",
      })
    ),
    HttpApiEndpoint.patch("updateHelper", "/v1/settings/helpers/:use", {
      error: ERRORS,
      params: HelperUseParams,
      payload: ChoiceUpdate,
      success: HelpersSettings,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Change where one helper pass runs.\n\nA new \`provider\` (\`default\` for Auto included) forgets the pass's model and effort, unless they are sent too; on Auto there is no model or effort to set. ${REFUSALS} ${OWNER_ONLY}`,
        identifier: "settings.updateHelper",
        summary: "Change a helper pass",
      })
    ),
    HttpApiEndpoint.get("getVoice", "/v1/settings/voice", {
      error: Forbidden,
      success: VoiceSettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Read the voice replies are spoken with.\n\nThe ElevenLabs model and voice, and the account's voices («Голосовые ответы»). ${OWNER_ONLY}`,
        identifier: "settings.getVoice",
        summary: "Read the voice-reply settings",
      })
    ),
    HttpApiEndpoint.patch("updateVoice", "/v1/settings/voice", {
      error: ERRORS,
      payload: VoiceSettingsUpdate,
      success: VoiceSettingsSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Change the voice replies are spoken with.\n\n${REFUSALS} A voice while voice replies are not set up is \`Conflict\`; \`Unavailable\` when ElevenLabs does not answer. ${OWNER_ONLY}`,
        identifier: "settings.updateVoice",
        summary: "Change the voice-reply settings",
      })
    ),
    HttpApiEndpoint.get("getProviders", "/v1/settings/providers", {
      error: Forbidden,
      success: ProviderSettingsList,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Read each provider's own settings.\n\nThe Claude Code and Codex settings the bot lets change («Провайдеры»), with every value each takes; pi offers none yet. ${OWNER_ONLY}`,
        identifier: "settings.getProviders",
        summary: "Read the provider settings",
      })
    ),
    HttpApiEndpoint.patch(
      "updateProvider",
      "/v1/settings/providers/:provider",
      {
        error: ERRORS,
        params: ProviderParams,
        payload: ProviderSettingsUpdate,
        success: ProviderSettingsSchema,
      }
    ).annotateMerge(
      OpenApi.annotations({
        description: `Change one provider's own settings.\n\nOnly the keys sent change; null goes back to the provider's default. The next run of that provider reads them. ${REFUSALS} ${OWNER_ONLY}`,
        identifier: "settings.updateProvider",
        summary: "Change a provider's settings",
      })
    )
  )
  .middleware(ApiAuth)
  .annotateMerge(
    OpenApi.annotations({
      description:
        "The bot's settings, as /settings shows them: your own new-chat defaults, and for the owner the bot's settings, light runs, helper passes, voice replies and each provider's own settings.",
      title: "settings",
    })
  );
