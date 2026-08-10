/**
 * OSC-derived hook feed into SeatStateMachine.setHookState.
 * Full per-harness hook install remains separate; this keeps the hooks rank live.
 */

import type { AgentSeatHookState } from "../../../../shared/agent-seat-state";
import type { ObserverGridSnapshot } from "../observer/types";
import type { SeatStateMachine } from "./seat-state-machine";

export const hookStateFromSnapshot = (
  snap: ObserverGridSnapshot,
  harness: string,
  now: number,
): AgentSeatHookState | null => {
  const title = snap.signals.title.trim();
  const osc9 = snap.signals.osc9.trim();
  const h = harness.toLowerCase();

  if (h === "codex") {
    if (/action required/i.test(title)) {
      return {
        state: "attention",
        reason: "osc_title_action_required",
        at: now,
        fullLifecycle: false,
      };
    }
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(title)) {
      return {
        state: "working",
        reason: "osc_title_spinner",
        at: now,
        fullLifecycle: false,
      };
    }
    return null;
  }

  if (h === "claude") {
    // OSC 9;4;x is the deterministic working/idle flag (K9) and wins over
    // the title: the title may stay on a stale braille frame after the turn
    // ended (4;0 + braille = false busy, must be idle) and a genuinely
    // working seat keeps an empty composer with braille + 4;3 (must be
    // working). The braille title is the no-OSC9 fallback below.
    if (/^4;3/.test(osc9) || /^4;1/.test(osc9)) {
      return {
        state: "working",
        reason: "osc9_progress",
        at: now,
        fullLifecycle: false,
      };
    }
    if (/^4;0/.test(osc9)) {
      return {
        state: "idle",
        reason: "osc9_idle",
        at: now,
        fullLifecycle: false,
      };
    }
    if (/^[\u2800-\u28FF]/.test(title)) {
      return {
        state: "working",
        reason: "osc_title_braille",
        at: now,
        fullLifecycle: false,
      };
    }
    return null;
  }

  if (h === "hermes") {
    if (/⚠|warning|attention/i.test(title)) {
      return {
        state: "attention",
        reason: "osc_title_warn",
        at: now,
        fullLifecycle: false,
      };
    }
    return null;
  }

  if (h === "grok") {
    if (osc9.length > 0 && !/^4;0/.test(osc9)) {
      return {
        state: "working",
        reason: "osc9_activity",
        at: now,
        fullLifecycle: false,
      };
    }
    return null;
  }

  return null;
};

/**
 * Apply OSC-derived hook for one snapshot.
 * `null` **clears** sticky prior working/idle — never retain forever.
 */
export const applyOscHookFromSnapshot = (
  machine: SeatStateMachine,
  snap: ObserverGridSnapshot,
  now: number = Date.now(),
): AgentSeatHookState | null => {
  const slot = machine.getSlot(snap.bindingId);
  if (!slot) return null;
  const hook = hookStateFromSnapshot(snap, String(slot.harness), now);
  machine.setHookState(snap.bindingId, hook);
  return hook;
};

export const attachOscHookFeed = (
  machine: SeatStateMachine,
  subscribe: (
    listener: (snap: ObserverGridSnapshot) => void,
  ) => () => void,
): (() => void) =>
  subscribe((snap) => {
    applyOscHookFromSnapshot(machine, snap);
  });
