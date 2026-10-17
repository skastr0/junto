/**
 * The screen channel's signals: what a matched rule means in the seat signal
 * vocabulary (`shared/harness-domain`).
 *
 * A rule names its signal and constant fields; named groups in its patterns
 * fill the rest. A rule without a signal emits the one its state stands for,
 * so every pack speaks the vocabulary before any of it is typed. A rule's
 * signal must project back to the state it declares (projection.ts), which
 * is what keeps the five-value seat state unchanged while it is derived.
 */

import type { AgentSeatState } from "../../../../shared/agent-seat-state";
import { HarnessSignal } from "../../../../shared/harness-domain";
import { Schema } from "effect";
import type { RuleCaptures } from "./match";
import type { SeatFactRule, SeatRule, SeatRuleSignal } from "./types";

const isHarnessSignal = Schema.is(HarnessSignal);

/** A message read off the screen is one line, and bounded. */
const MESSAGE_MAX = 240;

/**
 * The signal a state stands for when a rule says nothing more. Attention
 * without a type is a dialog of unknown kind: it blocks on the operator,
 * which is what attention has always meant.
 */
export const signalForState = (state: AgentSeatState): HarnessSignal => {
  switch (state) {
    case "idle":
      return { _tag: "ActivityObserved", activity: "idle" };
    case "working":
      return { _tag: "ActivityObserved", activity: "working" };
    case "unknown":
      return { _tag: "ActivityObserved", activity: "unknown" };
    case "attention":
      return { _tag: "DialogShown", kind: "unknown" };
    case "gone":
      return { _tag: "ProcessExited" };
  }
};

/**
 * A screen message as Junto shows it: one line, bounded, and with a
 * harness's middle-dot separators read as commas (the copy law).
 */
const oneLine = (text: string): string => {
  const flat = text
    .replace(/\s*\u00B7\s*/gu, ", ")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX - 1)}…` : flat;
};

/** "1,234", "12k", "1.5M", "42%", "$0.31": the number, or undefined. */
export const parseScreenNumber = (text: string): number | undefined => {
  const match = /^\s*\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([kKmM])?\s*%?\s*$/u.exec(text);
  if (!match) return undefined;
  const base = Number(match[1]!.replace(/,/gu, ""));
  if (!Number.isFinite(base)) return undefined;
  const scale = match[2] === undefined ? 1 : match[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
  return base * scale;
};

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/** "5s", "1m 30s", "2 hours 5 minutes", "250ms": milliseconds, or undefined. */
export const parseScreenDuration = (text: string): number | undefined => {
  const body = text.trim().replace(/^in\s+/iu, "").replace(/[.…]+$/u, "").trim();
  if (body.length === 0) return undefined;
  const part = /(\d+(?:\.\d+)?)\s*([a-z]+)/giu;
  let total = 0;
  let consumed = "";
  for (const hit of body.matchAll(part)) {
    const unit = UNIT_MS[hit[2]!.toLowerCase()];
    if (unit === undefined) return undefined;
    total += Number(hit[1]) * unit;
    consumed += hit[0];
  }
  if (consumed.length === 0) return undefined;
  if (body.replace(/[\s,]|and/giu, "").length !== consumed.replace(/\s/gu, "").length) return undefined;
  return Math.round(total);
};

const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** The zone's offset from UTC at `at`, in ms; undefined for a zone this runtime does not know. */
const zoneOffsetMs = (zone: string, at: number): number | undefined => {
  if (/^(?:utc|gmt|z)$/iu.test(zone)) return 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(at));
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return wall - Math.floor(at / 1000) * 1000;
  } catch {
    return undefined;
  }
};

/**
 * Wall-clock fields in a zone (local when `zone` is undefined) as epoch ms.
 * Undefined when the zone is named but unknown: a time in an unknown zone is
 * not a time Junto can act on.
 */
const wallTime = (
  zone: string | undefined,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | undefined => {
  if (zone === undefined) return new Date(year, month, day, hour, minute, 0, 0).getTime();
  const guess = Date.UTC(year, month, day, hour, minute);
  const offset = zoneOffsetMs(zone, guess);
  if (offset === undefined) return undefined;
  // One correction covers a guess that landed across a zone transition.
  const first = guess - offset;
  const settled = zoneOffsetMs(zone, first);
  return settled === undefined ? undefined : guess - settled;
};

/** "3pm", "3:30 PM", "15:00": 24-hour hour and minute, or undefined. */
const readClock = (text: string): { readonly hour: number; readonly minute: number } | undefined => {
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/iu.exec(text.trim());
  if (!clock) return undefined;
  let hour = Number(clock[1]);
  const minute = clock[2] === undefined ? 0 : Number(clock[2]);
  const meridiem = clock[3]?.toLowerCase().replace(/\./gu, "");
  if (meridiem === undefined && clock[2] === undefined) return undefined;
  if (minute > 59) return undefined;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return undefined;
  }
  return { hour, minute };
};

/**
 * When a screen says a limit resets: "in 2h 30m", "3pm", "3:30 PM",
 * "15:00", "Oct 21 at 6:23am", "Oct 21st, 2026 6:25 AM", an ISO time. A zone
 * in parentheses after it ("(UTC)", "(Europe/Lisbon)") is the zone the time
 * is in; without one the time is local. A time without a date is the next
 * one at or after `now`, and a date without a year the next one too.
 * Undefined when it does not read as a time.
 */
export const parseResetAt = (text: string, now: number): number | undefined => {
  let body = text.trim().replace(/[.…]+$/u, "").trim();
  let zone: string | undefined;
  const zoned = /\s*\(([^)]*)\)$/u.exec(body);
  if (zoned) {
    zone = zoned[1]!.trim();
    body = body.slice(0, zoned.index).trim();
  }
  if (/^in\s/iu.test(body)) {
    const ms = parseScreenDuration(body);
    return ms === undefined ? undefined : now + ms;
  }
  if (/^\d{4}-\d{2}-\d{2}/u.test(body)) {
    const at = Date.parse(body);
    return Number.isFinite(at) ? at : undefined;
  }
  body = body.replace(/^at\s+/iu, "");
  const dated = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?\s+(?:at\s+)?(.+)$/iu.exec(body);
  if (dated) {
    const month = MONTH_INDEX[dated[1]!.toLowerCase()];
    const clock = readClock(dated[4]!);
    if (month === undefined || clock === undefined) return undefined;
    const day = Number(dated[2]);
    if (day < 1 || day > 31) return undefined;
    const year = dated[3] === undefined ? new Date(now).getFullYear() : Number(dated[3]);
    const at = wallTime(zone, year, month, day, clock.hour, clock.minute);
    if (at === undefined || dated[3] !== undefined || at >= now) return at;
    return wallTime(zone, year + 1, month, day, clock.hour, clock.minute);
  }
  const clock = readClock(body);
  if (clock === undefined) return undefined;
  if (zone === undefined) {
    const at = new Date(now);
    at.setHours(clock.hour, clock.minute, 0, 0);
    if (at.getTime() < now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  // The zone's date today, then that clock time on it, rolled to tomorrow if past.
  const offset = zoneOffsetMs(zone, now);
  if (offset === undefined) return undefined;
  const there = new Date(now + offset);
  for (const add of [0, 1]) {
    const at = wallTime(zone, there.getUTCFullYear(), there.getUTCMonth(), there.getUTCDate() + add, clock.hour, clock.minute);
    if (at === undefined) return undefined;
    if (at >= now) return at;
  }
  return undefined;
};

/** What a retry line says the failure was, in the Retrying vocabulary. */
export const retryCause = (text: string): "rate" | "overloaded" | "network" | "server" | "unknown" => {
  if (/overload|\b529\b/iu.test(text)) return "overloaded";
  if (/rate.?limit|\b429\b|too many requests/iu.test(text)) return "rate";
  if (/connection|econn|network|socket|timed?.?out|dns|enotfound|epipe/iu.test(text)) return "network";
  if (/\b50[0-4]\b|server error|internal error/iu.test(text)) return "server";
  return "unknown";
};

/** A captured group as the value of the signal field it names. */
const coerce = (field: string, raw: string, now: number): unknown => {
  switch (field) {
    case "resetsAt":
    case "quotaResetsAt":
      return parseResetAt(raw, now);
    case "retryInMs":
      return parseScreenDuration(raw);
    case "cause":
      return retryCause(raw);
    case "attempt":
    case "max":
    case "contextTokens":
    case "contextWindow":
    case "tokensBefore":
    case "tokensAfter":
    case "code": {
      const n = parseScreenNumber(raw);
      return n === undefined ? undefined : Math.round(n);
    }
    case "contextPct":
    case "quotaPct":
    case "costUsd":
      return parseScreenNumber(raw);
    case "message":
    case "detail":
    case "text":
      return oneLine(raw);
    default:
      return raw.trim();
  }
};

const needsMessage = (template: SeatRuleSignal): boolean =>
  template._tag === "UsageLimitHit" || template._tag === "ErrorRaised";

/**
 * The signal a matched rule emits. The rule's constant fields come first;
 * when the signal carries a message and none is given, the text the rule
 * matched is the message. Each capture is then kept only when the signal
 * still reads with it, so one bad capture costs its own field, never the
 * signal. A template that does not read at all (a pack bug the pack tests
 * catch) falls back to the signal of the rule's state.
 */
export const ruleSignal = (
  rule: SeatRule,
  captures: RuleCaptures,
  now: number,
): HarnessSignal =>
  fillSignal(rule.signal ?? signalForState(rule.state), rule.id, captures, now) ??
  signalForState(rule.state);

/** A fact rule's signal; null when its template does not read (a pack bug the pack tests catch). */
export const factSignal = (
  rule: SeatFactRule,
  captures: RuleCaptures,
  now: number,
): HarnessSignal | null => fillSignal(rule.signal, rule.id, captures, now);

const fillSignal = (
  template: SeatRuleSignal,
  id: string,
  captures: RuleCaptures,
  now: number,
): HarnessSignal | null => {
  let signal: Record<string, unknown> = { ...template };
  if (needsMessage(template) && signal.message === undefined) {
    signal.message = oneLine(captures.matched ?? id);
  }
  if (!isHarnessSignal(signal)) return null;
  for (const [field, raw] of Object.entries(captures.groups)) {
    if (field === "_tag") continue;
    const value = coerce(field, raw, now);
    if (value === undefined) continue;
    const next = { ...signal, [field]: value };
    if (isHarnessSignal(next)) signal = next;
  }
  return signal as HarnessSignal;
};
