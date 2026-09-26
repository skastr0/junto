/**
 * A seat as the companion shows it: one ring state and one line, derived in the
 * order every desktop seat surface reads (`seatRollup`): the seat's own
 * declared signal, then proven control attention, then Jev's thread-health
 * reading, then plain control state. Process facts (starting, stopped,
 * offline) outrank a reading, because a reading about a seat that is not
 * running is stale by construction.
 *
 * Pure: main and the demo both build a `CompanionSeatInput` from their own
 * stores and read the same answer.
 */

import type { AgentSeatState } from "./agent-seat-state";
import type { AgentSignalKind } from "./agent-signals";
import type { CompanionSeat, CompanionSeatState } from "./companion-protocol";
import { attentionText, type FeedHealth, type FeedRegion, type FeedSeat } from "./operator-feed";

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
    return input.process === "stopped" ? ["stopped", "stopped"] : ["offline", "offline"];
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
  };
};
