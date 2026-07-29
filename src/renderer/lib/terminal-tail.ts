/**
 * Native terminal tail — renderer store for the small, coalesced preview
 * lines shown on TerminalCard when a node is large enough to earn them.
 *
 * Main owns the coalescing (see term/tail-runtime.ts) and broadcasts
 * `terminalTailChanged` (bindingId-keyed). No restart hydration snapshot —
 * this is a quiet preview, not state that needs to survive a renderer
 * restart; the next PTY write repopulates it.
 */

import { observable } from "@legendapp/state";
import type { TerminalTailEvent } from "@shared/terminal-tail";
import { getVellumApi } from "./vellum-api";

export type TerminalTailStore = {
  readonly byBindingId: Record<string, TerminalTailEvent | undefined>;
};

export const terminalTail$ = observable<TerminalTailStore>({
  byBindingId: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const decodeTerminalTailEvent = (raw: unknown): TerminalTailEvent | undefined => {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.bindingId !== "string" || raw.bindingId.length === 0) return undefined;
  if (typeof raw.epoch !== "string") return undefined;
  if (!Array.isArray(raw.lines) || !raw.lines.every((l) => typeof l === "string")) return undefined;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
  return {
    bindingId: raw.bindingId,
    epoch: raw.epoch,
    lines: raw.lines,
    at: raw.at,
  };
};

export const applyTerminalTailEvent = (event: TerminalTailEvent): void => {
  const current = terminalTail$.byBindingId[event.bindingId].peek();
  if (current && event.at < current.at) return;
  terminalTail$.byBindingId[event.bindingId].set(event);
};

// Singleton fan-out, mirrors subscribeAgentSeatState — safe from any card mount.
let activeUnsubscribe: (() => void) | undefined;

export const subscribeTerminalTail = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getVellumApi();
  if (!api || typeof api.onTerminalTailChanged !== "function") {
    return () => undefined;
  }
  const unsubscribe = api.onTerminalTailChanged((raw) => {
    const event = decodeTerminalTailEvent(raw);
    if (!event) return;
    applyTerminalTailEvent(event);
  });
  activeUnsubscribe = () => {
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  return activeUnsubscribe;
};

/** Test / unmount helper — clear store + allow re-subscribe. */
export const resetTerminalTail = (): void => {
  terminalTail$.byBindingId.set({});
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = undefined;
  }
};
