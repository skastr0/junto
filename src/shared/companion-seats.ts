/**
 * A seat as the companion shows it: one ring state and one line, derived in the
 * order every desktop seat surface reads (`seatRollup`): the seat's own
 * declared signal, then proven control attention, then Jev's thread-health
 * reading, then plain control state. Process facts (starting, stopped,
 * offline) outrank a reading, because a reading about a seat that is not
 * running is stale by construction.
 *
 * The ring is the desktop card's own (wire/seat-ring.ts).
 *
 * Pure: main and the demo both build a `CompanionSeatInput` from their own
 * stores and read the same answer.
 */

import type { AgentSignalKind } from "./agent-signals";
import type { CompanionSeat, CompanionSeatState } from "./companion-protocol";
import { attentionText, type FeedRegion, type FeedSeat } from "./operator-feed";
import { companionSeatLevel, companionSeatRing, type CompanionSeatRingInput } from "./wire/seat-ring";

// The ring half is a wire module, so the phone syncs the same ring.
export { companionSeatRing, type CompanionSeatRingInput } from "./wire/seat-ring";

export type CompanionSeatInput = CompanionSeatRingInput & {
  readonly seat: FeedSeat;
  readonly region: FeedRegion;
  /** What the operator has not read in the seat's threads (`unreadTotals`); absent when it could not be read. */
  readonly unread?: number;
};

const SIGNAL_STATE: Readonly<Record<AgentSignalKind, readonly [CompanionSeatState, string]>> = {
  blocked: ["blocked", "blocked"],
  escalate: ["waiting_on_you", "wants you"],
  feedback: ["waiting_on_you", "ready for review"],
  notice: ["waiting_on_you", "read it"],
  work: ["waiting_on_you", "to do"],
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

export const companionSeat = (input: CompanionSeatInput): CompanionSeat => {
  const [state, line] = pick(input);
  const since = input.ring?.since ?? input.control?.at;
  const level = input.ring ? companionSeatLevel(input) : undefined;
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
    ...(input.unread === undefined ? {} : { unread: input.unread }),
    ...(input.control ? { lastActivityAt: input.control.at } : {}),
    ...(input.ring ? { ring: companionSeatRing(input), ...(since === undefined ? {} : { stateStartedAt: since }) } : {}),
    ...(level ? { level: level.level, levelSince: level.since } : {}),
  };
};
