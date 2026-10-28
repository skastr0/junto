/**
 * The values an action's text may name of what fired it, written
 * `{{task.title}}` (plan 0.11/05).
 *
 * Stand-in for A2 (automation-lead): the names are exactly the contract's,
 * stated here so the editor can offer them before the contract lands in
 * `@shared/automation`. When it does, delete this file and read
 * `AutomationValue` and `automationValuesOf` from there.
 *
 * A name is `word.word`, no spaces; anything else in braces is plain text. A
 * change trigger carries the set of what it watches, and `fired.at` every
 * trigger, schedules and polls included.
 */

/** What a change trigger may watch. A schedule or poll watches nothing. */
export type WatchedThing = "seat" | "task" | "artifact" | "signal";

export const AUTOMATION_VALUES = {
  task: ["task.title", "task.state", "task.link", "task.assignee", "board.title"],
  artifact: ["artifact.title", "artifact.link", "artifacts.title"],
  seat: ["seat.name", "seat.state"],
  signal: ["signal.kind", "signal.from", "signal.text"],
  every: ["fired.at"],
} as const;

export type AutomationValue = (typeof AUTOMATION_VALUES)[keyof typeof AUTOMATION_VALUES][number];

/** The values a trigger carries, in the order the Insert value list shows them. */
export const valuesOf = (watched: WatchedThing | undefined): ReadonlyArray<AutomationValue> =>
  watched === undefined ? [...AUTOMATION_VALUES.every] : [...AUTOMATION_VALUES[watched], ...AUTOMATION_VALUES.every];

/**
 * False until A2's contract is in: main stores `{{name}}` as typed text and
 * refuses a prompt action, so the editor refuses both in words rather than let
 * either reach a firing that writes braces. Delete with this file.
 */
export const CONTRACT_CARRIES_VALUES = false;

const VALUE_TOKEN = /\{\{[a-z]+\.[a-z]+\}\}/;

/** Whether a text names a value at all. */
export const namesAValue = (text: string): boolean => VALUE_TOKEN.test(text);
