/**
 * 5-field cron (minute hour day-of-month month day-of-week).
 * Standard: DOW 0=Sunday … 6=Saturday (7 also Sunday).
 * Pure — no deps. Used for authorial cron nodes + next-fire projection.
 */

export type CronField =
  | { readonly kind: "any" }
  | { readonly kind: "list"; readonly values: ReadonlyArray<number> }
  | { readonly kind: "step"; readonly start: number; readonly step: number; readonly max: number };

export type CronExpression = {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
  /** Canonical 5-token source. */
  readonly source: string;
};

const FIELD_BOUNDS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
} as const;

type FieldName = keyof typeof FIELD_BOUNDS;

const parsePart = (
  token: string,
  name: FieldName,
): CronField | { readonly error: string } => {
  const { min, max } = FIELD_BOUNDS[name];
  const t = token.trim();
  if (t === "*") return { kind: "any" };

  if (t.includes("/")) {
    const [base, stepRaw] = t.split("/");
    const step = Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) {
      return { error: `${name}: invalid step` };
    }
    if (base === "*") return { kind: "step", start: min, step, max };
    const start = Number(base);
    if (!Number.isInteger(start) || start < min || start > max) {
      return { error: `${name}: invalid step start` };
    }
    return { kind: "step", start, step, max };
  }

  const values = new Set<number>();
  for (const chunk of t.split(",")) {
    if (chunk.includes("-")) {
      const [aRaw, bRaw] = chunk.split("-");
      const a = Number(aRaw);
      const b = Number(bRaw);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) {
        return { error: `${name}: invalid range` };
      }
      for (let v = a; v <= b; v += 1) {
        if (v < min || v > max) return { error: `${name}: out of range` };
        values.add(name === "dayOfWeek" && v === 7 ? 0 : v);
      }
    } else {
      const v = Number(chunk);
      if (!Number.isInteger(v) || v < min || v > max) {
        return { error: `${name}: out of range` };
      }
      values.add(name === "dayOfWeek" && v === 7 ? 0 : v);
    }
  }
  if (values.size === 0) return { error: `${name}: empty` };
  return { kind: "list", values: [...values].sort((a, b) => a - b) };
};

/** Parse standard 5-field cron. Returns error string on failure. */
export const parseCronExpression = (
  raw: string,
): CronExpression | { readonly error: string } => {
  const source = raw.trim().replace(/\s+/g, " ");
  const parts = source.split(" ");
  if (parts.length !== 5) {
    return { error: "expected 5 fields: minute hour day month weekday" };
  }
  const names = [
    "minute",
    "hour",
    "dayOfMonth",
    "month",
    "dayOfWeek",
  ] as const;
  const fields: CronField[] = [];
  for (let i = 0; i < 5; i += 1) {
    const parsed = parsePart(parts[i]!, names[i]!);
    if ("error" in parsed) return parsed;
    fields.push(parsed);
  }
  return {
    minute: fields[0]!,
    hour: fields[1]!,
    dayOfMonth: fields[2]!,
    month: fields[3]!,
    dayOfWeek: fields[4]!,
    source,
  };
};

export const isValidCronExpression = (raw: string): boolean =>
  !("error" in parseCronExpression(raw));

const matchesField = (field: CronField, value: number): boolean => {
  switch (field.kind) {
    case "any":
      return true;
    case "list":
      return field.values.includes(value);
    case "step": {
      if (value < field.start || value > field.max) return false;
      return (value - field.start) % field.step === 0;
    }
    default:
      return false;
  }
};

type WallTime = {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
};

const localWall = (date: Date): WallTime => ({
  minute: date.getMinutes(),
  hour: date.getHours(),
  dayOfMonth: date.getDate(),
  month: date.getMonth() + 1,
  dayOfWeek: date.getDay(), // 0=Sun
});

const utcWall = (date: Date): WallTime => ({
  minute: date.getUTCMinutes(),
  hour: date.getUTCHours(),
  dayOfMonth: date.getUTCDate(),
  month: date.getUTCMonth() + 1,
  dayOfWeek: date.getUTCDay(),
});

const matchesWall = (expr: CronExpression, wall: WallTime): boolean => {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = wall;

  if (!matchesField(expr.minute, minute)) return false;
  if (!matchesField(expr.hour, hour)) return false;
  if (!matchesField(expr.month, month)) return false;

  const domAny = expr.dayOfMonth.kind === "any";
  const dowAny = expr.dayOfWeek.kind === "any";
  if (domAny && dowAny) return true;
  if (!domAny && !dowAny) {
    // Standard: match if EITHER dom or dow matches when both restricted.
    return (
      matchesField(expr.dayOfMonth, dayOfMonth) ||
      matchesField(expr.dayOfWeek, dayOfWeek)
    );
  }
  if (!domAny) return matchesField(expr.dayOfMonth, dayOfMonth);
  return matchesField(expr.dayOfWeek, dayOfWeek);
};

/**
 * Next fire strictly after `afterEpochMs` in local wall time.
 * Caps search at ~2 years (minute steps would be huge — step by 1 minute).
 */
export const nextCronOccurrence = (
  raw: string,
  afterEpochMs: number,
): number | undefined => {
  const parsed = parseCronExpression(raw);
  if ("error" in parsed) return undefined;
  // Start at the next whole minute after `after`.
  const start = new Date(afterEpochMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = start.getTime() + 366 * 2 * 24 * 60 * 60_000;
  for (
    let t = start.getTime();
    t <= limit;
    t += 60_000
  ) {
    if (matchesWall(parsed, localWall(new Date(t)))) return t;
  }
  return undefined;
};

const wallFormats = new Map<string, Intl.DateTimeFormat>();

/** How far `timezone`'s wall clock is ahead of UTC at `epochMs`. */
const wallOffsetMs = (timezone: string, epochMs: number): number => {
  let format = wallFormats.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallFormats.set(timezone, format);
  }
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(new Date(epochMs))) part[type] = Number(value);
  const wall = Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!);
  return wall - Math.floor(epochMs / 1000) * 1000;
};

/**
 * Next fire strictly after `afterEpochMs` on `timezone`'s wall clock (an IANA
 * name). Walks wall minutes, so a spring-forward gap fires at the shifted
 * instant and a fall-back hour fires once. Undefined for an invalid
 * expression or no match within two years.
 */
export const nextCronOccurrenceIn = (
  raw: string,
  afterEpochMs: number,
  timezone: string,
): number | undefined => {
  const parsed = parseCronExpression(raw);
  if ("error" in parsed) return undefined;
  const offset = wallOffsetMs(timezone, afterEpochMs);
  const start = Math.floor((afterEpochMs + offset) / 60_000) * 60_000 + 60_000;
  const limit = start + 366 * 2 * 24 * 60 * 60_000;
  for (let wall = start; wall <= limit; wall += 60_000) {
    if (!matchesWall(parsed, utcWall(new Date(wall)))) continue;
    const guess = wall - wallOffsetMs(timezone, wall - offset);
    const instant = wall - wallOffsetMs(timezone, guess);
    if (instant > afterEpochMs) return instant;
  }
  return undefined;
};

/** Human glance: keep source, or short labels for common presets. */
export const describeCronExpression = (raw: string): string => {
  const source = raw.trim().replace(/\s+/g, " ");
  const presets: Record<string, string> = {
    "* * * * *": "every minute",
    "*/5 * * * *": "every 5m",
    "*/15 * * * *": "every 15m",
    "*/30 * * * *": "every 30m",
    "0 * * * *": "hourly",
    "0 */2 * * *": "every 2h",
    "0 9 * * *": "daily 09:00",
    "0 9 * * 1-5": "weekdays 09:00",
    "0 0 * * 0": "Sundays midnight",
  };
  return presets[source] ?? source;
};

export const CRON_PRESETS: ReadonlyArray<{
  readonly label: string;
  readonly expression: string;
}> = [
  { label: "every 5 minutes", expression: "*/5 * * * *" },
  { label: "every 15 minutes", expression: "*/15 * * * *" },
  { label: "every 30 minutes", expression: "*/30 * * * *" },
  { label: "hourly", expression: "0 * * * *" },
  { label: "daily 09:00", expression: "0 9 * * *" },
  { label: "weekdays 09:00", expression: "0 9 * * 1-5" },
  { label: "Sundays midnight", expression: "0 0 * * 0" },
];

/** Migrate legacy everyMinutes → expression when possible. */
export const expressionFromEveryMinutes = (minutes: number): string => {
  if (!Number.isFinite(minutes) || minutes <= 0) return "*/30 * * * *";
  const m = Math.round(minutes);
  if (m === 60) return "0 * * * *";
  if (m < 60 && 60 % m === 0) return `*/${m} * * * *`;
  if (m % 60 === 0) {
    const h = m / 60;
    if (h < 24 && 24 % h === 0) return `0 */${h} * * *`;
  }
  // Fallback: every N minutes via step (best-effort; not exact for N>59).
  if (m <= 59) return `*/${m} * * * *`;
  return "0 * * * *";
};
