/**
 * The operator's work in the needs-you feed (plan 0.11/07, N3): what a
 * signal asks of the operator, how far a reply has come toward its
 * condition, and where open work sits on the urgency ladder.
 *
 * Stand-in: N1 (product-feed) names the contract. Until it lands these are
 * the feed's own names for the fields a signal will carry; the switch is a
 * rename here and nowhere else.
 */
import { wordCountOf } from "@shared/word-count";

/**
 * The reply a signal asks for, one per signal. `artifact` is a document the
 * operator writes in the signal, made in an Artifacts node; `proof` is text
 * with links or files; `text` is today's reply. The secret form comes with
 * N5 (a vault), not here.
 */
export type SignalForm =
  | { readonly kind: "text" }
  | {
      readonly kind: "artifact";
      readonly nodeId: string;
      /** The document's title; the signal's text when absent. */
      readonly title?: string;
      readonly labels?: ReadonlyArray<string>;
      /** The condition: at least this many words. */
      readonly minWords?: number;
    }
  | { readonly kind: "proof" };

/** What the operator's own work carries: when it is due, and whether whoever raised it marked it urgent. */
export type WorkTiming = { readonly due?: number; readonly urgent?: boolean };

/** Open work on the ladder: `due` once urgent or past its due time, `todo` before. */
export const workLevel = ({ due, urgent }: WorkTiming, nowMs: number): "due" | "todo" =>
  urgent === true || (due !== undefined && due <= nowMs) ? "due" : "todo";

const DAY_MS = 86_400_000;

/**
 * When work is due, in words: "due 18:00" today, "due tomorrow 09:00",
 * "due Fri 09:00" within the week, "due 3 Nov" further out; once passed,
 * "was due 09:00" and so on. Nothing without a due time.
 */
export const dueWords = (due: number | undefined, nowMs: number, timeZone?: string): string | undefined => {
  if (due === undefined) return undefined;
  const zone = timeZone === undefined ? {} : { timeZone };
  const dayOf = (ms: number): string => new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(due);
  const days = Math.round((Date.parse(dayOf(due)) - Date.parse(dayOf(nowMs))) / DAY_MS);
  const when =
    days === 0
      ? time
      : days === 1
        ? `tomorrow ${time}`
        : days === -1
          ? `yesterday ${time}`
          : Math.abs(days) < 7
            ? `${new Intl.DateTimeFormat("en-GB", { ...zone, weekday: "short" }).format(due)} ${time}`
            : new Intl.DateTimeFormat("en-GB", { ...zone, day: "numeric", month: "short" }).format(due);
  return `${due <= nowMs ? "was due" : "due"} ${when}`;
};

/** How far a written reply is toward an artifact form's word condition. */
export type WordProgress = { readonly words: number; readonly min: number | undefined; readonly met: boolean };

export const wordProgressOf = (markdown: string, minWords: number | undefined): WordProgress => {
  const words = wordCountOf(markdown);
  return { words, min: minWords, met: words > 0 && (minWords === undefined || words >= minWords) };
};

/** The condition as it fills: "212 words of 500", or "212 words" with no minimum. */
export const wordProgressWords = ({ words, min }: WordProgress): string => {
  const counted = `${words} ${words === 1 ? "word" : "words"}`;
  return min === undefined ? counted : `${counted} of ${min}`;
};
