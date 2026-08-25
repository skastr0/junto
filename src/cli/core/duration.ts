import type {
  TasksCreateArgs,
  TasksCreateCliArgs,
  TasksUpdateArgs,
  TasksUpdateCliArgs,
} from "@shared/work-control";

// Hold durations as an operator speaks them. The wire carries milliseconds
// only; this is the CLI-side surface so a seat never has to compute
// 7 * 24 * 60 * 60 * 1000 by hand.

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export type HoldForParse =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly message: string };

const rejection = (received: unknown): HoldForParse => ({
  ok: false,
  message:
    `holdFor must be milliseconds or a duration like "90m", "12h", "7d" (received ${JSON.stringify(received)})`,
});

/**
 * Parse one hold duration. A bare number is milliseconds; a string is a
 * positive integer followed by a unit. Compound spellings ("1d12h") are not
 * accepted — one unit keeps the value unambiguous when it is echoed back.
 */
export const parseHoldFor = (value: string | number): HoldForParse => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return rejection(value);
    return { ok: true, ms: Math.round(value) };
  }
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(trimmed);
  if (match === null) return rejection(value);
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return rejection(value);
  const unit = match[2] ?? "ms";
  return { ok: true, ms: Math.round(amount * UNIT_MS[unit]!) };
};

export type TasksUpdateWireResult =
  | { readonly ok: true; readonly args: TasksUpdateArgs }
  | { readonly ok: false; readonly message: string };

/** Lower one CLI update item onto the wire shape. */
export const toTasksUpdateArgs = (
  item: TasksUpdateCliArgs,
): TasksUpdateWireResult => {
  const { holdFor, ...rest } = item;
  if (holdFor === undefined) return { ok: true, args: rest };
  const parsed = parseHoldFor(holdFor);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, args: { ...rest, holdForMs: parsed.ms } };
};

export type TasksCreateWireResult =
  | { readonly ok: true; readonly args: TasksCreateArgs }
  | { readonly ok: false; readonly message: string };

/** Lower one CLI create item onto the wire shape. */
export const toTasksCreateArgs = (
  item: TasksCreateCliArgs,
): TasksCreateWireResult => {
  const { holdFor, ...rest } = item;
  if (holdFor === undefined) return { ok: true, args: rest };
  const parsed = parseHoldFor(holdFor);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, args: { ...rest, holdForMs: parsed.ms } };
};
