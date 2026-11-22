import type { ModelTier, RoutedEffort } from "@workspace/agent";

import type { Persona } from "../../persona";
import { byGender } from "../ru-grammar";

/** Minutes under an hour read as two digits. */
const TWO_DIGITS = 2;

const HUNDRED = 100;
const TEN = 10;
const FEW_FROM = 2;
const FEW_TO = 4;
const TEENS_FROM = 11;
const TEENS_TO = 14;

/** «1 модель», «3 модели», «389 моделей». */
const models = (count: number) => {
  const tens = count % HUNDRED;
  const ones = count % TEN;
  if (tens >= TEENS_FROM && tens <= TEENS_TO) {
    return `${count} моделей`;
  }
  if (ones === 1) {
    return `${count} модель`;
  }
  return ones >= FEW_FROM && ones <= FEW_TO
    ? `${count} модели`
    : `${count} моделей`;
};

/** A conversation: commands, history, model and effort, plans, drafts, queue. */
export const conversation = {
  agents: {
    /** An elapsed time, `2 мин 10 с`; past an hour, `1 ч 05 мин`. */
    duration: (hours: number, minutes: number, seconds: number) => {
      if (hours > 0) {
        return `${hours} ч ${String(minutes).padStart(TWO_DIGITS, "0")} мин`;
      }
      return minutes > 0 ? `${minutes} мин ${seconds} с` : `${seconds} с`;
    },
    failed: (count: number) => `${count} с ошибкой`,
    more: (count: number) => `и ещё ${count}`,
    progress: (done: number, total: number) => `${done}/${total} готово`,
    stop: "⏹ Остановить",
    stopped: (count: number) => `${count} остановлено`,
    title: "Субагенты",
    tokens: (count: string) => `${count} токенов`,
    wave: (index: number, count: number) => `волна ${index} из ${count}`,
    waves: (from: number, to: number) => `Волны ${from}–${to}`,
    workflow: (name: string) => `Воркфлоу «${name}»`,
  },
  compose: {
    already: (count: number) =>
      `Уже собираю (${count}). /send — когда закончите.`,
    cancelled: (count: number) => `Отменено. Сообщений стёрто: ${count}.`,
    collecting: (count: number) => `Собираю сообщения (${count})`,
    full: (max: number) =>
      `Больше ${max} сообщений за раз собрать не смогу. /send — отправить, /cancel — стереть.`,
    idle: "Сейчас я ничего не собираю.",
    notAccepted: "Это сообщение принять не получилось. Попробуйте ещё раз.",
    nothingToSend: "Отправлять было нечего. Отменено.",
    privateOnly: "Собирать сообщения можно только в личном чате со мной.",
    send: "Отправить",
    started: "Собираю сообщения. Пишите, а когда закончите — /send.",
  },
  history: {
    ago: {
      days: (count: number) => `${count} дн назад`,
      hours: (count: number) => `${count} ч назад`,
      minutes: (count: number) => `${count} мин назад`,
      now: "только что",
    },
    back: "<< Назад",
    conversations: "<< Разговоры",
    empty: "Прошлых разговоров пока нет.",
    next: "Вперёд >>",
    noTopic: "(без темы)",
    notFound: "Ничего не нашлось",
    ownerSwitches: (name: string) =>
      `Этот разговор шёл через ${name}. Переключить меня на ${name} может только владелец.`,
    resumed: ({ gender }: Persona) =>
      `${byGender(gender, "Вернулась", "Вернулся")} к этому разговору. Следующее сообщение продолжит его.`,
    resumedOn: ({ gender }: Persona, name: string) =>
      `${byGender(gender, "Вернулась", "Вернулся")} к этому разговору. Дальше отвечаю через ${name}, следующее сообщение продолжит его.`,
    resuming: "Возвращаюсь к разговору",
    tasks: "Задачи",
    tasksTitle: "Запуски задач",
    title: "Прошлые разговоры",
  },
  model: {
    auto: "Авто",
    default: "Как в /settings",
    effortHeader: "Насколько тщательно думать в этой беседе:",
    effortSet: (label: string) =>
      `Глубина размышлений: ${label}. Применю со следующего сообщения в этой беседе.`,
    effortToast: (label: string) => `Глубина: ${label}`,
    /** The router's efforts; the ids stay as they are. */
    efforts: {
      high: "Высокая",
      low: "Низкая",
      medium: "Средняя",
      xhigh: "Максимальная",
    } satisfies Record<RoutedEffort, string>,
    modelHeader: "Какой моделью пользоваться в этой беседе:",
    modelSet: (label: string) =>
      `Модель: ${label}. Применю со следующего сообщения в этой беседе.`,
    modelToast: (label: string) => `Модель: ${label}`,
    /** `/effort` on a model with no thinking setting. */
    noEffort: "Для этой модели глубину размышлений не настроить.",
    noSuchModel: "Такой модели нет",
    /** pi: models by hand, from a list too long for buttons. */
    pi: {
      all: (count: number) => `Все модели (${count})`,
      /** The «Все модели» message; ids and commands are HTML already. */
      allHeader: (count: number) =>
        `Модели pi — ${models(count)}. Нажмите на название, чтобы скопировать, и пришлите /model с ним.`,
      bigProvider: (provider: string, count: number, search: string) =>
        `${provider} — ${models(count)}. Найти: ${search}`,
      byDefault: (model: string) => `По умолчанию (${model})`,
      found: (query: string) => `Модели по запросу «${query}»:`,
      /** A stored pick the list in hand lacks, as its row reads. */
      gone: (model: string) => `${model} (сейчас недоступна)`,
      goneToast: "Этой модели сейчас нет в списке, выберите другую",
      loading:
        "Список моделей pi ещё загружается. Откройте выбор через несколько секунд.",
      manual: "Для pi модель выбирается вручную.",
      more: (count: number) => `…и ещё ${count}, уточните запрос.`,
      /** The list arrived, but no model on it has a key light runs get. */
      noLight:
        "Ни одна модель pi не подходит для групп, гостей и служебных проходов: ни у одной нет ключа, который им доступен. Положите ключ в auth.json или models.json папки pi.",
      noList:
        "Список моделей pi ещё загружается или сейчас недоступен. Попробуйте через несколько секунд.",
      none: (query: string) =>
        `По запросу «${query}» моделей нет. Весь список — кнопка «Все модели» в /model.`,
      pickerHint:
        "Другую модель выберите в беседе: /model и часть названия. Она появится здесь среди недавних.",
      stale: "Список моделей обновился, откройте /model заново",
      staleSettings: "Список моделей обновился, откройте выбор заново",
    },
    /** A press on the old switch row of `/model`, now a `/settings` default. */
    routingMoved:
      "Автовыбор модели теперь в /settings, в разделе «Новые беседы».",
    /** What each tier is good for, on every provider's menu. */
    tierHints: {
      astra: "лучше всех пишет",
      luna: "быстрая",
      sol: "код и сложные задачи",
      terra: "золотая середина",
    } satisfies Record<ModelTier, string>,
  },
  plan: {
    askEdits: "Напишите, что поправить в плане — следующим сообщением.",
    awaitingEdits: "Жду ваши правки",
    modify: "Доработать план",
    none: "Плана сейчас нет",
    ready: "План готов. Что делаем?",
    runFresh: "Выполнить с чистого листа",
    runResume: "Выполнить, помня разговор",
    runningFresh: "Выполняю план с чистого листа...",
    runningResume: "Выполняю план, помню разговор...",
    runningToast: "Выполняю план",
    unreadable: "Не получилось прочитать план.",
  },
  session: {
    compact: {
      context: (before: string, after: string) =>
        `Контекст: ${before} → ${after} токенов.`,
      done: "Готово, итог подведён — просто напишите следующее сообщение.",
      failed: "Не получилось подвести итог. Разговор продолжается как был.",
      nothing: "Пока подводить нечего — сначала напишите мне.",
      stoppedFirst: "Текущая работа остановлена.",
      unsupported:
        "Подвести итог не получится. Начните новый разговор командой /new.",
      working: "Подвожу итог разговора...",
    },
    /** `/context`: how full the conversation's context window is. */
    context: {
      buttonCompact: "Подвести итог",
      buttonNew: "Начать заново",
      compactAt: (tokens: string) =>
        `Автоматически подведу итог, когда наберётся около ${tokens} токенов.`,
      compacting: "Сейчас подвожу итог разговора, после него цифра изменится.",
      free: "Освободить место: /compact или /new.",
      live: "Цифра обновляется по ходу текущей работы.",
      modelWindow: (window: string, model: string) =>
        `Считаю от окна, в котором подвожу итог: ${window} (у модели ${model}).`,
      noFigure:
        "Сколько занято, станет видно после следующего ответа в этом разговоре.",
      noFigureRunning:
        "Сколько занято, станет видно, как только текущая работа отправит первый запрос.",
      noSession: "В этом разговоре пока ничего нет — сначала напишите мне.",
      notKept:
        "Здесь каждое сообщение начинает разговор заново, поэтому показывать нечего.",
      title: (provider: string, model: string | undefined) =>
        model === undefined
          ? `<b>Контекст</b> · ${provider}`
          : `<b>Контекст</b> · ${provider} · ${model}`,
      tokens: (used: string, window: string) => `${used} из ${window} токенов`,
      tokensOnly: (used: string) =>
        `${used} токенов; размер окна станет известен после ответа.`,
      used: (percent: number) => `${percent}% занято`,
    },
    /** The command reference, trimmed the same way the command menu is. */
    help: (operator: boolean) => [
      "<b>Как со мной работать</b>",
      "",
      "Просто напишите, что нужно. Можно наговорить голосом, прислать файл или фото — я всё прочитаю и сделаю.",
      "",
      "<b>Команды</b>",
      ...(operator
        ? [
            "/new — начать разговор с чистого листа",
            "/history — вернуться к одному из прошлых разговоров",
          ]
        : []),
      "/stop — остановить текущую работу",
      ...(operator
        ? ["/compact — подвести итог разговора и продолжить с краткой выжимкой"]
        : []),
      "/context — сколько памяти разговора уже занято",
      "/compose — собрать несколько сообщений и отправить их одним",
      "/send — отправить собранное",
      "/cancel — не отправлять, всё стереть",
      ...(operator
        ? [
            "/model — какой моделью пользоваться",
            "/effort — насколько тщательно думать над ответом",
            "/settings — на чём начинать новые беседы",
            "/reminders — все напоминания",
            "/tasks — дела, которые я делаю по расписанию",
            "/task add — добавить новое дело по расписанию",
            "/apikeys — ключи, чтобы программы обращались ко мне по HTTP",
          ]
        : []),
      "/help — это сообщение",
      "",
      "Если что-то не получится, я скажу об этом простыми словами — можно спокойно попробовать ещё раз.",
    ],
    /** `/new` whose default provider cannot run now. */
    newDefaultDown: (name: string) =>
      `Начинаем заново. ${name} сейчас недоступен, поэтому продолжаю как было. Следующее сообщение — новый разговор.`,
    /** An executor's `/new` in the private chat they share with the owner. */
    newShared:
      "Начинаем заново. В личке без тем я отвечаю как обычно, а выбор «Через кого» из /settings работает в ваших темах в личке. Следующее сообщение — новый разговор.",
    newStarted: "Начинаем заново. Следующее сообщение — новый разговор.",
    /** `/new` that also moved the conversation onto the caller's default. */
    newStartedOn: (name: string) =>
      `Начинаем заново, теперь через ${name}. Следующее сообщение — новый разговор.`,
    start: {
      groupId: (chatId: number) =>
        `<i>ID этой группы: <code>${chatId}</code></i>`,
      guestId: (userId: number) =>
        `<i>Если вы считаете, что вам нужен доступ к этому боту, отправьте владельцу бота ваш уникальный Telegram ID: <code>${userId}</code></i>`,
      /** The greeting, listing only the commands this tier may actually use. */
      lines: (operator: boolean) => [
        "Привет! Я на связи.",
        "",
        "Пишите обычными словами, что нужно сделать — я разберусь. Голосовые сообщения тоже понимаю, файлы и фото можно просто прислать в чат.",
        "",
        "Самое нужное:",
        ...(operator
          ? [
              "/new — начать разговор заново",
              "/history — вернуться к прошлому разговору",
            ]
          : []),
        "/stop — остановить текущую работу",
        "/help — что я ещё умею",
      ],
      userId: (userId: number) =>
        `<i>Ваш уникальный Telegram ID: <code>${userId}</code></i>`,
    },
    stop: {
      idle: "Сейчас я ничего не делаю.",
      queueCleared: "Очередь очищена.",
      stopped: "Остановлено.",
    },
  },
  status: {
    backgroundExpired:
      "Ожидание фоновой работы остановлено: вышел лимит времени. Напишите, если нужно продолжить.",
    backgroundFull:
      "Сейчас слишком много бесед ждут фоновую работу, поэтому эта свою ждать не будет: то, что не закончится за 10 минут, остановится, а отложенные проверки пропадут.",
    clearQueue: "Очистить очередь",
    forceSend: "Взять сейчас — прерву текущее",
    idle: "Сейчас я ничего не делаю",
    moreQueued: (count: number) => `(ещё ${count} в очереди)`,
    queueCleared: (count: number) => `Очередь очищена (${count}).`,
    queueEmpty: "Очередь пуста.",
    queued: (count: number) => `Сообщение в очереди (всего ${count})`,
    restartCut:
      "Бот перезапускается, и фоновая работа этой беседы остановилась. После запуска попробую её продолжить.",
    restartNotResumed:
      "После перезапуска фоновую работу этой беседы продолжить не получилось. Напишите, если она ещё нужна.",
    steered: "Учту это в текущей задаче.",
    stopping: "Останавливаю...",
    takingNext: "Беру следующее сообщение",
  },
};
