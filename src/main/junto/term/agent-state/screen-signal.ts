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
import type { SeatRule, SeatRuleSignal } from "./types";

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

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
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

/**
 * When a screen says a limit resets: "in 2h 30m", "3pm", "3:30 PM",
 * "15:00", an ISO time, each optionally after "at" and before a zone in
 * parentheses, which is dropped. A clock time is the next one at or after
 * `now`, in the local zone. Undefined when it does not read as a time.
 */
export const parseResetAt = (text: string, now: number): number | undefined => {
  const body = text
    .trim()
    .replace(/\s*\([^)]*\)\s*[.…]*$/u, "")
    .replace(/[.…]+$/u, "")
    .trim();
  if (/^in\s/iu.test(body)) {
    const ms = parseScreenDuration(body);
    return ms === undefined ? undefined : now + ms;
  }
  if (/^\d{4}-\d{2}-\d{2}/u.test(body)) {
    const at = Date.parse(body);
    return Number.isFinite(at) ? at : undefined;
  }
  const clock = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/iu.exec(body);
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
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() < now) at.setDate(at.getDate() + 1);
  return at.getTime();
};

/** A captured group as the value of the signal field it names. */
const coerce = (field: string, raw: string, now: number): unknown => {
  switch (field) {
    case "resetsAt":
    case "quotaResetsAt":
      return parseResetAt(raw, now);
    case "retryInMs":
      return parseScreenDuration(raw);
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
): HarnessSignal => {
  const template: SeatRuleSignal = rule.signal ?? signalForState(rule.state);
  let signal: Record<string, unknown> = { ...template };
  if (needsMessage(template) && signal.message === undefined) {
    signal.message = oneLine(captures.matched ?? rule.id);
  }
  if (!isHarnessSignal(signal)) return signalForState(rule.state);
  for (const [field, raw] of Object.entries(captures.groups)) {
    if (field === "_tag") continue;
    const value = coerce(field, raw, now);
    if (value === undefined) continue;
    const next = { ...signal, [field]: value };
    if (isHarnessSignal(next)) signal = next;
  }
  return signal as HarnessSignal;
};
