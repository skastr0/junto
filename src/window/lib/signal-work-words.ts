// How a feed item's work reads, free of the signal store: its kind, form and
// timing, whether it is due, and when, in words. signal-work.ts re-exports these.
import type { FeedItem } from "@shared/operator-feed";
import type { SignalForm, WorkTiming } from "@shared/wire/agent-signals";
import { Level, levelOfSignal } from "@shared/wire/urgency";

/** Open work is due on the ladder (urgent, or its time passed), as N1's levelOfSignal rules it. */
export const workIsDue = (timing: WorkTiming, nowMs: number): boolean => levelOfSignal("work", timing, nowMs) === Level.due;

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

/** What a feed item says of the operator's work: its kind when it is a notice or work, its form, and work's timing. */
export type ItemWork = {
  readonly kind: "notice" | "work" | undefined;
  readonly form: SignalForm | undefined;
  readonly work: WorkTiming | undefined;
};

export const itemWorkOf = (item: Pick<FeedItem, "kind" | "form" | "work">): ItemWork => ({
  kind: item.kind === "notice" || item.kind === "work" ? item.kind : undefined,
  form: item.form,
  work: item.work,
});
