/**
 * Managed-agent seat state — renderer store for Phase 3 chrome.
 *
 * Main broadcasts `agentSeatStateChanged` (bindingId-keyed). This module:
 *   1. keeps the latest event per bindingId
 *   2. joins bindingId → canvas nodeId when known (document terminal bind
 *      or terminal inventory session.canvasName/nodeId)
 *   3. feeds occupancy / card chrome (attention amber, working cyan)
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
import { getVellumApi } from "./vellum-api";
import { terminal$ } from "./terminal-state";

export type AgentSeatStore = {
  /** Latest seat event by terminal bindingId. */
  readonly byBindingId: Record<string, AgentSeatStateEvent | undefined>;
  /**
   * Reverse join: canvas nodeId → bindingId when known.
   * Filled from events (via inventory) and document terminal binds on read.
   */
  readonly bindingIdByNodeId: Record<string, string | undefined>;
};

export const agentSeat$ = observable<AgentSeatStore>({
  byBindingId: {},
  bindingIdByNodeId: {},
});

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

/** Map product seat state → occupancy harness vocabulary. */
export const harnessFromSeatState = (state: AgentSeatState): OccupancyHarnessState => {
  if (state === "attention") return "attention";
  if (state === "working") return "working";
  if (state === "idle") return "idle";
  return "unknown";
};

/** Pure: seat event → occupancy clue (process-bind presence + harness). */
export const clueFromAgentSeat = (
  event: AgentSeatStateEvent | undefined,
): OccupancyClue | undefined => {
  if (!event) return undefined;
  return {
    hasOccupant: event.state !== "gone",
    activity: { harness: harnessFromSeatState(event.state) },
    lastSeenAtMs: event.at,
  };
};

/** WorkSurfaceActivity for region rollups / severity ladder. */
export const workSurfaceFromSeat = (
  event: AgentSeatStateEvent | undefined,
): WorkSurfaceActivity | undefined => {
  if (!event) return undefined;
  return {
    session: event.state === "gone" ? "exited" : "running",
    harness: harnessFromSeatState(event.state),
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
  agentSeat$.byBindingId[event.bindingId].set(event);
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
): Map<string, WorkSurfaceActivity> => {
  const out = new Map<string, WorkSurfaceActivity>();
  for (const node of nodes) {
    const native = resolveTerminalBinding(node as CanvasNode);
    if (native?.kind !== "native") continue;
    const surface = workSurfaceFromSeat(seats[native.bindingId]);
    if (surface) out.set(node.id, surface);
  }
  return out;
};

// Singleton fan-out: window.vellum.onAgentSeatStateChanged → agentSeat$.
// Safe to call from App boot and every card mount; only the first call
// actually subscribes. Absent bridge method degrades to a no-op unsubscribe.
let activeUnsubscribe: (() => void) | undefined;

export const subscribeAgentSeatState = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getVellumApi();
  if (!api || typeof api.onAgentSeatStateChanged !== "function") {
    return () => undefined;
  }
  const unsubscribe = api.onAgentSeatStateChanged((raw) => {
    const event = decodeAgentSeatStateEvent(raw);
    if (!event) return;
    applyAgentSeatStateEvent(event);
  });
  activeUnsubscribe = () => {
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  return activeUnsubscribe;
};

/** Test / unmount helper — clear store + allow re-subscribe. */
export const resetAgentSeatState = (): void => {
  agentSeat$.byBindingId.set({});
  agentSeat$.bindingIdByNodeId.set({});
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = undefined;
  }
};
