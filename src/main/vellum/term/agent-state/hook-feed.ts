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
    if (/^[\u2800-\u28FF]/.test(title)) {
      return {
        state: "working",
        reason: "osc_title_braille",
        at: now,
        fullLifecycle: false,
      };
    }
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

export const attachOscHookFeed = (
  machine: SeatStateMachine,
  subscribe: (
    listener: (snap: ObserverGridSnapshot) => void,
  ) => () => void,
): (() => void) =>
  subscribe((snap) => {
    const slot = machine.getSlot(snap.bindingId);
    if (!slot) return;
    const hook = hookStateFromSnapshot(snap, String(slot.harness), Date.now());
    if (hook) machine.setHookState(snap.bindingId, hook);
  });
