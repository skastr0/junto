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
 *   5. derives presentation "done" as idle + needsLook
 *
 * Never writes the canvas. Absent bridge degrades to a no-op subscribe.
 */

import { batch, observable } from "@legendapp/state";
import {
  agentSeatStatusOf,
  encodeAgentSeatStatus,
  isAgentSeatState,
  type AgentSeatStatus,
  type AgentSeatConfidence,
  type AgentSeatState,
  type AgentSeatStateEvent,
} from "@shared/agent-seat-state";
import { deriveNeeds, type Need } from "@shared/harness-domain/need";
import type { OccupancyClue, OccupancyHarnessState } from "@shared/occupancy";
import { terminalBindingOf, type WorkSurfaceActivity } from "@shared/terminal";
import { getJuntoApi } from "./junto-api";
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
   * Cleared by markAgentSeatSeen (open path).
   */
  readonly needsLookByBindingId: Record<string, boolean | undefined>;
  /**
   * When the finished turn behind needsLook ended (the arming event's `at`).
   * Later events for the same seat (a new reason, a reconnect) carry new
   * times but are the same finished turn; this one does not move with them.
   */
  readonly doneAtByBindingId: Record<string, number | undefined>;
  /**
   * The snapshot from main has been applied. Until then an empty store means
   * "not loaded yet", not "every seat is idle", so nothing may be heard
   * from its seats appearing.
   */
  readonly hydrated: boolean;
  /**
   * Monotonic apply counter. Nested Legend writes on `byBindingId[id]` can
   * keep the parent object identity, so React `use$(byBindingId)` effects miss
   * in-place working→idle flips. Depend on `rev` instead.
   */
  readonly rev: number;
};

export const agentSeat$ = observable<AgentSeatStore>({
  byBindingId: {},
  bindingIdByNodeId: {},
  needsLookByBindingId: {},
  doneAtByBindingId: {},
  hydrated: false,
  rev: 0,
});

/** Product presentation: engine states plus derived ready/complete. */
export type AgentSeatPresentation = AgentSeatState | "done";

/** Every binding with a native terminal surface open, sorted. */
export const openSurfaceBindingIds = (
  open: Readonly<Record<string, Parameters<typeof terminalBindingOf>[0]>>,
  bindingIdByNodeId: Readonly<Record<string, string | undefined>>,
): string[] => {
  const ids = new Set<string>();
  for (const [nodeId, node] of Object.entries(open)) {
    if (!node) continue;
    const bindingId = terminalBindingOf(node)?.bindingId;
    if (bindingId) ids.add(bindingId);
    // Inventory join: nodeId → binding when surface was opened via node id key.
    const joined = bindingIdByNodeId[nodeId];
    if (joined) ids.add(joined);
  }
  return [...ids].sort();
};

/** True when a native terminal surface is open for this binding. */
export const isBindingSurfaceOpen = (bindingId: string): boolean =>
  openSurfaceBindingIds(terminal$.openByNodeId.peek(), agentSeat$.bindingIdByNodeId.peek()).includes(bindingId);

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
  tellMainViewed(bindingId);
  if (agentSeat$.needsLookByBindingId[bindingId].peek() !== true) return;
  agentSeat$.needsLookByBindingId[bindingId].set(false);
  agentSeat$.doneAtByBindingId[bindingId].set(undefined);
};

/** Main keeps the seat's unseen turn; a view from this window clears it there. */
const tellMainViewed = (bindingId: string): void => {
  const viewed = getJuntoApi()?.agentSeatViewed;
  if (typeof viewed === "function") void viewed(bindingId).catch(() => undefined);
};

/** When the seat's unread finished turn ended, if it has one. */
export const seatDoneAt = (bindingId: string | undefined): number | undefined =>
  bindingId ? agentSeat$.doneAtByBindingId[bindingId].peek() : undefined;

/**
 * Prompt-box idle reasons — the seat settled at a live composer prompt box.
 * A working→idle flip that lands here is a TITLE RESTORE, not a finished
 * turn: the harness repaints the prompt box whenever the title reverts
 * (braille → ✳), and an unsubmitted chip/draft may still sit in the box.
 * needsLook ("done — waiting for review") arms only when the seat settles on
 * its canonical non-composer idle (OSC title / OSC9 / hook / footer), which
 * is what a real turn end publishes.
 */
const isPromptBoxIdleReason = (reason: string): boolean =>
  reason.includes("prompt_box") ||
  reason.includes("composer") ||
  // Deterministic-protocol idle (OSC 9;4;0 → hook/rule osc9_idle): the
  // harness's idle flag also fires on title-restore repaints of the composer,
  // which is the false-flip shape (braille → ✳). Done chrome must not ride it.
  reason.includes("osc9_idle");

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
  // Whether a seat of another machine's reading is current, as the core serves it.
  const current = typeof raw.current === "boolean" ? raw.current : undefined;
  // The status is kept only when it reads as the harness domain says.
  const status = agentSeatStatusOf({ status: raw.status as never });
  return {
    bindingId: raw.bindingId,
    epoch: raw.epoch,
    state: raw.state,
    reason: raw.reason,
    confidence,
    at: raw.at,
    ...(harness ? { harness } : {}),
    ...(status === undefined ? {} : { status: encodeAgentSeatStatus(status) }),
    ...(current === undefined ? {} : { current }),
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
  const needs = seatNeedsOf(event);
  return {
    hasOccupant: event.state !== "gone",
    activity: { harness: harnessFromSeatState(event.state, needsLook) },
    ...(needs ? { needs } : {}),
    lastSeenAtMs: event.at,
  };
};

/** WorkSurfaceActivity for region rollups / severity ladder. */
export const workSurfaceFromSeat = (
  event: AgentSeatStateEvent | undefined,
  needsLook = false,
): WorkSurfaceActivity | undefined => {
  if (!event) return undefined;
  // needsLook stays out of the harness state (see harnessFromSeatState) and
  // travels as `ready`, so the region ladder can show finished seats without
  // any needs-input surface mistaking them for attention.
  const ready = event.state === "idle" && needsLook;
  return {
    session: event.state === "gone" ? "exited" : "running",
    harness: harnessFromSeatState(event.state, needsLook),
    ...(ready ? { ready: true } : {}),
    source: "native",
  };
};

const rememberNodeJoin = (bindingId: string, nodeId: string | undefined): void => {
  if (!nodeId) return;
  agentSeat$.bindingIdByNodeId[nodeId].set(bindingId);
};

/**
 * Write one event's fields and tell no one; applyAgentSeatStateEvents does the
 * telling. Answers whether the store took it: an event older than the one
 * held is left out.
 */
const writeSeatEvent = (event: AgentSeatStateEvent): boolean => {
  const current = agentSeat$.byBindingId[event.bindingId].peek();
  if (current && event.at < current.at) return false;

  const prevState = current?.state;
  const epochChanged = current !== undefined && current.epoch !== event.epoch;
  let needsLook = agentSeat$.needsLookByBindingId[event.bindingId].peek() === true;
  // A turn ends only on the two arming edges below; any other event, the
  // same idle re-sent included, leaves the finished turn where it was.
  let turnEnded = false;

  if (epochChanged || event.state === "gone") {
    // New generation / vacated seat: never inherit a stale ready/complete flag.
    needsLook = false;
  } else if (event.state === "idle" && prevState === "attention") {
    // Real product state (stall / needs-input) resolved — keep the existing
    // arm: attention is never a title artifact.
    needsLook = !isBindingSurfaceOpen(event.bindingId);
    turnEnded = needsLook;
  } else if (event.state === "idle" && prevState === "working") {
    // Finished a turn (working → idle). A working event that ends on a
    // prompt-box idle is a false title flip (composer back at the prompt,
    // nothing submitted) — done chrome must not ride it. If the operator is
    // already looking, stay quiet; otherwise arm ready/complete chrome.
    needsLook =
      !isPromptBoxIdleReason(event.reason) &&
      !isBindingSurfaceOpen(event.bindingId);
    turnEnded = needsLook;
  }

  // A turn that ends while the operator is already looking is seen.
  if (agentSeatStatusOf(event)?.snapshot.turnUnseen !== undefined && isBindingSurfaceOpen(event.bindingId)) {
    tellMainViewed(event.bindingId);
  }
  agentSeat$.byBindingId[event.bindingId].set(event);
  agentSeat$.needsLookByBindingId[event.bindingId].set(needsLook);
  if (!needsLook) agentSeat$.doneAtByBindingId[event.bindingId].set(undefined);
  else if (turnEnded) agentSeat$.doneAtByBindingId[event.bindingId].set(event.at);
  // Inventory join when the session is already cached with a canvas pin.
  const session = terminal$.sessionByBindingId[event.bindingId].peek();
  rememberNodeJoin(event.bindingId, session?.nodeId);
  return true;
};

/**
 * Apply seat events, oldest first, as one change.
 *
 * Every field of every event is written before any reader is told. A reader
 * woken by a finished turn finds its needsLook and doneAt already decided,
 * and a burst wakes each reader once, not once per field of each event.
 */
export const applyAgentSeatStateEvents = (events: ReadonlyArray<AgentSeatStateEvent>): void => {
  batch(() => {
    let taken = false;
    for (const event of events) taken = writeSeatEvent(event) || taken;
    if (taken) agentSeat$.rev.set(agentSeat$.rev.peek() + 1);
  });
};

export const applyAgentSeatStateEvent = (event: AgentSeatStateEvent): void =>
  applyAgentSeatStateEvents([event]);

export const seatEventForBinding = (
  bindingId: string | undefined,
): AgentSeatStateEvent | undefined => {
  if (!bindingId) return undefined;
  // The raw record, not a child observable: the same untracked value without
  // a proxy walk per seat, which every feed build paid for every seat.
  return agentSeat$.byBindingId.peek()[bindingId];
};

/**
 * The seat's status in the harness-domain vocabulary (snapshot and most
 * urgent need), decoded from its latest event; undefined before one carries it.
 */
export const seatStatusForBinding = (
  bindingId: string | undefined,
): AgentSeatStatus | undefined => agentSeatStatusOf(seatEventForBinding(bindingId));

/**
 * A seat's needs, most urgent first, from its latest event's snapshot: main
 * folds the seat's declared signals and whether the operator has seen its
 * finished turn into it. Undefined before an event carries a snapshot, as
 * for a seat on another machine (seats-link sends no status yet); callers
 * fall back to the harness state there.
 */
export const seatNeedsOf = (event: AgentSeatStateEvent | undefined): readonly Need[] | undefined => {
  const status = agentSeatStatusOf(event);
  return status ? deriveNeeds(status.snapshot) : undefined;
};

// --- arrival -------------------------------------------------------------------
//
// Main sends one message per seat event, and a board reports in bursts: a
// pause, a broadcast, a link coming back. Each message is its own task.
// Applied as it came, each event was its own round of notifications and its
// own React commit, back to back, with React's scheduler queued behind every
// message. React counts a commit that leaves an update pending as a nested
// update and refuses the 51st in a row ("Maximum update depth exceeded"), so
// one component that set state from an effect on each event made a later
// event throw from inside the store's notification, and the readers after it,
// the canvas feed among them, never heard that event.
//
// So events wait for the next turn of the event loop and are applied
// together: a burst is one change and one commit, and the scheduler has had
// its turn before the next. The turn is a message channel, not a timer: a
// timer is slowed in a window no one is looking at, and notifications are
// raised from this state.

const arrived: AgentSeatStateEvent[] = [];
let turnAsked = false;
let turnChannel: MessageChannel | undefined;
let turnTimer: ReturnType<typeof setTimeout> | undefined;

/** Apply what has arrived, in the order it came. */
const applyArrived = (): void => {
  turnAsked = false;
  turnTimer = undefined;
  if (arrived.length === 0) return;
  applyAgentSeatStateEvents(arrived.splice(0, arrived.length));
};

const askTurn = (): void => {
  if (turnAsked) return;
  turnAsked = true;
  if (typeof MessageChannel !== "function") {
    turnTimer = setTimeout(applyArrived, 0);
    return;
  }
  if (turnChannel === undefined) {
    turnChannel = new MessageChannel();
    turnChannel.port1.onmessage = applyArrived;
  }
  turnChannel.port2.postMessage(undefined);
};

/** Forget what has arrived and not been applied; a turn already asked for finds nothing. */
const dropArrived = (): void => {
  arrived.length = 0;
  turnAsked = false;
  if (turnTimer !== undefined) clearTimeout(turnTimer);
  turnTimer = undefined;
  turnChannel?.port1.close();
  turnChannel = undefined;
};

// Singleton fan-out: main snapshot + onAgentSeatStateChanged → agentSeat$.
// Safe to call from App boot and every card mount; only the first call
// actually subscribes. Absent bridge method degrades to a no-op unsubscribe.
let activeUnsubscribe: (() => void) | undefined;

export const subscribeAgentSeatState = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getJuntoApi();
  if (!api || typeof api.onAgentSeatStateChanged !== "function") {
    return () => undefined;
  }
  const unsubscribe = api.onAgentSeatStateChanged((raw) => {
    const event = decodeAgentSeatStateEvent(raw);
    if (!event) return;
    arrived.push(event);
    askTurn();
  });
  let active = true;
  activeUnsubscribe = () => {
    active = false;
    unsubscribe();
    dropArrived();
    activeUnsubscribe = undefined;
  };

  // Subscribe before reading current state. If a transition races the invoke,
  // the timestamp guard keeps an older snapshot from replacing the streamed
  // event: what streamed in while the snapshot was read arrived first, so it
  // is applied first.
  if (typeof api.agentSeatStateSnapshot === "function") {
    void api.agentSeatStateSnapshot().then(
      (snapshot) => {
        if (!active) return;
        applyArrived();
        if (Array.isArray(snapshot)) {
          const events: AgentSeatStateEvent[] = [];
          for (const raw of snapshot) {
            const event = decodeAgentSeatStateEvent(raw);
            if (event) events.push(event);
          }
          applyAgentSeatStateEvents(events);
        }
        agentSeat$.hydrated.set(true);
      },
      // No snapshot to wait for: what streams in from here is live.
      () => {
        if (active) agentSeat$.hydrated.set(true);
      },
    );
  } else {
    agentSeat$.hydrated.set(true);
  }

  return activeUnsubscribe;
};

/** Test / unmount helper — clear store + allow re-subscribe. */
export const resetAgentSeatState = (): void => {
  dropArrived();
  agentSeat$.byBindingId.set({});
  agentSeat$.bindingIdByNodeId.set({});
  agentSeat$.needsLookByBindingId.set({});
  agentSeat$.doneAtByBindingId.set({});
  agentSeat$.hydrated.set(false);
  agentSeat$.rev.set(0);
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = undefined;
  }
};
