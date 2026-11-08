/**
 * The ring a companion seat carries: the desktop card's own. The seat grammar
 * (`terminalActivity`) for a managed seat, then `ringState`, the rule the
 * canvas paints from. A wire module, so the phone's demo reads the same ring
 * main sends, and the level the palette ranks it by; companion-seats.ts builds
 * the rest of the seat around them.
 */

import type { AgentSignalKind } from "./agent-signals";
import type { FeedHealth } from "./operator-feed";
import { ringState, type RingState } from "./rings";
import { resolveActivityGlyph, terminalActivity, type AgentSeatState } from "./seat-activity";
import { seatLevel, seatLevelSince } from "./seat-level";
import type { UrgencyLevel } from "./urgency";

/** What the ring reads of a seat. */
export type CompanionSeatRingInput = {
  /** The seat state machine's latest reading for the seat's binding. */
  readonly control?: { readonly state: AgentSeatState; readonly reason: string; readonly at: number };
  /** The occupant process. Absent: no binding at all (offline). */
  readonly process?: "running" | "starting" | "stopped";
  /** Finished work nobody has looked at yet. */
  readonly doneUnread?: boolean;
  readonly signal?: { readonly kind: AgentSignalKind; readonly signalId: string; readonly openCount: number };
  readonly health?: FeedHealth;
  /** What only the ring reads; absent, no ring is sent. */
  readonly ring?: {
    /** The kernel holds the seat behind a stoppage. */
    readonly graphBlocked?: boolean;
    /** The harness failed before it ran. */
    readonly exitReason?: "cli-missing" | "spawn_failed";
    /** When the seat's shown status began, ms. */
    readonly since?: number;
    /** When it last left rest for work, ms. */
    readonly activitySince?: number;
    /** When its unread turn finished, ms. */
    readonly turnUnseenSince?: number;
    /** When its open signal was raised, ms. */
    readonly signalAt?: number;
  };
};

/** The seat grammar's reading, the one spec both the ring and the level read. */
const seatSpec = (input: CompanionSeatRingInput) => {
  const facts = input.ring ?? {};
  const spec = terminalActivity({
    seatState: input.control?.state ?? null,
    seatReason: input.control?.reason ?? null,
    needsLook: input.doneUnread === true,
    running: input.process === "running" || input.process === "starting",
    starting: input.process === "starting",
    graphBlocked: facts.graphBlocked === true,
    exitReason: facts.exitReason ?? null,
    managedSeat: true,
  });
  return { ...spec, glyph: resolveActivityGlyph(spec.mode, spec.tone, spec.glyph) };
};

/**
 * The ring the desktop card draws. A declared blocked or escalate drops a
 * "waiting" reading and fades a good one, as the card's health mark does.
 */
export const companionSeatRing = (input: CompanionSeatRingInput): RingState => {
  const spec = seatSpec(input);
  const signal = input.signal?.kind;
  const declared = signal === "blocked" || signal === "escalate";
  const health = input.health && !(declared && input.health.tone === "waiting") ? input.health : undefined;
  return ringState({
    glyph: spec.glyph,
    tone: spec.tone,
    ...(health
      ? { health: health.tone, healthValue: health.value, healthStale: health.stale || (declared && health.tone === "good") }
      : {}),
    ...(signal ? { signal } : {}),
  });
};

/** The seat's level on the urgency ladder and when it took it, as the desktop palette ranks it. */
export const companionSeatLevel = (input: CompanionSeatRingInput): { readonly level: UrgencyLevel; readonly since: number } => {
  const facts = input.ring ?? {};
  const signal = input.signal?.kind;
  const level = seatLevel({
    activity: seatSpec(input),
    ...(signal ? { signal } : {}),
    // The desktop prints the spawn failure's message; any failed spawn is one.
    ...(facts.exitReason ? { failure: facts.exitReason } : {}),
  });
  const since = seatLevelSince({
    level,
    ...(signal && facts.signalAt !== undefined ? { signal: { kind: signal, createdAt: facts.signalAt } } : {}),
    ...(facts.since !== undefined
      ? {
          snapshot: {
            since: facts.since,
            ...(facts.activitySince !== undefined ? { activitySince: facts.activitySince } : {}),
            ...(facts.turnUnseenSince !== undefined ? { turnUnseen: { since: facts.turnUnseenSince } } : {}),
          },
        }
      : {}),
    ...(input.control ? { at: input.control.at } : {}),
  });
  return { level, since };
};
