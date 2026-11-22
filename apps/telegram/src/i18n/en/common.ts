import type { Persona } from "../../persona";
import type { common as ruCommon } from "../ru/common";

/** The name the bot answers to while `call_name` is unset. */
const DEFAULT_CALL_NAME = "Assistant";

export const common = {
  business: {
    cannotReply: ({ callName }: Persona) =>
      `I saw a request in a private conversation, but Telegram does not let me reply on your behalf. Reconnect ${callName} in Telegram Business and turn on the "Reply to messages" right.`,
    replyFailed: (input: { chat: string; copy: string }) =>
      `I could not reply in the conversation with ${input.chat}. ${input.copy}`,
  },
  cancel: "Cancel",
  commands: {
    access: "Whom I trust, and where",
    apikeys: "Keys for the HTTP API",
    callname: "The name I answer to",
    cancel: "Discard the draft",
    compact: "Sum up and continue",
    compose: "Collect several messages into one",
    context: "How full the conversation's memory is",
    effort: "How carefully to think",
    grant: "Give someone access",
    help: "What I can do",
    history: "Go back to a past conversation",
    login: "Sign in to accounts",
    model: "Which model to use",
    new: "Start a new conversation",
    provider: "Who answers",
    reminders: "All reminders",
    revoke: "Take access away",
    send: "Send the draft",
    settings: "Settings",
    stop: "Stop the current work",
    task: "Add a scheduled task",
    tasks: "Scheduled tasks",
    usage: "How much of each subscription is used",
    users: "Who can use me",
  },
  dateLocale: "en-GB",
  defaultCallName: DEFAULT_CALL_NAME,
  errors: {
    AgentInterrupted: "Stopped.",
    AtCapacity: "I am busy right now. Try again in a minute.",
    ProviderCrashed: "Something went wrong. Please try again.",
    detail: (text: string) => `Error text: ${text}`,
    generic: "Something went wrong. Please try again.",
  },
  group: {
    ready: ({ callName, ownerName }: Persona) => {
      const assistant =
        ownerName === undefined
          ? "I am an assistant"
          : `I am ${ownerName}'s assistant`;
      return callName === DEFAULT_CALL_NAME
        ? `${assistant} and ready to work. To get an answer from me, call me "${callName}", mention me or reply to my message.`
        : `My name is ${callName}. ${assistant} and ready to work. To get an answer from me, call me by my name: ${callName}. You can also mention me or reply to my message.`;
    },
  },
  languageName: "English",
  login: {
    cancelled: "Sign-in cancelled.",
    confirmTitle: "Confirm the sign-in:",
    connecting: "Connecting. One moment...",
    done: "Done, the connection works. You can use me as usual.",
    enterCode: (code: string) => `Enter the code: ${code}`,
    failed: "The confirmation did not go through. Send /login to try again.",
    menu: {
      button: {
        cancel: (name: string) => `Cancel sign-in: ${name}`,
        in: (name: string) => `Sign in: ${name}`,
        out: (name: string) => `Sign out: ${name}`,
      },
      header: "Sign-in to accounts:",
      loggedIn: "connected.",
      loggedInAs: (input: { name: string; writes: string }) =>
        `connected, ${input.name}. ${input.writes}`,
      loggedOut: "not connected.",
      notInstalled: "not installed on the server.",
      off: 'off on this server. How to turn it on: README, section "Telegram account".',
      privateOnly:
        "Signing in to accounts works only in a private chat with me.",
      running: "signing in.",
      telegram: "Telegram account",
    },
    open: (url: string) => `Open ${url}`,
    spawnFailed: "I could not start the connection. Try again later.",
    startedNoHint:
      "The connection started, but there is no hint to show. Try /login again.",
    startedServerSays: "The connection started. This is what the server says:",
    willWait: "I will wait and tell you when it works.",
  },
  noSuchOption: "No such option",
  notForYou: "This command is not available.",
  notYourButton: "This button is not for you.",
  promptLanguage: "English",
  provider: {
    hint: {
      loginOnServer: (name: string) =>
        `Someone has to sign in to ${name} on the server.`,
      loginOrWait: "Send /login or try again later.",
      switch: "Switch with /provider.",
      switchOrWait: "Switch with /provider or try again later.",
      wait: "Try again later.",
    },
    menu: {
      already: (name: string) => `I already answer through ${name}.`,
      executorsToo: (name: string) =>
        `If executors write to me privately through ${name}, their conversation starts over too.`,
      header: "Who answers in this conversation:",
      notHere:
        "You cannot choose here: switch in a private chat or in a topic of the work group.",
      notOwner: "Only the owner can choose who answers.",
      notReady: {
        logged_out: "someone has to sign in on the server",
        missing: "not installed",
        ready: "",
        unknown: "did not answer the check",
        unsupported: "does not start on the server",
      },
      onlyOne: (name: string) => `Only ${name} is connected now.`,
      switched: (name: string) =>
        `From now on I answer through ${name}. This is a new conversation.`,
      switchedToast: (name: string) => `Now through ${name}`,
    },
    noFiles: "I cannot work with files in this chat.",
    topicUnavailable: (name: string) =>
      `This topic runs through ${name}, and it is not available now.`,
    unavailable: (name: string) => `${name} is not available now.`,
  },
  quota: {
    allSpent: "The shared limit for today is used up. Let's continue tomorrow.",
    groupsSpent:
      "The shared group limit for today is used up. Let's continue tomorrow.",
    strangerBusy: (input: { limit: number; used: number; who: string }) =>
      `A stranger is writing a lot: ${input.who}, ${input.used} of ${input.limit} requests today.`,
    strangerSpent: (input: { limit: number; who: string }) =>
      `A stranger used up the daily limit: ${input.who}, ${input.limit} requests today.`,
    userSpent: (limit: number) =>
      `Your ${limit} requests for today are used up. Let's continue tomorrow.`,
  },
  repeat: {
    skipped:
      "This repeats the message you sent less than a minute ago, and the answer will come in that topic. To run it again, send it in that topic.",
  },
  startup: {
    back: "The bot restarted. I am back online.",
    goesTo: (name: string) => `new conversations go through ${name}`,
    noAccount: "No work account is connected.",
    notConnected: "is not connected",
    notResumed: (count: number) =>
      `Conversations with background work that could not go on after the restart: ${count}. Write in them if the work is still needed.`,
    ownerWaits:
      "I will not answer in the private chat until you sign in or switch with /provider",
    resumed: (count: number) =>
      `Resuming conversations that waited on background work: ${count}.`,
    sendLogin: "Send /login.",
    unchecked: (name: string) => `${name} did not answer the check.`,
    wontStart: "does not start on the server",
  },
  tiers: {
    executor: "executor",
    guest: "no access",
    member: "member",
    owner: "owner",
  },
  tryAgain: "That did not work. Please try again.",
  uploads: {
    albumClosed:
      "The album is closed already, and some photos did not get into it. Send them again.",
    fileFailed: "I could not save the file. Please try again.",
    photoFailed: "I could not save the photo. Please try again.",
    photosFailed: "I could not save the photos. Please try again.",
    repliedFileFailed:
      "I could not get the file from the message you replied to. Forward the file again.",
    tooLarge: (maxMb: number) =>
      `The file is too large. I accept up to ${maxMb} MB.`,
    unreadable: "I cannot open files here. Write what you need as text.",
  },
  usage: {
    limitReached: "⛔ Limit reached.",
    noLimits: "the bot does not show its limits",
    noProviders: "No agent is installed on the server.",
    noReading: "could not read the limits, try again later",
    noWindows: "This login shows no subscription limits.",
    privateOnly: "I show subscription limits only in a private chat with me.",
    reading: "Checking subscription limits…",
    resets: (when: string) => `resets ${when}`,
    span: {
      day: (count: number) => (count === 1 ? "Day" : `${count} days`),
      hour: (count: number) => `${count} h`,
      minute: (count: number) => `${count} min`,
      unknown: "Limit",
      week: (count: number) => (count === 1 ? "Week" : `${count} weeks`),
    },
    used: (percent: number) => `${percent}% used`,
  },
  voice: {
    failed:
      "I could not make out the voice note. Try again or write it as text.",
    transcribing: "Transcribing...",
  },
  workspace: {
    groupSet: "This is my work group now. I will post here myself.",
    onlyInGroup: "This command works in a group.",
    topicSet: "This is my work topic now. I will post here myself.",
  },
} satisfies typeof ruCommon;
