import type { schedule as ruSchedule } from "../ru/schedule";

export const schedule = {
  reminders: {
    askNewDue: (id: number) =>
      `Write or dictate a new due time for reminder #${id}.`,
    askWhen: "Postpone until when?",
    back: "Back",
    buttons: {
      done: "Done",
      postpone: "Postpone",
    },
    completed: "Done",
    doneToast: "Done",
    missing: "No such reminder",
    next: "Next",
    noDue: "no due time",
    notification: (id: number) => `Reminder #${id}`,
    overdue: "overdue",
    page: {
      empty: "Nothing yet.",
      emptyPage: "Nothing on this page.",
      heading: (total: number) => `Reminders: ${total} in total`,
      pageOf: (input: { page: number; pages: number }) =>
        `Page ${input.page} of ${input.pages}`,
    },
    postponeFailed: "I could not postpone it",
    postponed: (due: string) => `Postponed: ${due}`,
    snooze: {
      day: "A day",
      hour1: "+1 hour",
      hours4: "+4 hours",
      hours8: "+8 hours",
      min15: "+15 min",
      min30: "+30 min",
      other: "Other",
    },
  },
  tasks: {
    addUsage: (separator: string) => [
      "A new task is a header and the task text:",
      "",
      "<code>/task add",
      "title: Morning digest",
      "cron: 0 9 * * *",
      "tz: Europe/Berlin",
      "type: prompt",
      separator,
      "Tell me what came to my mail overnight.</code>",
      "",
      '<code>cron</code> is the time as "minute hour day month weekday", <code>tz</code> is the time zone.',
      "You can also add: <code>enabled: false</code> (paused from the start), <code>raw: true</code> (send the answer as is), <code>silent: true</code> (work silently, report only errors), <code>project</code>.",
      "The result comes to this chat and topic unless <code>silent: true</code> is set.",
      "<code>session: own</code> keeps one conversation of the task's own, so it remembers earlier runs. <code>session: route</code> writes into this chat and topic's conversation, like your own message, and you can continue it; if the conversation is busy, the run waits. Not together with <code>silent: true</code>.",
      "A script (<code>type: script</code>) with <code>session</code> is a gate: it runs with no model, sees its earlier state in <code>taskState</code>, and wakes the model only when it returns <code>{ state, prompt }</code> with an instruction.",
    ],
    buttons: {
      back: "Back",
      delete: "Delete",
      model: "Model",
      pause: "Pause",
      resetSession: "Start over",
      resume: "Resume",
      run: "Run",
      session: "Session",
      stop: "Stop",
    },
    commandHint: "/tasks lists the tasks, /task add adds a new one.",
    deleted: (id: number) => `#${id} deleted`,
    empty: "No scheduled tasks yet.",
    form: {
      badSession: "The session field can be fresh, own or route.",
      badType: "The type field can be prompt or script.",
      badZone: (tz: string) =>
        `I do not know the time zone ${tz}. Use a name like Europe/Berlin.`,
      missingFields: "title, cron and tz are required, all three.",
      neverRuns: (cron: string) =>
        `With this schedule the task never starts: ${cron}`,
      noPayload: (separator: string) =>
        `I do not see the task itself: write it below the ${separator} line.`,
      routeNeedsChat:
        "session: route writes into this chat's conversation, so it does not go with silent: true.",
    },
    list: {
      lastRun: (input: { date: string; status: string }) =>
        `last time ${input.status} ${input.date}`,
      mode: {
        own: "its own conversation",
        route: "in the chat's conversation",
      },
      never: "never",
      neverRan: "has not run yet",
      next: (when: string) => `next ${when}`,
      paused: "paused",
      resetPending: "the conversation will start over",
      sessionKept: "conversation kept",
      status: {
        error: "failed",
        ok: "succeeded",
        paused: "awaits approval",
      },
    },
    pick: {
      follow: "As in settings",
      followNow: (provider: string) => `As in settings (now ${provider})`,
      hint: 'Who runs this task, on which model and how deep. "As in settings" follows the "New chats" in /settings of whoever set the task up, at each run; a choice here applies to this task alone. With "Auto" in settings I pick the model from the task on its first run and keep it. For a script with a conversation, this is the model it wakes.',
      pickEffort: (provider: string) =>
        `How deep to think on this task (now ${provider}):`,
      pickModel: (provider: string) =>
        `Which model to use for this task (now ${provider}):`,
      pickProvider: "Who runs this task:",
    },
    run: {
      awaitingApproval: (id: string) =>
        `Waiting for your approval (run ${id}).`,
      awaitingMcpApproval: (id: string, asks?: string) =>
        `Executor is waiting for your approval (request ${id})${asks === undefined ? "" : `: ${asks}`}. Send me "approve ${id}" or "decline ${id}" within 15 minutes and I will answer the request with Executor's resume. After that the request expires, and the script runs again only at its next fire or on Run.`,
      awaitingMcpInput: (id: string, asks?: string) =>
        `Executor is waiting for your input (request ${id})${asks === undefined ? "" : `: ${asks}`}. Send me your answer and the request id ${id} within 15 minutes and I will pass it on with Executor's resume. After that the request expires, and the script runs again only at its next fire or on Run.`,
      empty: "(empty)",
      failed: "That did not work.",
      failedWillRetry: "That did not work. I will try next time.",
      noWaitSlot:
        "The task started background work, but every waiting slot was taken, so the work stopped before it reported. Run it again later.",
      notResumed: {
        access:
          "Not continued after the restart: whoever set up the task no longer has full access. It runs at its next fire.",
        cap: "Not continued after the restart: the task was already continued too many times in a row. It runs at its next fire.",
        changed:
          "Not continued after the restart: the task changed. It runs at its next fire.",
        nothing:
          "Not continued after the restart: there is nothing left to continue. It runs at its next fire.",
        provider: (name: string) =>
          `Not continued after the restart: the task now runs through ${name}. It runs at its next fire.`,
        providerDown: (name: string) =>
          `Not continued after the restart: ${name} is not available now. It runs at its next fire.`,
      },
      unknownId: "unknown",
      waitExpired:
        "The task waited on its wake-up for over 70 minutes and ended without a report.",
    },
    session: {
      badRoute:
        "A conversation in the chat works only in the private chat of whoever sets the task up, or in the work group.",
      choices: {
        fresh: "New every time",
        own: "Its own",
        route: "In the chat",
      },
      gateNotYours:
        "Only whoever set up this script, or the owner, can change whether its output goes to the model.",
      hint: [
        "New every time: each run starts from scratch.",
        "Its own: the task remembers earlier runs in a separate conversation only it sees.",
        "In the chat: a run arrives in the conversation of the chat and topic the task reports to, like your own message, and you can continue it. If the conversation is busy, the run waits and interrupts nothing.",
        '"Start over" in the "In the chat" mode clears the chat\'s own conversation, as /new does there (in a private chat and the General topic, the current project\'s conversation).',
      ].join("\n\n"),
      resetDone: "The conversation started over",
      routeNeedsChat:
        "The task is silent: a conversation in the chat needs a chat.",
      scriptHint:
        'For a script the mode changes what it does. "Its own" and "In the chat" make it a gate: its output becomes the model\'s instruction, and the model\'s answer is the result. A gate switched to "New every time" no longer sees taskState and its output is sent as is: change the script itself first.',
      title: "Which conversation this task keeps:",
    },
    title: (count: number) => `Scheduled tasks (${count})`,
    toast: {
      alreadyQueued: "Already waiting its turn",
      deleted: "Deleted",
      missing: "No such task",
      modeSet: "Done",
      notRunning: "Not running",
      paused: "Paused",
      resumed: "Resumed",
      running: "Running",
      runningBound: "Running. If the conversation is busy, I will wait",
      sessionReset: "I will start over once the conversation is free",
      stopped: "Stopped",
      waitingBackground:
        "The last run still waits on background work; this one queues behind it",
    },
    verdictNotice: (title: string) =>
      `The task "${title}" looks undone: the report says the work could not be done.`,
  },
} satisfies typeof ruSchedule;
