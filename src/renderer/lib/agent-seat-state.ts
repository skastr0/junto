/**
 * Managed-agent seat state — renderer store for Phase 3 chrome.
 *
 * Main owns a current snapshot and broadcasts `agentSeatStateChanged`
 * (bindingId-keyed). This module:
 *   1. subscribes, then hydrates the snapshot so renderer restarts lose no state
 *   2. keeps the latest event per bindingId
 *   3. joins bindingId → canvas nodeId when known (document terminal bind
 *      or terminal inventory session.canvasName/nodeId)
 *   4. feeds occupancy / card chrome (attention amber, working cyan)
 *   5. derives presentation "done" as idle + needsLook (herdr Idle+!seen)
 *
 * Never writes the canvas. Absent bridge degrades to a no-op subscribe.
 */

import { observable } from "@legendapp/state";
import {
  isAgentSeatState,
  type AgentSeatConfidence,
  type AgentSeatState,
  type AgentSeatStateEvent,
} from "@shared/agent-seat-state";
import type { CanvasNode } from "@shared/canvas";
import type { OccupancyClue, OccupancyHarnessState } from "@shared/occupancy";
import { resolveTerminalBinding, type WorkSurfaceActivity } from "@shared/terminal";
import { getVellumCommandApi } from "./vellum-api";
import { terminal$ } from "./terminal-state";

export type AgentSeatStore = {
  /** Latest seat event by terminal bindingId. */
  readonly byBindingId: Record<string, AgentSeatStateEvent | undefined>;
  /**
   * Reverse join: canvas nodeId → bindingId when known.
   * Filled from events (via inventory) and document terminal binds on read.
   */
  readonly bindingIdByNodeId: Record<string, string | undefined>;
  /**
   * Idle after work, operator has not looked yet → present as done (not idle).
   * Mirrors herdr's Idle+!seen. Cleared by markAgentSeatSeen (open path).
   */
  readonly needsLookByBindingId: Record<string, boolean | undefined>;
};

export const agentSeat$ = observable<AgentSeatStore>({
  byBindingId: {},
  bindingIdByNodeId: {},
  needsLookByBindingId: {},
});

/** Product presentation: engine states plus derived ready/complete. */
export type AgentSeatPresentation = AgentSeatState | "done";

/** True when a native terminal surface is open for this binding. */
export const isBindingSurfaceOpen = (bindingId: string): boolean => {
  const open = terminal$.openByNodeId.peek();
  for (const node of Object.values(open)) {
    if (!node) continue;
    const native = resolveTerminalBinding(node);
    if (native?.kind === "native" && native.bindingId === bindingId) return true;
  }
  // Inventory join: nodeId → binding when surface was opened via node id key.
  for (const [nodeId, openNode] of Object.entries(open)) {
    if (!openNode) continue;
    if (agentSeat$.bindingIdByNodeId[nodeId].peek() === bindingId) return true;
  }
  return false;
};

/** Idle + needsLook → done (ready/complete until the operator looks). */
export const presentationForSeat = (
  state: AgentSeatState | undefined,
  needsLook: boolean | undefined,
): AgentSeatPresentation | undefined => {
  if (!state) return undefined;
  if (state === "idle" && needsLook === true) return "done";
  return state;
};

export const seatNeedsLook = (bindingId: string | undefined): boolean => {
  if (!bindingId) return false;
  return agentSeat$.needsLookByBindingId[bindingId].peek() === true;
};

/** Operator opened / looked at the seat — clear ready/complete chrome. */
export const markAgentSeatSeen = (bindingId: string | undefined): void => {
  if (!bindingId) return;
  if (agentSeat$.needsLookByBindingId[bindingId].peek() !== true) return;
  agentSeat$.needsLookByBindingId[bindingId].set(false);
};

const isActiveWorkState = (state: AgentSeatState | undefined): boolean =>
  state === "working" || state === "attention";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Strict lifecycle decode — every producer carries one exact generation. */
export const decodeAgentSeatStateEvent = (raw: unknown): AgentSeatStateEvent | undefined => {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.bindingId !== "string" || raw.bindingId.length === 0) return undefined;
  if (!isAgentSeatState(raw.state)) return undefined;
  if (typeof raw.epoch !== "string") return undefined;
  if (raw.confidence !== "high" && raw.confidence !== "low") return undefined;
  if (typeof raw.reason !== "string") return undefined;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
  const confidence: AgentSeatConfidence = raw.confidence;
  const harness = typeof raw.harness === "string" ? raw.harness : undefined;
  return {
    bindingId: raw.bindingId,
    epoch: raw.epoch,
    state: raw.state,
    reason: raw.reason,
    confidence,
    at: raw.at,
    ...(harness ? { harness } : {}),
  };
};

/**
 * Map product seat state → occupancy harness vocabulary.
 *
 * `needsLook` (ready/complete after a turn) is presentation-only — green pulse
 * via `presentationForSeat` / `terminalActivity`. It must not map to harness
 * `attention`, or region rollups and the notify strip treat finished seats
 * as "NEEDS OPERATOR INPUT".
 */
export const harnessFromSeatState = (
  state: AgentSeatState,
  _needsLook = false,
): OccupancyHarnessState => {
  if (state === "attention") return "attention";
  if (state === "working") return "working";
  if (state === "idle") return "idle";
  return "unknown";
};

/** Pure: seat event → occupancy clue (process-bind presence + harness). */
export const clueFromAgentSeat = (
  event: AgentSeatStateEvent | undefined,
  needsLook = false,
): OccupancyClue | undefined => {
  if (!event) return undefined;
  return {
    hasOccupant: event.state !== "gone",
    activity: { harness: harnessFromSeatState(event.state, needsLook) },
    lastSeenAtMs: event.at,
  };
};

/** WorkSurfaceActivity for region rollups / severity ladder. */
export const workSurfaceFromSeat = (
  event: AgentSeatStateEvent | undefined,
  needsLook = false,
): WorkSurfaceActivity | undefined => {
  if (!event) return undefined;
  return {
    session: event.state === "gone" ? "exited" : "running",
    harness: harnessFromSeatState(event.state, needsLook),
    source: "native",
  };
};

const rememberNodeJoin = (bindingId: string, nodeId: string | undefined): void => {
  if (!nodeId) return;
  agentSeat$.bindingIdByNodeId[nodeId].set(bindingId);
};

export const applyAgentSeatStateEvent = (event: AgentSeatStateEvent): void => {
  const current = agentSeat$.byBindingId[event.bindingId].peek();
  if (current && event.at < current.at) return;

  const prevState = current?.state;
  const epochChanged = current !== undefined && current.epoch !== event.epoch;
  let needsLook = agentSeat$.needsLookByBindingId[event.bindingId].peek() === true;

  if (epochChanged || event.state === "gone") {
    // New generation / vacated seat: never inherit a stale ready/complete flag.
    needsLook = false;
  } else if (event.state === "idle" && isActiveWorkState(prevState)) {
    // Finished a turn (working|attention → idle). If the operator is already
    // looking, stay quiet; otherwise arm ready/complete chrome.
    needsLook = !isBindingSurfaceOpen(event.bindingId);
  }

  agentSeat$.byBindingId[event.bindingId].set(event);
  agentSeat$.needsLookByBindingId[event.bindingId].set(needsLook);
  // Inventory join when the session is already cached with a canvas pin.
  const session = terminal$.sessionByBindingId[event.bindingId].peek();
  rememberNodeJoin(event.bindingId, session?.nodeId);
};

/** Document join: ether.terminal.bindingId on a native terminal node. */
export const bindingIdForNode = (node: Pick<CanvasNode, "id" | "ether">): string | undefined => {
  const native = resolveTerminalBinding(node as CanvasNode);
  if (native?.kind === "native") return native.bindingId;
  return agentSeat$.bindingIdByNodeId[node.id].peek();
};

export const seatEventForNode = (
  node: Pick<CanvasNode, "id" | "ether">,
): AgentSeatStateEvent | undefined => {
  const bindingId = bindingIdForNode(node);
  if (!bindingId) return undefined;
  return agentSeat$.byBindingId[bindingId].peek();
};

export const seatEventForBinding = (
  bindingId: string | undefined,
): AgentSeatStateEvent | undefined => {
  if (!bindingId) return undefined;
  return agentSeat$.byBindingId[bindingId].peek();
};

/**
 * Build terminalStatusByNodeId for client region rollups from live seat store
 * + document terminal bindings. Pure given inputs (testable).
 */
export const terminalStatusByNodeIdFromSeats = (
  nodes: ReadonlyArray<Pick<CanvasNode, "id" | "ether">>,
  seats: Readonly<Record<string, AgentSeatStateEvent | undefined>>,
  needsLookByBindingId: Readonly<Record<string, boolean | undefined>> = {},
): Map<string, WorkSurfaceActivity> => {
  const out = new Map<string, WorkSurfaceActivity>();
  for (const node of nodes) {
    const native = resolveTerminalBinding(node as CanvasNode);
    if (native?.kind !== "native") continue;
    const surface = workSurfaceFromSeat(
      seats[native.bindingId],
      needsLookByBindingId[native.bindingId] === true,
    );
    if (surface) out.set(node.id, surface);
  }
  return out;
};

// Singleton fan-out: main snapshot + onAgentSeatStateChanged → agentSeat$.
// Safe to call from App boot and every card mount; only the first call
// actually subscribes. Absent bridge method degrades to a no-op unsubscribe.
let activeUnsubscribe: (() => void) | undefined;

export const subscribeAgentSeatState = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getVellumCommandApi();
  if (!api || typeof api.onAgentSeatStateChanged !== "function") {
    return () => undefined;
  }
  const unsubscribe = api.onAgentSeatStateChanged((raw) => {
    const event = decodeAgentSeatStateEvent(raw);
    if (!event) return;
    applyAgentSeatStateEvent(event);
  });
  let active = true;
  activeUnsubscribe = () => {
    active = false;
    unsubscribe();
    activeUnsubscribe = undefined;
  };

  // Subscribe before reading current state. If a transition races the invoke,
  // applyAgentSeatStateEvent's timestamp guard keeps an older snapshot from
  // replacing the streamed event.
  if (typeof api.agentSeatStateSnapshot === "function") {
    void api.agentSeatStateSnapshot().then(
      (snapshot) => {
        if (!active || !Array.isArray(snapshot)) return;
        for (const raw of snapshot) {
          const event = decodeAgentSeatStateEvent(raw);
          if (event) applyAgentSeatStateEvent(event);
        }
      },
      () => undefined,
    );
  }

  return activeUnsubscribe;
};

/** Test / unmount helper — clear store + allow re-subscribe. */
export const resetAgentSeatState = (): void => {
  agentSeat$.byBindingId.set({});
  agentSeat$.bindingIdByNodeId.set({});
  agentSeat$.needsLookByBindingId.set({});
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = undefined;
  }
};
