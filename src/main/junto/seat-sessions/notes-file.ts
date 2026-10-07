import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { OFFBOARD_BY, type OffboardBy } from "@shared/seat-offboard";
import { SEAT_SESSION_NOTES_MAX_CHARS } from "@shared/seat-sessions";

/** `~/.junto/seats`: one directory per seat, its session notes inside. */
export const defaultSeatsRoot = (): string => join(resolveJuntoHome(), ".junto", "seats");

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A seat or session id as one path segment. Ids are opaque strings, so one
 * that could climb out of its directory or is not a plain name is replaced by
 * a stable digest instead of being trusted as a path.
 */
export const pathSegment = (id: string): string =>
  SAFE_SEGMENT.test(id) && !id.includes("..")
    ? id
    : `id-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

/** `<seats root>/<seat>/sessions/<session>.md` */
export const seatSessionNotesPath = (seatsRoot: string, seatId: string, sessionId: string): string =>
  join(seatsRoot, pathSegment(seatId), "sessions", `${pathSegment(sessionId)}.md`);

/**
 * `<seats root>/<seat>/sessions/<session>.next.md`: the note a continuing
 * session left for the one after it, beside its notes.
 */
export const continuationPathOf = (notesPath: string): string => notesPath.replace(/\.md$/, ".next.md");

/**
 * `<seats root>/<seat>/sessions/<session>.onboarded`: present once the seat's
 * agent ran `junto onboard` in that harness session. It sits beside the
 * session's notes so a resumed session reads its own status back, and a fresh
 * session, having no file, starts without one.
 */
export const onboardedMarkerPath = (seatsRoot: string, seatId: string, sessionId: string): string =>
  seatSessionNotesPath(seatsRoot, seatId, sessionId).replace(/\.md$/, ".onboarded");

export const markSessionOnboarded = (path: string, at: number): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${new Date(at).toISOString()}\n`, { mode: 0o600 });
};

export const sessionOnboarded = (path: string): boolean => existsSync(path);

/**
 * `<seats root>/<seat>/sessions/<session>.ended.json`: who ended a session
 * from outside it (the operator, an overseer, or the automatic rule) when it
 * was closed without notes. An agent's own offboard writes none.
 */
export const endedPathOf = (notesPath: string): string => notesPath.replace(/\.md$/, ".ended.json");

export type EndedMarker = { readonly by: OffboardBy; readonly at: number };

export const writeEndedMarker = (notesPath: string, marker: EndedMarker): void => {
  const path = endedPathOf(notesPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ by: marker.by, at: marker.at })}\n`, { mode: 0o600 });
};

/** The marker, or undefined when there is none or it cannot be read. */
export const readEndedMarker = (notesPath: string): EndedMarker | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(endedPathOf(notesPath), "utf8")) as {
      by?: unknown;
      at?: unknown;
    };
    return (OFFBOARD_BY as ReadonlyArray<unknown>).includes(parsed.by) &&
      typeof parsed.at === "number" &&
      Number.isFinite(parsed.at)
      ? { by: parsed.by as OffboardBy, at: parsed.at }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Replace a notes file whole: written beside it, then renamed over it, so a
 * reader never sees half a file. Owner-only, like the rest of `~/.junto`.
 */
export const writeNotesFile = (path: string, notes: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, notes.endsWith("\n") ? notes : `${notes}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

/** Remove a notes file; one that is not there is already removed. */
export const removeNotesFile = (path: string): void => {
  rmSync(path, { force: true });
};

/** A notes file's markdown, bounded; undefined when it cannot be read. */
export const readNotesFile = (path: string, max = SEAT_SESSION_NOTES_MAX_CHARS): string | undefined => {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return undefined;
  }
};
