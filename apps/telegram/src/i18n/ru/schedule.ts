import type { TaskSessionMode, TaskStatus } from "@workspace/db";

/** Recurring tasks and one-off reminders. */
export const schedule = {
  reminders: {
    askNewDue: (id: number) =>
      `Напишите или надиктуйте новый срок для напоминания #${id}.`,
    askWhen: "На когда перенести?",
    back: "Назад",
    buttons: {
      done: "Готово",
      postpone: "Перенести",
    },
    completed: "Выполнено",
    doneToast: "Готово",
    missing: "Такого напоминания нет",
    next: "Дальше",
    noDue: "без срока",
    notification: (id: number) => `Напоминание #${id}`,
    overdue: "просрочено",
    page: {
      empty: "Пока ничего нет.",
      emptyPage: "На этой странице ничего нет.",
      heading: (total: number) => `Напоминания — всего ${total}`,
      pageOf: (input: { page: number; pages: number }) =>
        `Страница ${input.page} из ${input.pages}`,
    },
    postponeFailed: "Не получилось перенести",
    postponed: (due: string) => `Перенесено: ${due}`,
    snooze: {
      day: "На сутки",
      hour1: "+1 час",
      hours4: "+4 часа",
      hours8: "+8 часов",
      min15: "+15 мин",
      min30: "+30 мин",
      other: "Другое",
    },
  },
  tasks: {
    /** How to write a `/task add` form; `separator` splits header from payload. */
    addUsage: (separator: string) => [
      "Новое дело задаётся шапкой и текстом задания:",
      "",
      "<code>/task add",
      "title: Утренняя сводка",
      "cron: 0 9 * * *",
      "tz: Europe/Berlin",
      "type: prompt",
      separator,
      "Расскажи, что пришло на почту за ночь.</code>",
      "",
      "<code>cron</code> — время в формате «минуты часы день месяц день-недели», <code>tz</code> — часовой пояс.",
      "Ещё можно добавить: <code>enabled: false</code> (сразу на паузу), <code>raw: true</code> (присылать ответ без обработки), <code>silent: true</code> (делать молча, писать только об ошибках), <code>project</code>.",
      "Результат приходит в этот чат и тему, если не указано <code>silent: true</code>.",
      "<code>session: own</code> — дело ведёт одну свою беседу и помнит прошлые запуски. <code>session: route</code> — дело пишет в беседу этого чата и темы, как ваше сообщение, и её можно продолжить; если беседа занята, запуск подождёт. С <code>silent: true</code> не сочетается.",
      "Скрипт (<code>type: script</code>) с <code>session</code> — сторож: он работает без модели, видит своё прошлое состояние в <code>taskState</code> и будит модель, только когда вернёт <code>{ state, prompt }</code> с заданием.",
    ],
    buttons: {
      back: "Назад",
      delete: "Удалить",
      model: "Модель",
      pause: "На паузу",
      resetSession: "Начать заново",
      resume: "Включить",
      run: "Запустить",
      session: "Беседа",
      stop: "Остановить",
    },
    commandHint: "/tasks — список дел, /task add — добавить новое.",
    deleted: (id: number) => `#${id} удалено`,
    empty: "Регулярных дел пока нет.",
    /** What is wrong with a `/task add` form, said plainly. */
    form: {
      badSession: "В поле session может быть fresh, own или route.",
      badType: "В поле type может быть prompt или script.",
      badZone: (tz: string) =>
        `Не знаю такой часовой пояс: ${tz}. Нужен вид Europe/Berlin.`,
      missingFields: "Нужны title, cron и tz — все три.",
      neverRuns: (cron: string) =>
        `По такому расписанию дело никогда не начнётся: ${cron}`,
      noPayload: (separator: string) =>
        `Не вижу самого задания: напишите его под строкой ${separator}.`,
      routeNeedsChat:
        "session: route пишет в беседу этого чата, поэтому не сочетается с silent: true.",
    },
    list: {
      lastRun: (input: { date: string; status: string }) =>
        `прошлый раз ${input.status} ${input.date}`,
      /** Which conversation the fires keep. */
      mode: {
        own: "своя беседа",
        route: "в беседе чата",
      } satisfies Record<TaskSessionMode, string>,
      never: "никогда",
      neverRan: "ещё не запускалось",
      next: (when: string) => `дальше ${when}`,
      paused: "на паузе",
      resetPending: "беседа начнётся заново",
      sessionKept: "беседа сохранена",
      /** How a stored status reads in the list. */
      status: {
        error: "с ошибкой",
        ok: "успешно",
        paused: "ждёт подтверждения",
      } satisfies Record<TaskStatus, string>,
    },
    /** The «Модель» screen of one prompt task. */
    pick: {
      follow: "Как в настройках",
      followNow: (provider: string) => `Как в настройках (сейчас ${provider})`,
      hint: "Через кого, на какой модели и с какой глубиной делать это дело. «Как в настройках» — как в «Новых беседах» в /settings у того, кто поставил дело, на момент каждого запуска; выбор здесь действует только на это дело. «Авто» в настройках — подбираю модель по заданию при первом запуске и запоминаю. У скрипта со своей беседой это модель, которую он будит.",
      pickEffort: (provider: string) =>
        `Как глубоко думать в этом деле (сейчас ${provider}):`,
      pickModel: (provider: string) =>
        `Какую модель брать для этого дела (сейчас ${provider}):`,
      pickProvider: "Через кого делать это дело:",
    },
    /** What a fire reports when it did not deliver a result. */
    run: {
      awaitingApproval: (id: string) =>
        `Жду вашего подтверждения (запуск ${id}).`,
      awaitingMcpApproval: (id: string, asks?: string) =>
        `Executor ждёт вашего подтверждения (запрос ${id})${asks === undefined ? "" : `: ${asks}`}. Пришлите мне «подтвердить ${id}» или «отклонить ${id}» в ближайшие 15 минут, и я отвечу на запрос через resume в Executor. Потом запрос истечёт, и скрипт снова запустится только по расписанию или по кнопке «Запустить».`,
      awaitingMcpInput: (id: string, asks?: string) =>
        `Executor ждёт от вас данных (запрос ${id})${asks === undefined ? "" : `: ${asks}`}. Пришлите мне ответ и номер запроса ${id} в ближайшие 15 минут, и я передам его через resume в Executor. Потом запрос истечёт, и скрипт снова запустится только по расписанию или по кнопке «Запустить».`,
      empty: "(пусто)",
      failed: "Не получилось.",
      failedWillRetry: "Не получилось. Попробую в следующий раз.",
      noWaitSlot:
        "Задача запустила фоновую работу, но все места для ожидания заняты, и работа остановилась, не отчитавшись. Запустите её позже.",
      /** Why a fire a restart cut is not continued: see `parkedFor`. */
      notResumed: {
        access:
          "После перезапуска не продолжаю: у того, кто поставил задачу, больше нет полного доступа. Запустится по расписанию.",
        cap: "После перезапуска не продолжаю: задачу уже продолжали слишком много раз подряд. Запустится по расписанию.",
        changed:
          "После перезапуска не продолжаю: задача изменилась. Запустится по расписанию.",
        nothing:
          "После перезапуска не продолжаю: продолжать нечего. Запустится по расписанию.",
        provider: (name: string) =>
          `После перезапуска не продолжаю: задача теперь идёт через ${name}. Запустится по расписанию.`,
        providerDown: (name: string) =>
          `После перезапуска не продолжаю: ${name} сейчас недоступен. Запустится по расписанию.`,
      },
      unknownId: "неизвестно",
      /** `IDLE_CAP_MINUTES` in the agent package: change one, change the other. */
      waitExpired:
        "Задача ждала своего напоминания больше 70 минут и закончилась без отчёта.",
    },
    /** The «Беседа» screen of one task. */
    session: {
      badRoute:
        "Беседа в чате работает только в личном чате с ботом того, кто ставит дело, или в рабочей группе.",
      choices: {
        fresh: "Новая каждый раз",
        own: "Своя",
        route: "В чате",
      } satisfies Record<TaskSessionMode | "fresh", string>,
      gateNotYours:
        "Отдавать ли вывод этого скрипта модели, решает только тот, кто его поставил, или владелец.",
      hint: [
        "Новая каждый раз — каждый запуск с чистого листа.",
        "Своя — дело помнит прошлые запуски в отдельной беседе, которую видит только оно.",
        "В чате — запуск приходит в беседу чата и темы, куда дело присылает результат, как ваше сообщение, и его можно продолжить. Если беседа занята, запуск подождёт и ничего не прервёт.",
        "«Начать заново» в режиме «В чате» очищает беседу самого чата, как /new там (в личном чате и в общей теме — беседу текущего проекта).",
      ].join("\n\n"),
      resetDone: "Беседа начата заново",
      routeNeedsChat: "Дело молчаливое: для беседы в чате ему нужен чат.",
      scriptHint:
        "Для скрипта режим меняет его работу. «Своя» и «В чате» делают его сторожем: его вывод становится заданием для модели, а ответ модели — результатом. Сторож, переключённый на «Новая каждый раз», больше не видит taskState и его вывод приходит как есть: сначала поменяйте сам скрипт.",
      title: "Какую беседу ведёт это дело:",
    },
    title: (count: number) => `Регулярные дела (${count})`,
    toast: {
      alreadyQueued: "Уже ждёт своей очереди",
      deleted: "Удалено",
      missing: "Такого дела нет",
      modeSet: "Готово",
      notRunning: "Сейчас не выполняется",
      paused: "На паузе",
      resumed: "Включено",
      running: "Запускаю",
      runningBound: "Запускаю. Если беседа занята, подожду",
      sessionReset: "Начну заново, когда беседа освободится",
      stopped: "Остановлено",
      waitingBackground:
        "Прошлый запуск ещё ждёт фоновую работу; этот встанет за ним",
    },
    verdictNotice: (title: string) =>
      `Похоже, задача «${title}» не выполнена: судя по отчёту, сделать работу не удалось.`,
  },
};
