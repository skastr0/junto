/**
 * When a thread or a message in it was written, as every thread list and
 * every message says it. The hour alone made last week's thread read like
 * today's; the form now tells the day:
 *
 *   today                       14:05
 *   yesterday                   Yesterday            Yesterday 14:05
 *   the five days before that   Tue                  Tue 14:05
 *   older                       12 Nov               12 Nov 14:05
 *   another year                12 Nov 2025          12 Nov 2025 14:05
 *
 * The first column is a list row's, the second a message's, where there is
 * room and the hour matters. The hover is the whole of it everywhere:
 * "Tuesday 17 November 2026, 14:05". A screen reader hears the whole on a
 * message, and in a list row, where the time is part of the row's name, the
 * drawn form in words with its hour: "Today, 14:05", "Yesterday, 14:05",
 * "Tuesday, 14:05", "12 November, 14:05", "12 November 2025". 24 hour, on
 * this machine's clock.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";

const DAY_MS = 86_400_000;

/** The first instant of the day `ms` falls in, on this machine's clock. */
const dayStart = (ms: number): number => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const WEEKDAY_WHOLE = new Intl.DateTimeFormat("en-GB", { weekday: "long" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short" });
const MONTH_WHOLE = new Intl.DateTimeFormat("en-GB", { month: "long" });

export type ThreadWhen = {
  /** A list row's: as short as tells the day. */
  readonly row: string;
  /** A message's: the day, and the hour with it. */
  readonly message: string;
  /** A list row's, as a screen reader hears it: the row form in words, with the hour. */
  readonly rowSaid: string;
  /** The whole of it, for the hover, and for a screen reader on a message. */
  readonly whole: string;
  /** For a `time` element's `dateTime`. */
  readonly iso: string;
};

/** How `at` reads on the day `now` falls in. */
export const threadWhen = (at: number, now: number): ThreadWhen => {
  const date = new Date(at);
  const hour = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  // Whole days back, by the calendar: rounding takes up the hour a clock change adds or drops.
  const back = Math.round((dayStart(now) - dayStart(at)) / DAY_MS);
  const whole = `${WEEKDAY_WHOLE.format(date)} ${date.getDate()} ${MONTH_WHOLE.format(date)} ${date.getFullYear()}, ${hour}`;
  const iso = date.toISOString();
  // A little ahead is another machine's clock, not tomorrow: it reads as today.
  if (back <= 0) return { row: hour, message: hour, rowSaid: `Today, ${hour}`, whole, iso };
  if (back === 1) return { row: "Yesterday", message: `Yesterday ${hour}`, rowSaid: `Yesterday, ${hour}`, whole, iso };
  if (back < 7) {
    const day = WEEKDAY.format(date);
    return { row: day, message: `${day} ${hour}`, rowSaid: `${WEEKDAY_WHOLE.format(date)}, ${hour}`, whole, iso };
  }
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  const day = thisYear ? `${date.getDate()} ${MONTH.format(date)}` : `${date.getDate()} ${MONTH.format(date)} ${date.getFullYear()}`;
  const dayWhole = `${date.getDate()} ${MONTH_WHOLE.format(date)}`;
  // Another year: the year tells it, and the hour is left to the hover.
  const rowSaid = thisYear ? `${dayWhole}, ${hour}` : `${dayWhole} ${date.getFullYear()}`;
  return { row: day, message: `${day} ${hour}`, rowSaid, whole, iso };
};

// ---- Today ----

// The day the forms are told from. It turns at midnight while anything shows a
// thread time, so a list left open says "Yesterday" at the change of day, not
// at its next read.
const today$ = observable(dayStart(Date.now()));
let watchers = 0;
let turn: ReturnType<typeof setTimeout> | undefined;
let pinned = false;

const arm = (): void => {
  if (pinned || turn !== undefined) return;
  const now = Date.now();
  today$.set(dayStart(now));
  const date = new Date(now);
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  turn = setTimeout(() => {
    turn = undefined;
    if (watchers > 0) arm();
  }, midnight - now + 250);
};

const watchToday = (): (() => void) => {
  watchers += 1;
  arm();
  return () => {
    watchers -= 1;
    if (watchers > 0 || turn === undefined) return;
    clearTimeout(turn);
    turn = undefined;
  };
};

/** The start of today, and a new render when the day turns. */
export const useThreadToday = (): number => {
  const today = use$(today$);
  useEffect(watchToday, []);
  return today;
};

/** For tests: hold "now" at this instant, or let the clock have it back with no argument. */
export const pinThreadToday = (now?: number): void => {
  pinned = now !== undefined;
  if (turn !== undefined) clearTimeout(turn);
  turn = undefined;
  today$.set(dayStart(now ?? Date.now()));
  if (!pinned && watchers > 0) arm();
};
