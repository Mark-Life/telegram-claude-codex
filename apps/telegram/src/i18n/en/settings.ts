import type { settings as ruSettings } from "../ru/settings";

const THOUSAND = 1000;
const MILLION = 1_000_000;

/** Tokens as the menu names them: 200K, 1M. */
const tokens = (count: number) =>
  count >= MILLION ? `${count / MILLION}M` : `${count / THOUSAND}K`;

export const settings = {
  settings: {
    account: {
      confirm: {
        hint: "Confirm actions: before every action as you (messages, files, reactions, pins, polls…), I show it to you with buttons. When off, I do it at once (direct Telegram API calls still wait for the button): scheduled tasks can then write on their own, but nothing stands between a stranger's message I read and your account.",
        label: "Confirm account actions",
      },
      connected: (name: string) => `Connected: ${name}. To disconnect: /login`,
      loggedOut: "Not connected. To connect: /login",
      off: 'Off on this server. How to turn it on: README, section "Telegram account".',
    },
    defaults: {
      auto: "Auto",
      back: "<< Back",
      detected: (name: string) => `Auto (now ${name})`,
      down: (name: string, reason: string) => `${name}: ${reason}`,
      effort: "Depth",
      hint: 'New chats: what a new topic and a conversation after /new start on, and who runs your scheduled tasks, on which model and how deep, at every run unless a task has its own choice in /tasks → Model. Each executor has their own. Running conversations stay as they are: /model and /effort change only the conversation they are sent in. "Auto" for the model and depth means I pick from the first message; for "Who answers", the one connected now.',
      hintExecutor:
        'New chats: what a new topic you write in first and a conversation after /new in your private-chat topics start on, and who runs your scheduled tasks, on which model and how deep, at every run unless a task has its own choice in /tasks → Model. The private chat without topics is shared with the owner, so "Who answers" does not change there, and whoever starts the conversation sets its model and depth. /model and /effort change only the conversation they are sent in. "Auto" for the model and depth means I pick from the first message; for "Who answers", the one connected now.',
      model: "Model",
      pickEffort: (provider: string) =>
        `How carefully to think in new conversations (in the private chat now ${provider}):`,
      pickModel: (provider: string) =>
        `Which model new conversations use (in the private chat now ${provider}):`,
      pickProvider: "Who answers in new conversations:",
      provider: "Who answers",
      providerDefault: (provider: string) => `${provider}'s usual`,
      title: "My settings",
      unset: "not chosen",
      unsetRow: "Don't choose, as before",
    },
    helpers: {
      auto: (name: string) => `Auto — ${name}`,
      autoMark: "Auto",
      hint: 'Helpers are short questions I ask myself: was I spoken to in a group, what to call a new topic, how to lay out a task\'s result. "Auto" is the usual way: titles and formatting follow the choice in "Groups and guests", the address check goes to the connected provider. The model and depth apply only on the chosen provider; when it cannot run, I use "Auto". A TypeSafe key, when set, checks the address first; the choice here is the fallback.',
      noEffort: "This model has no depth setting.",
      noPiModel: "no model with a key helpers can use",
      now: "Now:",
      pickEffort: (use: string, provider: string) =>
        `How carefully to think for "${use}" (now ${provider}):`,
      pickModel: (use: string, provider: string) =>
        `Which model "${use}" gets (now ${provider}):`,
      pickProvider: (use: string) => `Who does "${use}":`,
      useHints: {
        format:
          "I lay out a script task's output for Telegram. Deeper means a longer wait for the result.",
        judge:
          "I decide whether I was addressed by name in a group or a Business chat. Deeper is slower; past 30 seconds I stay silent.",
        title:
          "I name a new topic from its first message. Past 15 seconds the topic keeps Telegram's name.",
      },
      uses: {
        format: "Task formatting",
        judge: "Address check",
        title: "Topic titles",
      },
    },
    language: {
      hint: "Language: the language of my menus, buttons and notices. The language I answer in is a rule in AGENTS.md in the work folder.",
      label: "Language",
    },
    light: {
      helpers:
        'Where helpers run is set in "Helpers". On Auto, topic titles and task formatting follow the choice here.',
      hint: 'Groups and guests: who answers, and on which model, in groups, to guests, to members and in Business chats. "Usual" is the cheap fast model at low depth. When the chosen one cannot take such a conversation, the connected one answers.',
      noHelper: "none",
      pickEffort: (provider: string) =>
        `How carefully to think in groups and with guests (now ${provider}):`,
      pickModel: (provider: string) =>
        `Which model groups and guests get (now ${provider}):`,
      pickProvider: "Who answers in groups and to guests:",
      usual: "Usual",
    },
    limits: {
      hint: "How many requests a day I take from guests and members. Your requests never count, an executor's count only in groups. A press moves to the next value.",
      labels: {
        group_runs_per_day: "Groups, total",
        group_runs_per_user: "Groups, per person",
        private_runs_per_day: "Private, total",
        private_runs_per_user: "Private, per person",
      },
      none: "no limit",
    },
    menu: {
      hint: "Each button opens its section in this same message.",
      open: (label: string) => `${label} >>`,
      providerLine: (name: string, changed: number) =>
        changed === 0
          ? `${name}: provider defaults`
          : `${name}: settings changed: ${changed}`,
      title: "Settings",
    },
    notOwner: "Only the owner and executors can change the settings.",
    off: "off",
    on: "on",
    privateOnly: "Settings open only in your private chat with me.",
    providers: {
      claude: {
        attribution: {
          hint: "Claude attribution: the Co-Authored-By line in commits and the note in PRs. When off, commits and PRs go without it.",
          label: "Claude attribution",
        },
        autoCompactWindow: {
          hint: "Window before compaction: at what context size Claude sums up the conversation on its own to carry on. Larger keeps more word for word, but every answer costs more.",
          label: "Window before compaction",
          value: tokens,
        },
        bashOutputMaxChars: {
          hint: "Command output: how many characters of a command's output Claude sees at once; it reads the rest from a file. More means fewer extra steps, but the context fills faster.",
          label: "Command output",
          value: (count: number) => `${count / THOUSAND}K characters`,
        },
        includeGitInstructions: {
          hint: "Git rules: Claude Code's built-in rules for commits and PRs. Turn them off when your rules in AGENTS.md replace them. Applies from a new conversation (/new) or after /compact.",
          label: "Git rules",
        },
        outputStyle: {
          hint: 'Answer style: how Claude writes. "Concise" leads with the result, no preamble. "Explanatory" says why it did things that way. "Proactive" asks less and does more. Applies from a new conversation (/new) or after /compact.',
          label: "Answer style",
          values: {
            Concise: "Concise",
            Explanatory: "Explanatory",
            Proactive: "Proactive",
          },
        },
        promptCacheTtl: {
          hint: "Conversation cache: how long Anthropic keeps the start of a conversation so the next answer costs less, 5 minutes or an hour. An hour costs more to write when Claude runs on an API key; on a subscription Claude usually picks an hour itself. Covers every answer, groups and guests included.",
          label: "Conversation cache",
          values: { "1h": "1 hour", "5m": "5 minutes" },
        },
        subagentPromptCacheTtl: {
          hint: "Subagent cache: the same for subagents, background work and helper requests.",
          label: "Subagent cache",
          values: { "1h": "1 hour", "5m": "5 minutes" },
        },
      },
      codex: {
        model_auto_compact_token_limit: {
          hint: "Compaction point: after how many context tokens Codex sums up the conversation on its own. Unset means CODEX_AUTO_COMPACT_TOKENS from .env, or 150K.",
          label: "Compaction point",
          value: tokens,
        },
        model_reasoning_summary: {
          hint: 'Reasoning summary: whether the model shows a short line of its thinking; you see it when Detail is "with steps".',
          label: "Reasoning summary",
          values: {
            auto: "auto",
            concise: "concise",
            detailed: "detailed",
            none: "none",
          },
        },
        model_verbosity: {
          hint: "Answer length: how fully the model writes. Not every model supports it.",
          label: "Answer length",
          values: { high: "long", low: "short", medium: "medium" },
        },
      },
      hint: "How Claude Code and Codex work, for you, executors, groups and guests alike. A change applies from the next answer. The model and depth are set in My settings, /model and /effort.",
      locked:
        "Never changed, the bot relies on them: tools and their denials, the sandbox, MCP servers, skills, hooks, memory and how long conversations are kept.",
      overridden:
        "CLAUDE_BIN is set: answers go through another Claude Code build, where some settings may work differently.",
      pi: {},
      title: "Providers",
      usual: "provider default",
      usualNote: {
        claude:
          '"Provider default" is Claude Code\'s built-in value: the bot does not read settings files on the server.',
        codex:
          '"Provider default" for Codex is the value in $CODEX_HOME/config.toml on the server (~/.codex/config.toml by default), and in the sandbox, which has no such file, Codex\'s built-in one.',
        pi: '"Provider default" for pi is the value in ~/.pi/agent/settings.json on the server.',
      },
      usualRow: "Provider default",
      version: (name: string, version: string) => `${name} ${version}`,
    },
    readFailed: "I could not read the settings. Try again later.",
    runLimit: {
      hint: 'Tasks at once: how many answers I work on at the same time across every chat. When there is no room, a new request gets "I am busy right now". Lowering it never stops work already running. Conversations and scheduled task runs waiting on background work are not counted here.',
      label: "Tasks at once",
    },
    sections: {
      account: "Telegram account",
      helpers: "Helpers",
      light: "Groups and guests",
      limits: "Daily limits",
      workspace: "Work chat",
    },
    timeZone: {
      ask: (current: string) =>
        `Now: ${current}. Send the time zone as one message, for example Europe/Sofia or Sofia.`,
      bad: (typed: string) =>
        `I do not know the time zone ${typed}. Use a name like Europe/Sofia. To try again, press the time zone row again.`,
      cancelled: "The time zone did not change.",
      hint: "Time zone: a reminder whose time comes without a zone is set in it, and the list shows reminders in it without a zone label. Reminders already set keep their own zone.",
      label: "Time zone",
      set: (zone: string) => `Time zone: ${zone}.`,
    },
    title: "Bot settings",
    toggles: {
      guests: {
        hint: "Guests: people without access who write to me privately. When off, I ignore them silently and spend no tokens on them.",
        label: "Guests",
      },
      mark_read: {
        hint: "Mark as read: a chat I read in your account becomes read, and a voice note or round video I download becomes listened. In a Telegram Business chat, the chat becomes read after I answer there. When off, I mark nothing on my own, only when you ask.",
        label: "Mark as read",
      },
      steer: {
        hint: "Messages mid-task: what you write while I work goes into the current task, as in the ChatGPT and Claude apps. When off, such messages queue and I take them after the answer.",
        label: "Messages mid-task",
      },
      voice_transcript: {
        hint: "Voice transcripts: I reply to a voice note with its transcript. When off, I transcribe silently and get to work.",
        label: "Voice transcripts",
      },
    },
    unknown: "No such setting",
    verbosity: {
      hint: 'Detail: what you see while I work. "With steps" shows the steps, drafts and a footer with time and cost: the debugging view.',
      label: "Detail",
      values: {
        full: "with steps",
        quiet: "answer only",
      },
    },
    voice: {
      empty:
        "Your ElevenLabs account has no voices. Add one at elevenlabs.io (My Voices) and open this screen again.",
      failed: (reason: string) =>
        `Could not get the voices from ElevenLabs: ${reason}`,
      hint: "Voice replies: when you ask for an answer by voice, I write it for the ear, speak it with ElevenLabs and send a voice message to the same chat and topic. Pick the voice and the model here. The list holds your ElevenLabs account's voices, your own first. Voices saved from the library work only on a paid ElevenLabs plan.",
      label: "Voice replies",
      model: (name: string) => `Model: ${name}`,
      models: {
        eleven_flash_v2_5: "Flash v2.5 — cheaper",
        eleven_v4: "Eleven v4 — best quality",
        eleven_v4_turbo: "Eleven v4 Turbo — faster",
      },
      off: "Off: an ElevenLabs key is needed. Add ELEVENLABS_API_KEY to the bot's .env and restart it.",
      voice: (name: string) => `Voice: ${name}`,
    },
    workspace: {
      clear: "Forget the work chat",
      cleared:
        "The work chat is forgotten. Messages nobody asked for now come here, to the private chat.",
      hint: "The private chat with me, with topics turned on, already works as a workspace. A work chat is for working with other people. To set one: /setworkspace in the group.",
      line: (label: string) => `Work chat: ${label}`,
      none: "not set",
      topic: (input: { threadId: number; title: string }) =>
        `${input.title}, topic ${input.threadId}`,
    },
    writeFailed: "I could not save it. Please try again.",
  },
} satisfies typeof ruSettings;
