/**
 * What a still seat says of its cache window, in words: the status line under
 * its name and the rows of its hover card. Pure, so the drawing
 * (SeatCacheStatus.tsx) can be swapped for the look the operator picks and
 * the words stay. Read on this window's clock: main tells the window's end on
 * it, whichever machine runs the seat (seat-next-launch.ts).
 */
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { SeatCacheWindow } from "@shared/seat-next-launch";
import { CACHE_MODE_COPY } from "../settings/OffboardSettingsSection";

/** What the card hands the status line: the window, and whose it is. */
export type SeatCacheFace = {
  readonly window: SeatCacheWindow;
  readonly harness?: string;
  /** "this machine", or the seat's machine by its label. */
  readonly machine: string;
};

export type SeatCacheRow = { readonly key: string; readonly value: string };

export type SeatCacheStatusCopy = {
  /** The seat's state and how long it has been still, as the line says it. */
  readonly line: string;
  /** Past its window, on this clock. */
  readonly expired: boolean;
  readonly rows: ReadonlyArray<SeatCacheRow>;
  readonly notes: ReadonlyArray<string>;
};

const MINUTE_MS = 60_000;

/** Whole minutes as the seat line says them: 14m, 1h, 1h 12m. */
export const minutesWords = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const harnessName = (harness: string | undefined): string | undefined =>
  harness === undefined ? undefined : isHarnessId(harness) ? templateFor(harness).displayName : harness;

/**
 * The status line and hover card for a seat that is `words` (its state line,
 * "resting" or "not running") at `now`.
 */
export const seatCacheStatusCopy = (words: string, face: SeatCacheFace, now: number): SeatCacheStatusCopy => {
  const { window } = face;
  const still = Math.max(0, Math.floor((now - window.stillSince) / MINUTE_MS));
  const expired = now >= window.windowEndsAt;
  const since = clockTime(window.stillSince);
  const ends = clockTime(window.windowEndsAt);
  const harness = harnessName(face.harness);
  const mode = window.cacheMode === undefined ? undefined : CACHE_MODE_COPY[window.cacheMode];
  const rows: SeatCacheRow[] = [
    { key: "Status", value: still === 0 ? `${words} since ${since}` : `${words} for ${minutesWords(still)}, since ${since}` },
    {
      key: "Cache window",
      // In minutes, as Settings sets it.
      value: `${window.windowMinutes}m${harness === undefined ? "" : ` for ${harness}`} on ${face.machine}`,
    },
    expired
      ? { key: "Expired", value: `at ${ends}, ${minutesWords(Math.floor((now - window.windowEndsAt) / MINUTE_MS))} ago` }
      : { key: "Expires", value: `at ${ends}, in ${minutesWords(Math.ceil((window.windowEndsAt - now) / MINUTE_MS))}` },
    ...(mode === undefined ? [] : [{ key: "Mode", value: mode.label.toLowerCase() }]),
  ];
  const notes = [
    expired
      ? "Past the window the harness's cache has expired, so continuing re-reads the whole session at full price."
      : "Within the window the harness's cache is warm, so the next turn continues the session cheaply. Past it, continuing re-reads the whole session at full price.",
    ...(mode === undefined ? [] : [mode.line]),
  ];
  return { line: still === 0 ? words : `${words} ${minutesWords(still)}`, expired, rows, notes };
};

/**
 * When the words next change: the next whole minute still, or the window's
 * end if that comes first. The line redraws then and not before.
 */
export const nextCacheStatusChange = (window: SeatCacheWindow, now: number): number => {
  const minute = window.stillSince + (Math.floor((now - window.stillSince) / MINUTE_MS) + 1) * MINUTE_MS;
  return window.windowEndsAt > now ? Math.min(minute, window.windowEndsAt) : minute;
};
