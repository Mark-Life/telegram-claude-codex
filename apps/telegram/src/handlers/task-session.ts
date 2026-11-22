import type { TaskEntry, TaskSessionMode } from "@workspace/db";
import { InlineKeyboard } from "grammy";

import { t } from "../i18n";
import { escapeHtml } from "../telegram/format";

/**
 * The «Беседа» screen of one task in `/tasks`: which conversation its fires
 * keep (a new one each time, its own, or its chat's), and «Начать заново»
 * while it keeps one. Callback data is
 * `tasksess:<id>[:<fresh|own|route|reset|back>]`.
 */

export const TASK_SESSION_RE =
  /^tasksess:(?<id>\d+)(?::(?<value>back|fresh|own|route|reset))?$/u;

/** What no mode is called on a button and in the callback. */
const FRESH = "fresh";

const CHOICES = [FRESH, "own", "route"] as const;

/** A mode as the picker names it: `fresh` for none. */
export type SessionChoice = (typeof CHOICES)[number];

/** The mode a choice stores; null clears it back to a fresh session. */
export const storedMode = (choice: SessionChoice): TaskSessionMode | null =>
  choice === FRESH ? null : choice;

/** Narrow a callback's value to a mode choice. */
export const parseSessionChoice = (raw: string | undefined) =>
  CHOICES.find((choice) => choice === raw);

/** The screen: the three modes, the current one marked, a reset and back. */
export const renderTaskSession = (task: TaskEntry) => {
  const current = task.sessionMode ?? FRESH;
  const keyboard = new InlineKeyboard();
  for (const choice of CHOICES) {
    const mark = choice === current ? "✓ " : "";
    keyboard
      .text(
        `${mark}${t().tasks.session.choices[choice]}`,
        `tasksess:${task.id}:${choice}`
      )
      .row();
  }
  if (task.sessionMode !== undefined) {
    keyboard
      .text(t().tasks.buttons.resetSession, `tasksess:${task.id}:reset`)
      .row();
  }
  keyboard.text(t().tasks.buttons.back, `tasksess:${task.id}:back`);
  // A script's mode decides whether it is a gate, so its screen says so.
  const hints = [
    t().tasks.session.hint,
    ...(task.type === "script" ? [t().tasks.session.scriptHint] : []),
  ];
  return {
    keyboard,
    text: `<b>#${task.id} ${escapeHtml(task.title)}</b>\n\n${escapeHtml(t().tasks.session.title)}\n\n${hints.map((hint) => escapeHtml(hint)).join("\n\n")}`,
  };
};
