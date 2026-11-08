/**
 * Look for a seat's session id right now. A harness that mints its own id is
 * read at the seat's state boundaries, so in the first turn of a fresh
 * session the id can be on disk and not yet known here; an agent that
 * offboards then would be refused and left with no turn in which to try again.
 */
import { Effect } from "effect";
import type { Node } from "@shared/model";
import type { SeatSessionObservation } from "../seat-sessions/repository";

let seatSessionLookup: ((bindingId: string) => Promise<string | undefined>) | undefined;

/** Wired by the app to the seat's session capture. */
export const setSeatSessionLookup = (
  lookup: ((bindingId: string) => Promise<string | undefined>) | undefined,
): void => {
  seatSessionLookup = lookup;
};

/** The session found by looking once, or undefined (never a failure). */
export const lookForSeatSession = (node: Node): Effect.Effect<SeatSessionObservation | undefined> => {
  const surface = node.kind === "agent" ? node : undefined;
  const lookup = seatSessionLookup;
  if (surface === undefined || lookup === undefined) return Effect.succeed(undefined);
  const cwd = surface?.launch?.cwd?.trim();
  return Effect.promise(() => lookup(surface.bindingId).catch(() => undefined)).pipe(
    Effect.map((sessionId) =>
      sessionId?.trim()
        ? { seatId: node.id, bindingId: surface.bindingId, sessionId: sessionId.trim(), harness: surface.harness, ...(cwd ? { cwd } : {}) }
        : undefined,
    ),
  );
};
