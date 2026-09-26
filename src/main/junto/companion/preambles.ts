/**
 * Live preambles for the phone: every preamble main hears (an agent's own
 * `junto preamble`, or one Junto or the AI says for a seat) kept per seat
 * until it expires. Ephemeral by design: memory only, never stored.
 */
import type { PreambleEvent } from "@shared/preamble";
import type { CompanionPreamble } from "@shared/companion-protocol";

const PER_SEAT = 8;
const bySeat = new Map<string, CompanionPreamble[]>();
const key = (canvasName: string, nodeId: string): string => `${canvasName}\u0000${nodeId}`;

const SOURCE: Readonly<Record<NonNullable<PreambleEvent["provenance"]>, CompanionPreamble["source"]>> = {
  agent: "agent",
  ai: "ai",
  system: "junto",
  operator: "operator",
};

export const notePreamble = (event: PreambleEvent, now: number = Date.now()): void => {
  const ref = key(event.canvasName, event.nodeId);
  const next: CompanionPreamble = {
    preambleId: event.preambleId,
    text: event.text,
    source: SOURCE[event.provenance ?? "agent"],
    at: now,
    expiresAt: event.expiresAt,
  };
  const kept = (bySeat.get(ref) ?? []).filter((preamble) => preamble.preambleId !== event.preambleId && preamble.expiresAt > now);
  bySeat.set(ref, [next, ...kept].slice(0, PER_SEAT));
};

/** The seat's live preambles, newest first. */
export const livePreambles = (canvasName: string, nodeId: string, now: number = Date.now()): ReadonlyArray<CompanionPreamble> =>
  (bySeat.get(key(canvasName, nodeId)) ?? []).filter((preamble) => preamble.expiresAt > now);
