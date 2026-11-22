import type { admin as ruAdmin } from "../ru/admin";

/** Where a person finds the id the access commands ask for. */
const ID_HINT =
  "id is the person's numeric Telegram ID; they see it when they send me /start";

export const admin = {
  account: {
    askPassword: (hint: string | undefined) =>
      `The account has a cloud password.${hint === undefined ? "" : ` Hint: ${hint}.`} Send it as one message; I delete it from the chat at once. To cancel the sign-in: /login`,
    executing: "Working on it…",
    flood: "Telegram asks to wait before signing in again. Try later: /login",
    loggedIn: (name: string) => `Done, the account is connected: ${name}.`,
    loggedOutDone:
      "The Telegram account is disconnected. The session on the server is deleted.",
    loginFailed: "I could not sign in. Try again: /login",
    logoutFailed: "I could not disconnect the account. Try again later.",
    off: "Access to a Telegram account is not turned on on this server.",
    passwordNotDeleted:
      "I could not delete the message with the password. Please delete it yourself.",
    qrCaption:
      "Open Telegram on your phone: Settings → Devices → Link Desktop Device, and scan this code. The code changes every 30 seconds. After the scan, sign-in takes up to 30 seconds.",
    timedOut: "The time to sign in ran out. To try again: /login",
    writesConfirm:
      "Before every action as you (messages, files, reactions, pins, polls…), I show it to you with buttons.",
    writesDirect:
      "I take every action as you (messages, files, reactions, pins, polls…) at once, without buttons. Direct Telegram API calls still wait for your button.",
    wrongPassword: "Wrong password. Send it again.",
  },
  accountActions: {
    archive: (peer: string) => `Move the chat to the archive.\nChat: ${peer}`,
    buttons: {
      archive: "Archive",
      delete: "Delete",
      edit: "Edit",
      mute: "Mute",
      pin: "Pin",
      raw: "Run",
      react: "React",
      retract: "Retract vote",
      send: "Send",
      sendNow: "Send now",
      unarchive: "Unarchive",
      unmute: "Unmute",
      unpin: "Unpin",
      vote: "Vote",
    },
    cancelled: "Cancelled.",
    clearsDraft: "Your draft in this chat will be cleared.",
    closed: "This request is closed already.",
    customEmoji: (id: string) => `a custom emoji (id ${id})`,
    delete: (input: {
      foreign: string;
      ids: string;
      peer: string;
      revoke: boolean;
    }) =>
      `Delete messages no. ${input.ids} ${input.revoke ? "for everyone" : "only for you; everyone else keeps them"}.\nWhere: ${input.peer}${input.foreign === "" ? "" : `\nNot written by you: no. ${input.foreign}.`}`,
    deleteScheduled: (input: { excerpt: string; ids: string; peer: string }) =>
      `Delete scheduled messages no. ${input.ids}: they will not go out.\nWhere: ${input.peer}${input.excerpt}`,
    done: "Done.",
    edit: (input: {
      id: number;
      peer: string;
      previous: string | undefined;
      text: string;
    }) =>
      input.previous === undefined
        ? `Edit your message no. ${input.id}.\nWhere: ${input.peer}\n\nNew text:\n${input.text}`
        : `Edit your message no. ${input.id}.\nWhere: ${input.peer}\n\nWas:\n${input.previous}\n\nNow:\n${input.text}`,
    excerpt: (text: string) => `Message: "${text}"`,
    expired: "Expired: no answer for a day.",
    failed: {
      alreadySent:
        "That did not work: some of the messages were already sent or cancelled; nothing was deleted.",
      flood: "That did not work: Telegram asks to wait.",
      forwardRestricted:
        "That did not work: this chat does not allow forwarding.",
      loggedOut: "That did not work: the Telegram account is not connected.",
      muteEnded:
        "The mute would already have ended; the chat's notifications were left as they are.",
      peerNotFound: "That did not work: the chat was not found.",
      refused: "That did not work: Telegram refused.",
      schedulePassed: "The send time has already passed; nothing was sent.",
    },
    fileLine: (input: { kind: string; name: string; size: string }) =>
      `• ${input.name} — ${input.kind}, ${input.size}`,
    forward: (input: {
      from: string;
      ids: string;
      to: string;
      topic: string;
    }) =>
      `Forward messages no. ${input.ids} on your behalf.\nFrom: ${input.from}\nTo: ${input.to}${input.topic}`,
    inReplyTo: (id: number) => `In reply to message no. ${id}`,
    inTopic: (input: { id: number; title: string }) =>
      `Topic: "${input.title}" (no. ${input.id})`,
    media: (input: {
      caption: string | undefined;
      count: number;
      files: string;
      options: string;
      peer: string;
      reply: string;
    }) =>
      `${input.count === 1 ? "Send a file on your behalf" : `Send an album of ${input.count} files on your behalf`}. The message above shows how it will look.\nTo: ${input.peer}${input.reply}${input.options}\n\n${input.files}${input.caption === undefined ? "" : `\n\nCaption:\n${input.caption}`}`,
    mediaKinds: {
      audio: "audio",
      document: "file",
      photo: "photo",
      video: "video",
      voice: "voice message",
    },
    mute: (input: { label: string; peer: string }) =>
      `Mute the chat until ${input.label}.\nChat: ${input.peer}`,
    muteForever: (peer: string) => `Mute the chat for good.\nChat: ${peer}`,
    pin: (input: {
      bothSides: boolean;
      excerpt: string;
      id: number;
      notify: boolean;
      peer: string;
    }) =>
      `Pin message no. ${input.id}${input.notify ? ", notifying the members" : ", without a notification"}${input.bothSides ? ", for both sides" : ""}.\nWhere: ${input.peer}${input.excerpt}`,
    poll: (input: {
      answers: readonly string[];
      multiple: boolean;
      options: string;
      peer: string;
      public: boolean;
      question: string;
      reply: string;
    }) =>
      `Post a poll on your behalf.\nTo: ${input.peer}${input.reply}${input.options}\n\nQuestion: ${input.question}\n${input.answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n")}${input.multiple ? "\n\nSeveral answers can be chosen." : ""}${input.public ? "\nEveryone sees who voted for what." : ""}`,
    raw: (input: { body: string; method: string; summary: string }) =>
      `Warning: a direct Telegram API call. Check every field.\n\nMethod: ${input.method}${input.summary === "" ? "" : `\n${input.summary}`}\n\n${input.body}`,
    rawArg: (input: { name: string; value: string }) =>
      `• ${input.name}: ${input.value}`,
    rawBlock: (peer: string) =>
      `Block as you: they can no longer message or call you.\nWho: ${peer}`,
    rawBytes: (count: number, shown: string | null) =>
      shown === null ? `<${count} bytes>` : `<${count} bytes: ${shown}>`,
    rawImportInvite: (hash: string) =>
      `Join a chat by its invite link as you.\nLink: https://t.me/+${hash}`,
    rawJoin: (peer: string) =>
      `Join a channel or group as you.\nWhere: ${peer}`,
    rawLeave: (peer: string) => `Leave a channel or group.\nWhere: ${peer}`,
    rawNoArgs: "No parameters.",
    rawReaction: (input: { id: number; peer: string; reactions: string }) =>
      input.reactions === ""
        ? `Remove your reaction from message no. ${input.id}.\nWhere: ${input.peer}`
        : `React with ${input.reactions} to message no. ${input.id}.\nWhere: ${input.peer}`,
    rawUnblock: (peer: string) => `Unblock.\nWho: ${peer}`,
    react: (input: {
      big: boolean;
      emoji: string;
      excerpt: string;
      id: number;
      peer: string;
    }) =>
      `React with ${input.emoji}${input.big ? ", with the big animation," : ""} to message no. ${input.id}.\nWhere: ${input.peer}${input.excerpt}`,
    reactRemove: (input: { excerpt: string; id: number; peer: string }) =>
      `Remove your reaction from message no. ${input.id}.\nWhere: ${input.peer}${input.excerpt}`,
    requestedBy: (who: string) => `Asked by an executor: ${who}.`,
    requestedVia: (key: string) => `Requested through the API key “${key}”.`,
    scheduledFor: (label: string) => `Goes out on schedule: ${label}.`,
    send: (input: {
      options: string;
      peer: string;
      reply: string;
      text: string;
    }) =>
      `Send a message on your behalf.\nTo: ${input.peer}${input.reply}${input.options}\n\nText:\n${input.text}`,
    sendScheduled: (input: { excerpt: string; ids: string; peer: string }) =>
      `Send scheduled messages no. ${input.ids} now, without waiting for their time.\nWhere: ${input.peer}${input.excerpt}`,
    silent: "Without a notification sound.",
    unarchive: (peer: string) =>
      `Move the chat out of the archive.\nChat: ${peer}`,
    unmute: (peer: string) => `Unmute the chat.\nChat: ${peer}`,
    unpin: (input: { excerpt: string; id: number; peer: string }) =>
      `Unpin message no. ${input.id}.\nWhere: ${input.peer}${input.excerpt}`,
    vote: (input: {
      id: number;
      options: string;
      peer: string;
      question: string;
    }) =>
      `Vote in poll no. ${input.id} "${input.question}".\nWhere: ${input.peer}\nChoice: ${input.options}`,
    voteRetract: (input: { id: number; peer: string; question: string }) =>
      `Retract your vote in poll no. ${input.id} "${input.question}".\nWhere: ${input.peer}`,
  },
  audit: {
    apiKeyAdded: (input: { keyId: string; userId: string }) =>
      `A new HTTP API key ${input.keyId} for ${input.userId}.`,
    apiKeyMoved: (input: { after: string; before: string; keyId: string }) =>
      `HTTP API key ${input.keyId} moved from ${input.before} to ${input.after}.`,
    apiKeyRemoved: (keyId: string) =>
      `HTTP API key ${keyId} was deleted from the db.`,
    apiKeyRestored: (keyId: string) =>
      `Revoked HTTP API key ${keyId} works again.`,
    apiKeyRevoked: (keyId: string) => `HTTP API key ${keyId} was revoked.`,
    apiKeySecretReplaced: (keyId: string) =>
      `HTTP API key ${keyId} got a different secret: another token now works for it.`,
    changedOutside: "Access changed without me:",
    granted: (input: { tier: string; userId: string }) =>
      `${input.userId} got access: ${input.tier}.`,
    groupTrusted: (id: string) => `Group ${id} is trusted now.`,
    groupUntrusted: (id: string) => `Group ${id} is no longer trusted.`,
    noWorkspace: "not set",
    revoked: (userId: string) => `${userId} lost access.`,
    tierChanged: (input: { after: string; before: string; userId: string }) =>
      `${input.userId}'s level: ${input.before} → ${input.after}.`,
    workspaceMoved: (input: { after: string; before: string }) =>
      `Work group: ${input.before} → ${input.after}.`,
  },
  users: {
    callName: {
      current: (name: string) =>
        `In groups I answer to "${name}". To change it: /callname <name>.`,
      set: (name: string) => `In groups I will answer to "${name}".`,
      setNotRenamed: (name: string) =>
        `In groups I will answer to "${name}", but I could not change my name in Telegram. Try again later.`,
      unset: "No name is set. Send /callname <name> to choose one.",
    },
    count: (count: number) => `${count} with access`,
    empty: `Nobody yet. To add someone: /grant <id> <executor|member>, where ${ID_HINT}.`,
    grantUsage: `Usage: /grant <id> <executor|member>, where ${ID_HINT}. Or reply to the person's message with /grant <executor|member>.`,
    granted: (input: { tier: string; userId: number }) =>
      `${input.userId} is now ${input.tier}.`,
    makeTier: (tier: string) => `Make: ${tier}`,
    noSuchTier: "No such level",
    notListed: (userId: number) => `${userId} was not on the list anyway.`,
    nowTier: (tier: string) => `Now ${tier}`,
    overview: {
      noPeople: "Nobody has access.",
      noWorkspace: "not set",
      none: "none",
      people: (count: number) => `People (${count}):`,
      title: "Access",
      topic: (id: string) => `topic ${id}`,
      trusted: (list: string) => `Trusted groups: ${list}`,
      workspace: (place: string) => `Work group: ${place}`,
    },
    ownId:
      "This is your own ID. Your access is set in the bot's configuration; a command cannot change it.",
    remove: "Remove",
    removed: "Removed",
    revokeUsage: `Usage: /revoke <id>, where ${ID_HINT}. Or reply to the person's message with /revoke.`,
    revoked: (userId: number) => `${userId} no longer has access.`,
    unknownUser: "I do not know this person",
  },
} satisfies typeof ruAdmin;
