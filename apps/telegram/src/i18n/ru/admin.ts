/** Where a person finds the id the access commands ask for. */
const ID_HINT =
  "id — числовой Telegram ID человека, он увидит его, отправив мне /start";

/** Access management and the owner's Telegram account. */
export const admin = {
  account: {
    askPassword: (hint: string | undefined) =>
      `У аккаунта есть облачный пароль.${hint === undefined ? "" : ` Подсказка: ${hint}.`} Отправьте его одним сообщением, я сразу удалю его из чата. Отменить вход: /login`,
    executing: "Выполняю…",
    flood:
      "Telegram просит подождать с попытками входа. Попробуйте позже: /login",
    loggedIn: (name: string) => `Готово, аккаунт подключён: ${name}.`,
    loggedOutDone: "Аккаунт Telegram отключён. Сессия на сервере удалена.",
    loginFailed: "Не получилось войти. Попробуйте ещё раз: /login",
    logoutFailed: "Не получилось отключить аккаунт. Попробуйте позже.",
    off: "Доступ к аккаунту Telegram не включён на этом сервере.",
    passwordNotDeleted:
      "Сообщение с паролем удалить не удалось. Удалите его сами.",
    qrCaption:
      "Откройте Telegram на телефоне: Настройки → Устройства → Подключить устройство, и отсканируйте этот код. Код обновляется каждые 30 секунд. После сканирования вход занимает до 30 секунд.",
    timedOut: "Время на вход вышло. Попробовать ещё раз: /login",
    writesConfirm:
      "Каждое действие от вашего имени (сообщения, файлы, реакции, закрепы, опросы…) я сначала показываю вам с кнопками.",
    writesDirect:
      "Каждое действие от вашего имени (сообщения, файлы, реакции, закрепы, опросы…) делаю сразу, без кнопок. Прямые вызовы Telegram API всё равно ждут вашей кнопки.",
    wrongPassword: "Пароль не подошёл. Отправьте его ещё раз.",
  },
  /** A write on the owner's account, as the confirmation shows it. */
  accountActions: {
    archive: (peer: string) => `Перенести чат в архив.\nЧат: ${peer}`,
    buttons: {
      archive: "В архив",
      delete: "Удалить",
      edit: "Изменить",
      mute: "Выключить уведомления",
      pin: "Закрепить",
      raw: "Выполнить",
      react: "Поставить реакцию",
      retract: "Отозвать голос",
      send: "Отправить",
      sendNow: "Отправить сейчас",
      unarchive: "Из архива",
      unmute: "Включить уведомления",
      unpin: "Открепить",
      vote: "Проголосовать",
    },
    cancelled: "Отменено.",
    clearsDraft: "Черновик в этом чате очистится.",
    closed: "Этот запрос уже закрыт.",
    customEmoji: (id: string) => `свой эмодзи (id ${id})`,
    delete: (input: {
      foreign: string;
      ids: string;
      peer: string;
      revoke: boolean;
    }) =>
      `Удалить сообщения № ${input.ids} ${input.revoke ? "у всех" : "только у вас, у остальных они останутся"}.\nГде: ${input.peer}${input.foreign === "" ? "" : `\nНаписаны не вами: № ${input.foreign}.`}`,
    deleteScheduled: (input: { excerpt: string; ids: string; peer: string }) =>
      `Удалить запланированные сообщения № ${input.ids}: они не отправятся.\nГде: ${input.peer}${input.excerpt}`,
    done: "Готово.",
    edit: (input: {
      id: number;
      peer: string;
      previous: string | undefined;
      text: string;
    }) =>
      input.previous === undefined
        ? `Изменить ваше сообщение №${input.id}.\nГде: ${input.peer}\n\nНовый текст:\n${input.text}`
        : `Изменить ваше сообщение №${input.id}.\nГде: ${input.peer}\n\nБыло:\n${input.previous}\n\nСтало:\n${input.text}`,
    excerpt: (text: string) => `Сообщение: «${text}»`,
    expired: "Истекло: ответа не было сутки.",
    failed: {
      alreadySent:
        "Не получилось: часть сообщений уже отправлена или отменена — ничего не удалено.",
      flood: "Не получилось: Telegram просит подождать.",
      forwardRestricted:
        "Не получилось: в этом чате запрещено пересылать сообщения.",
      loggedOut: "Не получилось: аккаунт Telegram не подключён.",
      muteEnded:
        "Время, до которого нужно было отключить уведомления, уже прошло — уведомления чата не тронуты.",
      peerNotFound: "Не получилось: чат не найден.",
      refused: "Не получилось: Telegram отказал.",
      schedulePassed: "Время отправки уже прошло — ничего не отправлено.",
    },
    fileLine: (input: { kind: string; name: string; size: string }) =>
      `• ${input.name} — ${input.kind}, ${input.size}`,
    forward: (input: {
      from: string;
      ids: string;
      to: string;
      topic: string;
    }) =>
      `Переслать от вашего имени сообщения № ${input.ids}.\nОткуда: ${input.from}\nКуда: ${input.to}${input.topic}`,
    inReplyTo: (id: number) => `Ответом на сообщение №${id}`,
    inTopic: (input: { id: number; title: string }) =>
      `Тема: «${input.title}» (№${input.id})`,
    media: (input: {
      caption: string | undefined;
      count: number;
      files: string;
      options: string;
      peer: string;
      reply: string;
    }) =>
      `${input.count === 1 ? "Отправить файл от вашего имени" : `Отправить альбом от вашего имени, файлов: ${input.count}`}. Как он будет выглядеть — в сообщении выше.\nКому: ${input.peer}${input.reply}${input.options}\n\n${input.files}${input.caption === undefined ? "" : `\n\nПодпись:\n${input.caption}`}`,
    mediaKinds: {
      audio: "аудио",
      document: "файл",
      photo: "фото",
      video: "видео",
      voice: "голосовое сообщение",
    },
    mute: (input: { label: string; peer: string }) =>
      `Выключить уведомления чата до ${input.label}.\nЧат: ${input.peer}`,
    muteForever: (peer: string) =>
      `Выключить уведомления чата навсегда.\nЧат: ${peer}`,
    pin: (input: {
      bothSides: boolean;
      excerpt: string;
      id: number;
      notify: boolean;
      peer: string;
    }) =>
      `Закрепить сообщение №${input.id}${input.notify ? ", с уведомлением участникам" : ", без уведомления"}${input.bothSides ? ", у обоих собеседников" : ""}.\nГде: ${input.peer}${input.excerpt}`,
    poll: (input: {
      answers: readonly string[];
      multiple: boolean;
      options: string;
      peer: string;
      public: boolean;
      question: string;
      reply: string;
    }) =>
      `Создать опрос от вашего имени.\nКуда: ${input.peer}${input.reply}${input.options}\n\nВопрос: ${input.question}\n${input.answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n")}${input.multiple ? "\n\nМожно выбрать несколько вариантов." : ""}${input.public ? "\nВсе увидят, кто как голосовал." : ""}`,
    raw: (input: { body: string; method: string; summary: string }) =>
      `Внимание: прямой вызов Telegram API. Проверьте каждое поле.\n\nМетод: ${input.method}${input.summary === "" ? "" : `\n${input.summary}`}\n\n${input.body}`,
    rawArg: (input: { name: string; value: string }) =>
      `• ${input.name}: ${input.value}`,
    rawBlock: (peer: string) =>
      `Заблокировать от вашего имени: он не сможет вам писать и звонить.\nКого: ${peer}`,
    rawBytes: (count: number, shown: string | null) =>
      shown === null ? `<${count} байт>` : `<${count} байт: ${shown}>`,
    rawImportInvite: (hash: string) =>
      `Вступить в чат по пригласительной ссылке от вашего имени.\nСсылка: https://t.me/+${hash}`,
    rawJoin: (peer: string) =>
      `Вступить в канал или группу от вашего имени.\nКуда: ${peer}`,
    rawLeave: (peer: string) => `Выйти из канала или группы.\nОткуда: ${peer}`,
    rawNoArgs: "Без параметров.",
    rawReaction: (input: { id: number; peer: string; reactions: string }) =>
      input.reactions === ""
        ? `Убрать вашу реакцию с сообщения №${input.id}.\nГде: ${input.peer}`
        : `Поставить реакцию ${input.reactions} на сообщение №${input.id}.\nГде: ${input.peer}`,
    rawUnblock: (peer: string) => `Разблокировать.\nКого: ${peer}`,
    react: (input: {
      big: boolean;
      emoji: string;
      excerpt: string;
      id: number;
      peer: string;
    }) =>
      `Поставить реакцию ${input.emoji}${input.big ? " с крупной анимацией" : ""} на сообщение №${input.id}.\nГде: ${input.peer}${input.excerpt}`,
    reactRemove: (input: { excerpt: string; id: number; peer: string }) =>
      `Убрать вашу реакцию с сообщения №${input.id}.\nГде: ${input.peer}${input.excerpt}`,
    requestedBy: (who: string) => `Просит исполнитель: ${who}.`,
    requestedVia: (key: string) => `Запрошено через API-ключ «${key}».`,
    scheduledFor: (label: string) => `Отправится по расписанию: ${label}.`,
    send: (input: {
      options: string;
      peer: string;
      reply: string;
      text: string;
    }) =>
      `Отправить сообщение от вашего имени.\nКому: ${input.peer}${input.reply}${input.options}\n\nТекст:\n${input.text}`,
    sendScheduled: (input: { excerpt: string; ids: string; peer: string }) =>
      `Отправить сейчас запланированные сообщения № ${input.ids}, не дожидаясь их времени.\nГде: ${input.peer}${input.excerpt}`,
    silent: "Без звука уведомления.",
    unarchive: (peer: string) => `Вернуть чат из архива.\nЧат: ${peer}`,
    unmute: (peer: string) => `Включить уведомления чата.\nЧат: ${peer}`,
    unpin: (input: { excerpt: string; id: number; peer: string }) =>
      `Открепить сообщение №${input.id}.\nГде: ${input.peer}${input.excerpt}`,
    vote: (input: {
      id: number;
      options: string;
      peer: string;
      question: string;
    }) =>
      `Проголосовать в опросе №${input.id} «${input.question}».\nГде: ${input.peer}\nВыбор: ${input.options}`,
    voteRetract: (input: { id: number; peer: string; question: string }) =>
      `Отозвать ваш голос в опросе №${input.id} «${input.question}».\nГде: ${input.peer}`,
  },
  /** One line per access change made outside the bot. */
  audit: {
    apiKeyAdded: (input: { keyId: string; userId: string }) =>
      `Появился ключ HTTP API ${input.keyId} у ${input.userId}.`,
    apiKeyMoved: (input: { after: string; before: string; keyId: string }) =>
      `Ключ HTTP API ${input.keyId} перешёл от ${input.before} к ${input.after}.`,
    apiKeyRemoved: (keyId: string) => `Ключ HTTP API ${keyId} удалён из базы.`,
    apiKeyRestored: (keyId: string) =>
      `Отозванный ключ HTTP API ${keyId} снова работает.`,
    apiKeyRevoked: (keyId: string) => `Ключ HTTP API ${keyId} отозван.`,
    apiKeySecretReplaced: (keyId: string) =>
      `У ключа HTTP API ${keyId} подменили секрет: им теперь можно войти с другим токеном.`,
    changedOutside: "Доступ изменился не через меня:",
    granted: (input: { tier: string; userId: string }) =>
      `Доступ появился у ${input.userId}: ${input.tier}.`,
    groupTrusted: (id: string) => `Группа ${id} стала доверенной.`,
    groupUntrusted: (id: string) => `Группа ${id} больше не доверенная.`,
    noWorkspace: "не задана",
    revoked: (userId: string) => `Доступ убран у ${userId}.`,
    tierChanged: (input: { after: string; before: string; userId: string }) =>
      `У ${input.userId} уровень: ${input.before} → ${input.after}.`,
    workspaceMoved: (input: { after: string; before: string }) =>
      `Рабочая группа: ${input.before} → ${input.after}.`,
  },
  users: {
    callName: {
      current: (name: string) =>
        `В группах я отзываюсь на «${name}». Чтобы сменить — /callname <имя>.`,
      set: (name: string) => `В группах буду отзываться на «${name}».`,
      setNotRenamed: (name: string) =>
        `В группах буду отзываться на «${name}», но имя в Telegram сменить не получилось. Попробуйте позже.`,
      unset: "Имя не задано. Отправьте /callname <имя>, чтобы выбрать.",
    },
    count: (count: number) => `Доступ есть у ${count}`,
    empty: `Пока никого нет. Добавить: /grant <id> <executor|member>, где ${ID_HINT}.`,
    grantUsage: `Как пользоваться: /grant <id> <executor|member>, где ${ID_HINT}. Или ответьте на сообщение человека командой /grant <executor|member>.`,
    granted: (input: { tier: string; userId: number }) =>
      `${input.userId} — теперь ${input.tier}.`,
    makeTier: (tier: string) => `Сделать: ${tier}`,
    noSuchTier: "Такого уровня нет",
    notListed: (userId: number) => `${userId} и так не было в списке.`,
    nowTier: (tier: string) => `Теперь ${tier}`,
    /** `/access`: everything that decides who the bot obeys. */
    overview: {
      noPeople: "Людей с доступом нет.",
      noWorkspace: "не задана",
      none: "нет",
      people: (count: number) => `Люди (${count}):`,
      title: "Доступ",
      topic: (id: string) => `тема ${id}`,
      trusted: (list: string) => `Доверенные группы: ${list}`,
      workspace: (place: string) => `Рабочая группа: ${place}`,
    },
    ownId:
      "Это ваш собственный ID. Ваш доступ задан в настройках бота, командой его не поменять.",
    remove: "Убрать",
    removed: "Убрано",
    revokeUsage: `Как пользоваться: /revoke <id>, где ${ID_HINT}. Или ответьте на сообщение человека командой /revoke.`,
    revoked: (userId: number) => `${userId} больше не имеет доступа.`,
    unknownUser: "Не знаю такого",
  },
};
