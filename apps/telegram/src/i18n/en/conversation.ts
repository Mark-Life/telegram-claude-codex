import type { Persona } from "../../persona";
import type { conversation as ruConversation } from "../ru/conversation";

/** Minutes and seconds under a larger unit read as two digits. */
const TWO_DIGITS = 2;

export const conversation = {
  agents: {
    /** An elapsed time, `2m10s`; past an hour, `1h05m`. */
    duration: (hours: number, minutes: number, seconds: number) => {
      if (hours > 0) {
        return `${hours}h${String(minutes).padStart(TWO_DIGITS, "0")}m`;
      }
      return minutes > 0
        ? `${minutes}m${String(seconds).padStart(TWO_DIGITS, "0")}s`
        : `${seconds}s`;
    },
    failed: (count: number) => `${count} failed`,
    more: (count: number) => `and ${count} more`,
    progress: (done: number, total: number) => `${done}/${total} done`,
    stop: "⏹ Stop",
    stopped: (count: number) => `${count} stopped`,
    title: "Sub-agents",
    tokens: (count: string) => `${count} tokens`,
    wave: (index: number, count: number) => `wave ${index} of ${count}`,
    waves: (from: number, to: number) => `Waves ${from}–${to}`,
    workflow: (name: string) => `Workflow “${name}”`,
  },
  compose: {
    already: (count: number) =>
      `Already collecting (${count}). Send /send when you are done.`,
    cancelled: (count: number) => `Cancelled. Messages discarded: ${count}.`,
    collecting: (count: number) => `Collecting messages (${count})`,
    full: (max: number) =>
      `I cannot collect more than ${max} messages at once. /send to send, /cancel to discard.`,
    idle: "I am not collecting anything now.",
    notAccepted: "I could not take this message. Please try again.",
    nothingToSend: "There was nothing to send. Cancelled.",
    privateOnly: "You can collect messages only in a private chat with me.",
    send: "Send",
    started: "Collecting messages. Write, and send /send when you are done.",
  },
  history: {
    ago: {
      days: (count: number) => `${count} d ago`,
      hours: (count: number) => `${count} h ago`,
      minutes: (count: number) => `${count} min ago`,
      now: "just now",
    },
    back: "<< Back",
    conversations: "<< Conversations",
    empty: "No past conversations yet.",
    next: "Next >>",
    noTopic: "(no topic)",
    notFound: "Nothing found",
    ownerSwitches: (name: string) =>
      `This conversation ran on ${name}. Only the owner can switch me to ${name}.`,
    resumed: () => "Back in this conversation. Your next message continues it.",
    resumedOn: (_persona: Persona, name: string) =>
      `Back in this conversation. I answer through ${name} from now on; your next message continues it.`,
    resuming: "Going back to the conversation",
    tasks: "Tasks",
    tasksTitle: "Task runs",
    title: "Past conversations",
  },
  model: {
    auto: "Auto",
    default: "As in /settings",
    effortHeader: "How carefully to think in this conversation:",
    effortSet: (label: string) =>
      `Thinking depth: ${label}. It applies from your next message in this conversation.`,
    effortToast: (label: string) => `Depth: ${label}`,
    efforts: {
      high: "High",
      low: "Low",
      medium: "Medium",
      xhigh: "Maximum",
    },
    modelHeader: "Which model to use in this conversation:",
    modelSet: (label: string) =>
      `Model: ${label}. It applies from your next message in this conversation.`,
    modelToast: (label: string) => `Model: ${label}`,
    /** `/effort` on a model with no thinking setting. */
    noEffort: "This model has no thinking depth setting.",
    noSuchModel: "No such model",
    pi: {
      all: (count: number) => `All models (${count})`,
      allHeader: (count: number) =>
        `pi models: ${count}. Tap a name to copy it, then send /model with it.`,
      bigProvider: (provider: string, count: number, search: string) =>
        `${provider}: ${count} models. Find one: ${search}`,
      byDefault: (model: string) => `Default (${model})`,
      found: (query: string) => `Models matching "${query}":`,
      /** A stored pick the list in hand lacks, as its row reads. */
      gone: (model: string) => `${model} (not available now)`,
      goneToast: "This model is not on the list now, pick another one",
      loading:
        "The pi model list is still loading. Open the picker again in a few seconds.",
      manual: "On pi the model is picked by hand.",
      more: (count: number) => `…and ${count} more, narrow the search.`,
      noLight:
        "No pi model works for groups, guests and helper passes: none has a key they can use. Put the key in auth.json or models.json in pi's folder.",
      noList:
        "The pi model list is still loading or not available. Try again in a few seconds.",
      none: (query: string) =>
        `No model matches "${query}". The whole list is under "All models" in /model.`,
      pickerHint:
        "Pick another model in a conversation: /model and part of its name. It then shows up here among the recent ones.",
      stale: "The model list changed, open /model again",
      staleSettings: "The model list changed, open the picker again",
    },
    routingMoved:
      'Automatic model choice is now in /settings, under "New chats".',
    tierHints: {
      astra: "writes best",
      luna: "fast",
      sol: "code and hard tasks",
      terra: "the middle ground",
    },
  },
  plan: {
    askEdits: "Write what to change in the plan in your next message.",
    awaitingEdits: "Waiting for your changes",
    modify: "Improve the plan",
    none: "There is no plan now",
    ready: "The plan is ready. What next?",
    runFresh: "Run from a clean slate",
    runResume: "Run, keeping the conversation",
    runningFresh: "Running the plan from a clean slate...",
    runningResume: "Running the plan, keeping the conversation...",
    runningToast: "Running the plan",
    unreadable: "I could not read the plan.",
  },
  session: {
    compact: {
      context: (before: string, after: string) =>
        `Context: ${before} → ${after} tokens.`,
      done: "Done, the conversation is summed up. Just write your next message.",
      failed: "I could not sum up the conversation. It continues as it was.",
      nothing: "There is nothing to sum up yet. Write to me first.",
      stoppedFirst: "I stopped the current work first.",
      unsupported: "I cannot sum up here. Start a new conversation with /new.",
      working: "Summing up the conversation...",
    },
    context: {
      buttonCompact: "Sum up",
      buttonNew: "Start over",
      compactAt: (tokens: string) =>
        `I sum up on my own once it reaches about ${tokens} tokens.`,
      compacting:
        "I am summing up the conversation now; the figure changes after that.",
      free: "To free it: /compact or /new.",
      live: "The figure updates as the current work goes.",
      modelWindow: (window: string, model: string) =>
        `Measured against the window I sum up in: ${window} (the model has ${model}).`,
      noFigure:
        "How full it is shows after the next answer in this conversation.",
      noFigureRunning:
        "How full it is shows as soon as the current work sends its first request.",
      noSession:
        "There is nothing in this conversation yet. Write to me first.",
      notKept:
        "Here every message starts the conversation anew, so there is nothing to show.",
      title: (provider: string, model: string | undefined) =>
        model === undefined
          ? `<b>Context</b> · ${provider}`
          : `<b>Context</b> · ${provider} · ${model}`,
      tokens: (used: string, window: string) => `${used} of ${window} tokens`,
      tokensOnly: (used: string) =>
        `${used} tokens; the window size shows after the next answer.`,
      used: (percent: number) => `${percent}% used`,
    },
    help: (operator: boolean) => [
      "<b>How to work with me</b>",
      "",
      "Just write what you need. You can also send a voice note, a file or a photo: I read it all and do the work.",
      "",
      "<b>Commands</b>",
      ...(operator
        ? [
            "/new: start a conversation from a clean slate",
            "/history: go back to one of the past conversations",
          ]
        : []),
      "/stop: stop what I am doing now",
      ...(operator
        ? [
            "/compact: sum up the conversation and continue from a short summary",
          ]
        : []),
      "/context: how full the conversation's memory is",
      "/compose: collect several messages and send them as one",
      "/send: send the draft",
      "/cancel: discard the draft",
      ...(operator
        ? [
            "/model: which model to use",
            "/effort: how carefully to think about the answer",
            "/settings: what new conversations start on",
            "/reminders: all reminders",
            "/tasks: the work I do on a schedule",
            "/task add: add a new scheduled task",
            "/apikeys: keys for programs to reach me over HTTP",
          ]
        : []),
      "/help: this message",
      "",
      "If something does not work, I say so in plain words, and you can just try again.",
    ],
    newDefaultDown: (name: string) =>
      `Starting over. ${name} is unavailable now, so I carry on as before. Your next message is a new conversation.`,
    newShared:
      'Starting over. In the private chat without topics I answer as usual; your "Who answers" choice in /settings applies in your private-chat topics. Your next message is a new conversation.',
    newStarted: "Starting over. Your next message is a new conversation.",
    newStartedOn: (name: string) =>
      `Starting over, now through ${name}. Your next message is a new conversation.`,
    start: {
      groupId: (chatId: number) =>
        `<i>This group's ID: <code>${chatId}</code></i>`,
      guestId: (userId: number) =>
        `<i>If you think you need access to this bot, send the bot's owner your Telegram ID: <code>${userId}</code></i>`,
      lines: (operator: boolean) => [
        "Hi! I am here.",
        "",
        "Write in plain words what you need, and I will handle it. I understand voice notes too, and you can just send files and photos to the chat.",
        "",
        "The essentials:",
        ...(operator
          ? [
              "/new: start a new conversation",
              "/history: go back to a past conversation",
            ]
          : []),
        "/stop: stop what I am doing",
        "/help: what else I can do",
      ],
      userId: (userId: number) =>
        `<i>Your Telegram ID: <code>${userId}</code></i>`,
    },
    stop: {
      idle: "I am not doing anything now.",
      queueCleared: "Queue cleared.",
      stopped: "Stopped.",
    },
  },
  status: {
    backgroundExpired:
      "Stopped waiting for background work: it ran past the time limit. Write to me to continue.",
    backgroundFull:
      "Too many conversations are waiting on background work right now, so this one will not wait for its own: what does not finish within 10 minutes stops, and scheduled check-backs are dropped.",
    clearQueue: "Clear the queue",
    forceSend: "Take it now, interrupt the current one",
    idle: "I am not doing anything now",
    moreQueued: (count: number) => `(${count} more in the queue)`,
    queueCleared: (count: number) => `Queue cleared (${count}).`,
    queueEmpty: "The queue is empty.",
    queued: (count: number) => `Message queued (${count} in total)`,
    restartCut:
      "The bot is restarting, and this conversation's background work stopped. I will try to pick it up once it is back.",
    restartNotResumed:
      "After the restart, this conversation's background work could not go on. Write if it is still needed.",
    steered: "I'll factor this into the current task.",
    stopping: "Stopping...",
    takingNext: "Taking the next message",
  },
} satisfies typeof ruConversation;
