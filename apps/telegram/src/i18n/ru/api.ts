/** `/apikeys`: HTTP API keys of the owner and executors. */
export const api = {
  apiKeys: {
    askName:
      "Как назвать ключ? Пришлите название одним сообщением, например «ChatGPT» или «Почта». До 64 символов.",
    badName:
      "Название должно быть одной строкой до 64 символов. Нажмите «Новый ключ» ещё раз.",
    cancelled: "Ключ не создан.",
    create: "Новый ключ",
    created: (input: { minutes: number; name: string; token: string }) =>
      `Ключ «${input.name}»:\n\n<code>${input.token}</code>\n\nОн показан один раз — скопируйте его сейчас. Это сообщение удалится через ${input.minutes} мин.`,
    createdNote: (name: string) =>
      `Ключ «${name}» создан. Отозвать его можно здесь же, в /apikeys.`,
    empty: "Живых ключей нет.",
    /** One key in the list; `holder` only in the owner's view of someone else's. */
    entry: (input: {
      created: string;
      hint: string;
      holder: number | undefined;
      lastUsed: string | undefined;
      name: string;
    }) =>
      [
        `<b>${input.name}</b> · <code>${input.hint}</code>`,
        ...(input.holder === undefined ? [] : [`Чей: ${input.holder}`]),
        `Создан: ${input.created}`,
        `Последний раз: ${input.lastUsed ?? "ещё не использовался"}`,
      ].join("\n"),
    /** The owner hears of a key an executor made for themselves. */
    executorIssued: (input: { name: string; userId: number }) =>
      `Исполнитель ${input.userId} создал себе ключ HTTP API «${input.name}».`,
    failed: "Не получилось. Попробуйте ещё раз.",
    /** The intro above the buttons; `url` is where the API is served. */
    intro: (input: { executor: boolean; url: string | undefined }) =>
      [
        "<b>Ключи HTTP API</b>",
        "",
        "Ключ даёт программам (Codex, ChatGPT через Executor, вебхукам, скриптам) доступ ко мне по HTTP. Ключ действует от вашего имени, ровно как вы в личном чате со мной, поэтому храните его как пароль от бота.",
        ...(input.executor
          ? [
              "",
              "У исполнителя ключ получает всю машину и аккаунт владельца, как и ваши разговоры со мной.",
            ]
          : []),
        "",
        input.url === undefined
          ? "HTTP API сейчас выключено (API_ENABLED). Ключи заработают, когда его включат."
          : `Адрес: ${input.url}\nОписание для программ: ${input.url}/openapi.json\nДокументация: ${input.url}/docs`,
      ].join("\n"),
    list: "Мои ключи",
    listAll: "Все ключи",
    notForYou: "Ключи HTTP API есть только у владельца и исполнителей.",
    notFound: "Такого живого ключа нет: он уже отозван или не ваш.",
    privateOnly: "Ключами можно управлять только в личном чате со мной.",
    revoke: "Отозвать",
    revoked: (name: string) => `Ключ «${name}» отозван и больше не работает.`,
  },
  /** An agent run started over the HTTP API. */
  apiRuns: {
    /** Above an answer the bot sends to the key holder's chat. */
    delivered: (key: string) => `Ответ на запрос через API-ключ «${key}»:`,
  },
  /** The owner hears at boot that the HTTP API is on in `.env` but did not start. */
  apiServer: {
    notStarted:
      "HTTP API выключен: сервер не запустился. Причина — в журнале; после исправления перезапустите бота.",
    portBusy: (port: number) =>
      `HTTP API выключен: порт ${port} занят. Поменяйте API_PORT и перезапустите бота.`,
  },
};
