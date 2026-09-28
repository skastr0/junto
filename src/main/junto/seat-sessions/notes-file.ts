import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
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

/** A notes file's markdown, bounded; undefined when it cannot be read. */
export const readNotesFile = (path: string): string | undefined => {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > SEAT_SESSION_NOTES_MAX_CHARS ? text.slice(0, SEAT_SESSION_NOTES_MAX_CHARS) : text;
  } catch {
    return undefined;
  }
};
