import type { AgentError } from "@workspace/agent";
import type { ProviderAvailability } from "@workspace/agent/types";

import type { Tier } from "../../access/tier";
import type { Persona } from "../../persona";
import type { MenuCommand } from "../../telegram/commands";
import { accusativeName, byGender, genitiveName } from "../ru-grammar";

/** The name the bot answers to while `call_name` is unset. */
const DEFAULT_CALL_NAME = "Ассистент";

/** Copy shared across features, plus everything that is not one feature. */
export const common = {
  business: {
    cannotReply: ({ callName, gender }: Persona) =>
      `Я ${byGender(gender, "увидела", "увидел")} обращение в личной переписке, но Telegram не разрешает отвечать от вашего имени. Переподключите ${accusativeName(callName)} в Telegram Business и включите право «Отвечать на сообщения».`,
    replyFailed: (input: { chat: string; copy: string }) =>
      `Не получилось ответить в переписке с ${input.chat}. ${input.copy}`,
  },
  cancel: "Отмена",
  commands: {
    access: "Кому и откуда я доверяю",
    apikeys: "Ключи для HTTP API",
    callname: "Имя, на которое я отзываюсь",
    cancel: "Не отправлять, всё стереть",
    compact: "Подвести итог и продолжить",
    compose: "Собрать несколько сообщений в одно",
    context: "Сколько памяти разговора занято",
    effort: "Насколько тщательно думать",
    grant: "Дать человеку доступ",
    help: "Что я умею",
    history: "Вернуться к прошлому разговору",
    login: "Войти в аккаунты",
    model: "Какой моделью пользоваться",
    new: "Начать разговор заново",
    provider: "Через кого отвечать",
    reminders: "Все напоминания",
    revoke: "Забрать доступ",
    send: "Отправить собранное",
    settings: "Настройки",
    stop: "Остановить текущую работу",
    task: "Добавить дело по расписанию",
    tasks: "Дела по расписанию",
    usage: "Сколько израсходовано по подпискам",
    users: "Кто может мной пользоваться",
  } satisfies Record<MenuCommand, string>,
  /** `Intl` locale for dates and times. */
  dateLocale: "ru-RU",
  defaultCallName: DEFAULT_CALL_NAME,
  /** What a user is told when a run does not finish. */
  errors: {
    AgentInterrupted: "Остановлено.",
    AtCapacity: "Сейчас слишком много запросов. Попробуйте через минуту.",
    ProviderCrashed: "Что-то пошло не так. Попробуйте ещё раз.",
    detail: (text: string) => `Текст ошибки: ${text}`,
    generic: "Что-то пошло не так. Попробуйте ещё раз.",
  } satisfies Record<AgentError["_tag"] | "generic", string> & {
    detail: (text: string) => string;
  },
  group: {
    /** The introduction a group gets when the bot is added to it. */
    ready: ({ callName, gender, ownerName }: Persona) => {
      const assistant =
        ownerName === undefined
          ? "Я ассистент"
          : `Я ассистент ${genitiveName(ownerName)}`;
      const ready = `${assistant} и ${byGender(gender, "готова", "готов")} работать.`;
      const answer = `Чтобы я вам ${byGender(gender, "отвечала", "отвечал")}`;
      // The default name is the word "assistant" itself: no "my name is".
      return callName === DEFAULT_CALL_NAME
        ? `${ready} ${answer}, обращайтесь ко мне «${callName}», упомяните меня или ответьте на моё сообщение.`
        : `Меня зовут ${callName}. ${ready} ${answer}, обращайтесь ко мне по имени — ${callName}. Также можно упомянуть меня или ответить на моё сообщение.`;
    },
  },
  /** The language's own name, as the settings menu shows it. */
  languageName: "Русский",
  login: {
    cancelled: "Вход отменён.",
    confirmTitle: "Осталось подтвердить вход:",
    connecting: "Подключаю. Секунду...",
    done: "Готово, подключение работает. Можно пользоваться как обычно.",
    enterCode: (code: string) => `Введите код: ${code}`,
    failed:
      "Подтверждение не прошло. Отправьте /login, чтобы попробовать ещё раз.",
    /** `/login`: one line and a row of buttons per thing to sign in to. */
    menu: {
      button: {
        cancel: (name: string) => `Отменить вход: ${name}`,
        in: (name: string) => `Войти: ${name}`,
        out: (name: string) => `Выйти: ${name}`,
      },
      header: "Вход в аккаунты:",
      loggedIn: "подключён.",
      loggedInAs: (input: { name: string; writes: string }) =>
        `подключён, ${input.name}. ${input.writes}`,
      loggedOut: "не подключён.",
      notInstalled: "не установлен на сервере.",
      off: "выключен на этом сервере. Как включить: README, раздел «Telegram account».",
      privateOnly: "Входить в аккаунты можно только в личном чате со мной.",
      running: "идёт вход.",
      telegram: "Аккаунт Telegram",
    },
    open: (url: string) => `Откройте ${url}`,
    spawnFailed: "Не удалось запустить подключение. Попробуйте позже.",
    startedNoHint:
      "Подключение началось, но подсказки не видно. Попробуйте /login ещё раз.",
    startedServerSays: "Подключение началось. Вот что пишет сервер:",
    willWait: "Я подожду и скажу, когда всё получится.",
  },
  noSuchOption: "Такого варианта нет",
  notForYou: "Эта команда недоступна.",
  notYourButton: "Эта кнопка не для вас.",
  /** The language's English name, for prompts that ask a model to write it. */
  promptLanguage: "Russian",
  provider: {
    hint: {
      loginOnServer: (name: string) =>
        `Нужно войти в аккаунт ${name} на сервере.`,
      loginOrWait: "Отправьте /login или попробуйте позже.",
      switch: "Переключитесь командой /provider.",
      switchOrWait: "Переключитесь командой /provider или попробуйте позже.",
      wait: "Попробуйте позже.",
    },
    menu: {
      already: (name: string) => `Уже отвечаю через ${name}.`,
      executorsToo: (name: string) =>
        `Если исполнители пишут мне в личку через ${name}, их разговор тоже начнётся заново.`,
      header: "Через кого отвечать в этом разговоре:",
      notHere:
        "Здесь выбрать нельзя: переключать можно в личном чате и в темах рабочей группы.",
      notOwner: "Выбирать, через кого я отвечаю, может только владелец.",
      /** Why a provider that is not ready is not a button. */
      notReady: {
        logged_out: "нужно войти в аккаунт на сервере",
        missing: "не установлен",
        ready: "",
        unknown: "не ответил при проверке",
        unsupported: "не запускается на сервере",
      } satisfies Record<ProviderAvailability, string>,
      onlyOne: (name: string) => `Сейчас подключён только ${name}.`,
      switched: (name: string) =>
        `Дальше отвечаю через ${name}. Это новый разговор.`,
      switchedToast: (name: string) => `Дальше через ${name}`,
    },
    noFiles: "В этом чате я не могу работать с файлами.",
    topicUnavailable: (name: string) =>
      `В этой теме разговор ведётся через ${name}, а он сейчас недоступен.`,
    unavailable: (name: string) => `${name} сейчас недоступен.`,
  },
  quota: {
    allSpent: "На сегодня общий лимит обращений исчерпан. Продолжим завтра.",
    groupsSpent:
      "На сегодня общий лимит обращений в группах исчерпан. Продолжим завтра.",
    strangerBusy: (input: { limit: number; used: number; who: string }) =>
      `Незнакомец активно пишет: ${input.who} — ${input.used} из ${input.limit} обращений за сегодня.`,
    strangerSpent: (input: { limit: number; who: string }) =>
      `Незнакомец исчерпал дневной лимит: ${input.who} — ${input.limit} обращений за сегодня.`,
    userSpent: (limit: number) =>
      `На сегодня ваши ${limit} обращений закончились. Продолжим завтра.`,
  },
  repeat: {
    skipped:
      "Это сообщение повторяет то, что вы прислали меньше минуты назад, и ответ будет в той теме. Чтобы запустить его ещё раз, пришлите его в ту тему.",
  },
  /** What the owner reads at boot. */
  startup: {
    back: "Бот был перезагружен. Я снова на связи.",
    goesTo: (name: string) => `новые разговоры пойдут через ${name}`,
    noAccount: "Ни один рабочий аккаунт не подключён.",
    notConnected: "не подключён",
    notResumed: (count: number) =>
      `Бесед с фоновой работой, которые не удалось продолжить после перезапуска: ${count}. Напишите в них, если работа ещё нужна.`,
    ownerWaits:
      "в личном чате я не отвечу, пока вы не войдёте или не переключитесь командой /provider",
    resumed: (count: number) =>
      `Продолжаю беседы, которые ждали фоновую работу: ${count}.`,
    sendLogin: "Отправьте /login.",
    unchecked: (name: string) => `${name} не ответил при проверке.`,
    wontStart: "не запускается на сервере",
  },
  tiers: {
    executor: "исполнитель",
    guest: "без доступа",
    member: "участник",
    owner: "владелец",
  } satisfies Record<Tier, string>,
  tryAgain: "Не получилось. Попробуйте ещё раз.",
  uploads: {
    albumClosed:
      "Сборка уже закрыта, часть фотографий в неё не попала. Отправьте их ещё раз.",
    fileFailed: "Не удалось сохранить файл. Попробуйте ещё раз.",
    photoFailed: "Не удалось сохранить фотографию. Попробуйте ещё раз.",
    photosFailed: "Не удалось сохранить фотографии. Попробуйте ещё раз.",
    repliedFileFailed:
      "Не удалось получить файл из сообщения, на которое вы ответили. Перешлите файл ещё раз.",
    tooLarge: (maxMb: number) =>
      `Файл слишком большой — принимаю до ${maxMb} МБ.`,
    unreadable: "Здесь я не могу открыть файл. Напишите, что нужно, текстом.",
  },
  /** `/usage`: each provider's subscription windows. */
  usage: {
    limitReached: "⛔ Лимит исчерпан.",
    noLimits: "бот не показывает его лимиты",
    noProviders: "На сервере не установлен ни один агент.",
    noReading: "не удалось узнать лимиты, попробуйте позже",
    noWindows: "Для этого входа лимиты подписки не показываются.",
    privateOnly: "Лимиты подписок показываю только в личном чате со мной.",
    reading: "Смотрю лимиты подписок…",
    resets: (when: string) => `сброс ${when}`,
    /** How long a window is, by its largest whole unit. */
    span: {
      day: (count: number) => (count === 1 ? "Сутки" : `${count} дн.`),
      hour: (count: number) => `${count} ч`,
      minute: (count: number) => `${count} мин`,
      unknown: "Лимит",
      week: (count: number) => (count === 1 ? "Неделя" : `${count} нед.`),
    },
    used: (percent: number) => `${percent}% израсходовано`,
  },
  voice: {
    failed:
      "Не получилось разобрать голосовое сообщение. Попробуйте ещё раз или напишите текстом.",
    transcribing: "Расшифровываю...",
  },
  workspace: {
    groupSet:
      "Теперь это моя рабочая группа. Сюда буду писать по своей инициативе.",
    onlyInGroup: "Эта команда работает в группе.",
    topicSet:
      "Теперь это моя рабочая тема. Сюда буду писать по своей инициативе.",
  },
};
