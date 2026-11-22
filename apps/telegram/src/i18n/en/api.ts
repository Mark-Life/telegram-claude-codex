import type { api as ruApi } from "../ru/api";

/** `/apikeys`: HTTP API keys of the owner and executors. */
export const api = {
  apiKeys: {
    askName:
      "What should the key be called? Send a name as one message, like “ChatGPT” or “Mail”. Up to 64 characters.",
    badName:
      "A name is one line of up to 64 characters. Press “New key” again.",
    cancelled: "No key was made.",
    create: "New key",
    created: (input: { minutes: number; name: string; token: string }) =>
      `Key “${input.name}”:\n\n<code>${input.token}</code>\n\nIt is shown once — copy it now. This message deletes itself in ${input.minutes} min.`,
    createdNote: (name: string) =>
      `Key “${name}” is made. You can revoke it here, in /apikeys.`,
    empty: "No live keys.",
    entry: (input: {
      created: string;
      hint: string;
      holder: number | undefined;
      lastUsed: string | undefined;
      name: string;
    }) =>
      [
        `<b>${input.name}</b> · <code>${input.hint}</code>`,
        ...(input.holder === undefined ? [] : [`Whose: ${input.holder}`]),
        `Made: ${input.created}`,
        `Last used: ${input.lastUsed ?? "not yet"}`,
      ].join("\n"),
    executorIssued: (input: { name: string; userId: number }) =>
      `Executor ${input.userId} made an HTTP API key for themselves: “${input.name}”.`,
    failed: "That did not work. Try again.",
    intro: (input: { executor: boolean; url: string | undefined }) =>
      [
        "<b>HTTP API keys</b>",
        "",
        "A key lets programs (Codex, ChatGPT through Executor, webhooks, scripts) reach me over HTTP. A key acts as you, exactly as you in a private chat with me, so keep it like the bot's password.",
        ...(input.executor
          ? [
              "",
              "An executor's key gets the whole machine and the owner's account, just like your conversations with me.",
            ]
          : []),
        "",
        input.url === undefined
          ? "The HTTP API is off now (API_ENABLED). Keys start working once it is on."
          : `Address: ${input.url}\nFor programs: ${input.url}/openapi.json\nDocs: ${input.url}/docs`,
      ].join("\n"),
    list: "My keys",
    listAll: "All keys",
    notForYou: "Only the owner and executors have HTTP API keys.",
    notFound: "No such live key: it was revoked already or is not yours.",
    privateOnly: "Keys are managed only in a private chat with me.",
    revoke: "Revoke",
    revoked: (name: string) => `Key “${name}” is revoked and no longer works.`,
  },
  /** An agent run started over the HTTP API. */
  apiRuns: {
    /** Above an answer the bot sends to the key holder's chat. */
    delivered: (key: string) =>
      `The answer to a request through the API key “${key}”:`,
  },
  /** The owner hears at boot that the HTTP API is on in `.env` but did not start. */
  apiServer: {
    notStarted:
      "HTTP API is off: the server did not start. The reason is in the log; restart the bot once it is fixed.",
    portBusy: (port: number) =>
      `HTTP API is off: port ${port} is busy. Change API_PORT and restart.`,
  },
} satisfies typeof ruApi;
