/**
 * A seat as the companion shows it: one ring state and one line, derived in the
 * order every desktop seat surface reads (`seatRollup`): the seat's own
 * declared signal, then proven control attention, then Jev's thread-health
 * reading, then plain control state. Process facts (starting, stopped,
 * offline) outrank a reading, because a reading about a seat that is not
 * running is stale by construction.
 *
 * The ring is the desktop card's own: the seat grammar (`terminalActivity`)
 * for a managed seat, then `ringState`, the rule the canvas paints from.
 *
 * Pure: main and the demo both build a `CompanionSeatInput` from their own
 * stores and read the same answer.
 */

import type { AgentSeatState } from "./agent-seat-state";
import type { AgentSignalKind } from "./agent-signals";
import type { CompanionSeat, CompanionSeatState } from "./companion-protocol";
import { attentionText, type FeedHealth, type FeedRegion, type FeedSeat } from "./operator-feed";
import { ringState, type RingState } from "./rings";
import { resolveActivityGlyph, terminalActivity } from "./seat-activity";

export type CompanionSeatInput = {
  readonly seat: FeedSeat;
  readonly region: FeedRegion;
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
  };
};

const SIGNAL_STATE: Readonly<Record<AgentSignalKind, readonly [CompanionSeatState, string]>> = {
  blocked: ["blocked", "blocked"],
  escalate: ["waiting_on_you", "wants you"],
  feedback: ["waiting_on_you", "ready for review"],
};

const pick = (input: CompanionSeatInput): readonly [CompanionSeatState, string] => {
  if (input.signal) return SIGNAL_STATE[input.signal.kind];
  const control = input.control;
  if (control?.state === "attention") return ["needs_input", attentionText(control.reason)];
  if (input.process === undefined || control?.state === "gone" || control?.state === "unknown") {
    // The wire state keeps its name; the line is the desktop's words, and a
    // seat with no process is not running (offline is a machine's word).
    return input.process === "stopped" ? ["stopped", "stopped"] : ["offline", "not running"];
  }
  if (input.process === "stopped") return ["stopped", "stopped"];
  if (input.process === "starting") return ["starting", "starting up"];
  const health = input.health && !input.health.stale ? input.health : undefined;
  if (health?.tone === "trouble") return ["trouble", `AI reads: ${health.label}`];
  if (health?.tone === "waiting") return ["waiting_on_you", `AI reads: ${health.label}`];
  const good = health?.tone === "good" ? `AI reads: ${health.label}` : undefined;
  if (control?.state === "working") return ["working", good ?? "working"];
  if (input.doneUnread) return ["done_unread", good ?? "done, not read yet"];
  return ["resting", good ?? "resting"];
};

/**
 * The ring the desktop card draws. A declared blocked or escalate drops a
 * "waiting" reading and fades a good one, as the card's health mark does.
 */
export const companionSeatRing = (input: CompanionSeatInput): RingState => {
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
  const signal = input.signal?.kind;
  const declared = signal === "blocked" || signal === "escalate";
  const health = input.health && !(declared && input.health.tone === "waiting") ? input.health : undefined;
  return ringState({
    glyph: resolveActivityGlyph(spec.mode, spec.tone, spec.glyph),
    tone: spec.tone,
    ...(health
      ? { health: health.tone, healthValue: health.value, healthStale: health.stale || (declared && health.tone === "good") }
      : {}),
    ...(signal ? { signal } : {}),
  });
};

export const companionSeat = (input: CompanionSeatInput): CompanionSeat => {
  const [state, line] = pick(input);
  const since = input.ring?.since ?? input.control?.at;
  return {
    nodeId: input.seat.nodeId,
    name: input.seat.name,
    portraitIdentity: input.seat.portraitIdentity,
    ...(input.seat.harness !== undefined ? { harness: input.seat.harness } : {}),
    region: input.region,
    state,
    line,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.health ? { health: input.health } : {}),
    ...(input.control ? { lastActivityAt: input.control.at } : {}),
    ...(input.ring ? { ring: companionSeatRing(input), ...(since === undefined ? {} : { stateStartedAt: since }) } : {}),
  };
};
