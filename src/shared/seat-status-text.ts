/**
 * A seat's status in one plain line, the way `junto seat read` shows it:
 * the status, then why, e.g. "Blocked UsageLimit weekly, resets 15:00".
 * Times are local; a time on another day carries its date.
 */
import type { SeatSnapshot, SeatStatus } from "./harness-domain";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number): string => String(n).padStart(2, "0");

/** "15:00" today, "Oct 18 15:00" on any other day. */
export const seatStatusTime = (at: number, now: number): string => {
  const when = new Date(at);
  const today = new Date(now);
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  return sameDay ? clock : `${MONTHS[when.getMonth()]} ${when.getDate()} ${clock}`;
};

const statusText = (status: SeatStatus, now: number): string => {
  switch (status._tag) {
    case "Starting":
    case "Idle":
    case "Unknown":
      return status._tag;
    case "Working":
      return status.phase === "thinking" ? "Working" : `Working ${status.phase}`;
    case "Exited": {
      const how =
        status.signal !== undefined
          ? `, by ${status.signal}`
          : status.code !== undefined
            ? `, code ${status.code}`
            : "";
      const expected = status.expected === false ? ", unexpected" : "";
      return `Exited${how}${expected}`;
    }
    case "Blocked": {
      const reason = status.reason;
      switch (reason._tag) {
        case "Permission":
          return `Blocked Permission${reason.tool === undefined ? "" : ` ${reason.tool}`}`;
        case "Question":
          return "Blocked Question";
        case "Dialog":
          return `Blocked Dialog ${reason.kind}`;
        case "UsageLimit":
          return `Blocked UsageLimit ${reason.scope}${
            reason.resetsAt === undefined ? "" : `, resets ${seatStatusTime(reason.resetsAt, now)}`
          }`;
        case "Error":
          return `Blocked Error ${reason.kind}`;
      }
    }
  }
};

export const describeSeatStatus = (snapshot: SeatSnapshot, now: number = Date.now()): string => {
  const text = statusText(snapshot.status, now);
  return snapshot.stalledSince === undefined || snapshot.status._tag !== "Working"
    ? text
    : `${text}, stalled since ${seatStatusTime(snapshot.stalledSince, now)}`;
};
