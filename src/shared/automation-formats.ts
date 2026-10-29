/**
 * Value formats (0.11/09 H1): a value token may carry formats, applied left
 * to right, `{{fired.at|date:YYYY-MM-DD}}` or `{{task.title|slug|upper}}`.
 * The set is closed; an unknown format, or a date pattern with anything but
 * its tokens and separators in it, is refused when the automation is saved.
 * Pure: no I/O, no clock.
 */

/** Every format, as Insert value lists them and a refusal names them. */
export const VALUE_FORMATS = ["date:<pattern>", "slug", "lower", "upper", "trim"] as const;

export type ValueFormat =
  | { readonly kind: "date"; readonly pattern: ReadonlyArray<DatePart> }
  | { readonly kind: "slug" | "lower" | "upper" | "trim" };

/** What a date pattern may say, longest first so `YYYY` is read before `YY`. */
const DATE_TOKENS = ["YYYY", "YY", "MM", "M", "DD", "D", "HH", "H", "mm", "ss"] as const;
type DateToken = (typeof DATE_TOKENS)[number];
/** The separators a date pattern writes as they are. */
const DATE_SEPARATORS = new Set(["-", "_", "/", ".", ":", ",", "T", " "]);

type DatePart = { readonly token: DateToken } | { readonly text: string };

/** The words a refusal of a bad pattern gives as its next step. */
export const DATE_PATTERN_WORDS = "YYYY, YY, MM, M, DD, D, HH, H, mm, ss, and - _ / . : , T or spaces";

/** A date pattern read into its parts, or undefined when it says anything else. */
const parseDatePattern = (pattern: string): ReadonlyArray<DatePart> | undefined => {
  if (pattern === "") return undefined;
  const parts: Array<DatePart> = [];
  let at = 0;
  while (at < pattern.length) {
    const token = DATE_TOKENS.find((candidate) => pattern.startsWith(candidate, at));
    if (token !== undefined) {
      parts.push({ token });
      at += token.length;
      continue;
    }
    const char = pattern[at]!;
    if (!DATE_SEPARATORS.has(char)) return undefined;
    parts.push({ text: char });
    at += 1;
  }
  return parts;
};

/** One format as written after a `|`, or undefined when the set holds no such format. */
export const parseValueFormat = (text: string): ValueFormat | undefined => {
  switch (text) {
    case "slug":
    case "lower":
    case "upper":
    case "trim":
      return { kind: text };
    default: {
      if (!text.startsWith("date:")) return undefined;
      const pattern = parseDatePattern(text.slice("date:".length));
      return pattern === undefined ? undefined : { kind: "date", pattern };
    }
  }
};

/** The formats after a value's name, `|date:YYYY|slug`, each read, or the first one the set does not hold. */
export const parseValueFormats = (
  written: string,
): { readonly ok: true; readonly formats: ReadonlyArray<ValueFormat> } | { readonly ok: false; readonly bad: string } => {
  if (written === "") return { ok: true, formats: [] };
  const formats: Array<ValueFormat> = [];
  for (const text of written.slice(1).split("|")) {
    const format = parseValueFormat(text);
    if (format === undefined) return { ok: false, bad: text };
    formats.push(format);
  }
  return { ok: true, formats };
};

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** A time's fields in a time zone; the runtime's own zone when none is named. */
const fieldsIn = (epochMs: number, timeZone: string | undefined): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> => {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: field("year"), month: field("month"), day: field("day"), hour: field("hour"), minute: field("minute"), second: field("second") };
};

const writeDate = (epochMs: number, pattern: ReadonlyArray<DatePart>, timeZone: string | undefined): string => {
  const at = fieldsIn(epochMs, timeZone);
  return pattern
    .map((part) => {
      if ("text" in part) return part.text;
      switch (part.token) {
        case "YYYY":
          return pad(at.year, 4);
        case "YY":
          return pad(at.year % 100, 2);
        case "MM":
          return pad(at.month, 2);
        case "M":
          return String(at.month);
        case "DD":
          return pad(at.day, 2);
        case "D":
          return String(at.day);
        case "HH":
          return pad(at.hour, 2);
        case "H":
          return String(at.hour);
        case "mm":
          return pad(at.minute, 2);
        case "ss":
          return pad(at.second, 2);
        default:
          return part.token satisfies never;
      }
    })
    .join("");
};

/** An ISO time, as `fired.at` and `answer.at` say one: anything else is not a time to a date format. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** One format applied. `date` on a value that is not a time leaves it as said. */
const applyFormat = (value: string, format: ValueFormat, timeZone: string | undefined): string => {
  switch (format.kind) {
    case "date": {
      if (!ISO_TIME.test(value)) return value;
      const epochMs = Date.parse(value);
      return Number.isNaN(epochMs) ? value : writeDate(epochMs, format.pattern, timeZone);
    }
    case "slug":
      return value
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
    case "lower":
      return value.toLowerCase();
    case "upper":
      return value.toUpperCase();
    case "trim":
      return value.trim();
    default:
      return format satisfies never;
  }
};

/** A value with its formats applied, left to right, in the automation's time zone. */
export const applyValueFormats = (value: string, formats: ReadonlyArray<ValueFormat>, timeZone: string | undefined): string =>
  formats.reduce((said, format) => applyFormat(said, format, timeZone), value);
