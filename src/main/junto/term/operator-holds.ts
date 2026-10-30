/**
 * The operator's holds on seats, kept where the cut at the cache window can ask:
 * the core, which runs the seats. A seat is held while any window shows its
 * terminal, and for OPERATOR_TYPING_GRACE_MS after the operator's last key into
 * it.
 *
 * Holds are kept per window and per binding. A window says which bindings it
 * shows as a whole list each time it changes, so a missed message heals at the
 * next one. A window that closes, crashes or reloads drops every hold it had,
 * typing included. The window's reports reach these holds from main by
 * core.call (core-process/ops/seat-holds.ts, term/operator-holds-ipc.ts).
 *
 * A seat that runs on another machine is cut there, so its holds cross the
 * link: the views of it (seat-views.ts) send each change as a Hold, and the
 * seat's machine adds what its peers hold (seat-attach.ts) as a hold source.
 */
import { OPERATOR_TYPING_GRACE_MS } from "@shared/operator-hold";

type WindowHolds = {
  open: ReadonlySet<string>;
  readonly typedAt: Map<string, number>;
};

/**
 * The operator holds a seat: shown in a window (no `until`: it lasts until the
 * window lets go), or typed into, lasting `until` the typing grace ends. A
 * shown seat typed into too says when that typing's grace ends
 * (`typedUntil`), for what counts typing alone.
 */
export type OperatorHold = { readonly until?: number; readonly typedUntil?: number };

/** When the operator's typing alone holds the seat until, shown or not. */
export const typingUntil = (hold: OperatorHold | undefined): number | undefined => hold?.until ?? hold?.typedUntil;

const latest = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined ? right : right === undefined ? left : Math.max(left, right);

/** The longer of two holds: shown outlasts any typing, and keeps the latest typing's grace. */
export const longerHold = (left: OperatorHold | undefined, right: OperatorHold | undefined): OperatorHold | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const typed = latest(typingUntil(left), typingUntil(right));
  if (left.until === undefined || right.until === undefined) return typed === undefined ? {} : { typedUntil: typed };
  return { until: Math.max(left.until, right.until) };
};

/** A binding's hold changed: shown in some window or not, or typed into just now. */
export type OperatorHoldChange = { readonly bindingId: string; readonly open: boolean; readonly typed: boolean };

export type OperatorHolds = {
  /** The bindings one window shows now, replacing what it said before. */
  readonly surfaces: (windowId: number, bindingIds: ReadonlyArray<string>) => void;
  /** The operator typed into a binding's terminal in one window. */
  readonly typed: (windowId: number, bindingId: string) => void;
  /** The window closed or reloaded: every hold it had goes. */
  readonly dropWindow: (windowId: number) => void;
  /** The operator's hold on the seat at `now`, if any. Reads only. */
  readonly hold: (bindingId: string, now: number) => OperatorHold | undefined;
  /** Whether the operator holds the seat at `now`. Reads only. */
  readonly holds: (bindingId: string, now: number) => boolean;
  /** Whether some window shows the binding's terminal. */
  readonly shows: (bindingId: string) => boolean;
  /** Told when a binding comes to be shown or stops being shown anywhere, and on every key report. */
  readonly subscribe: (listener: (change: OperatorHoldChange) => void) => () => void;
};

/** What the window reports, and all main knows of the holds: they are kept here. */
export type OperatorHoldReports = Pick<OperatorHolds, "surfaces" | "typed" | "dropWindow">;

export const makeOperatorHolds = (clock: () => number = Date.now): OperatorHolds => {
  const windows = new Map<number, WindowHolds>();
  const listeners = new Set<(change: OperatorHoldChange) => void>();
  const emit = (change: OperatorHoldChange): void => {
    for (const listener of listeners) listener(change);
  };
  const shows = (bindingId: string): boolean => {
    for (const held of windows.values()) if (held.open.has(bindingId)) return true;
    return false;
  };
  /** Run a change to the windows, then tell each binding whose shown-anywhere flipped. */
  const reshow = (touched: Iterable<string>, change: () => void): void => {
    const before = new Map<string, boolean>();
    for (const bindingId of touched) before.set(bindingId, shows(bindingId));
    change();
    for (const [bindingId, was] of before) {
      const open = shows(bindingId);
      if (open !== was) emit({ bindingId, open, typed: false });
    }
  };
  const hold = (bindingId: string, now: number): OperatorHold | undefined => {
    let longest: OperatorHold | undefined;
    for (const held of windows.values()) {
      if (held.open.has(bindingId)) longest = longerHold(longest, {});
      const at = held.typedAt.get(bindingId);
      if (at !== undefined && now - at < OPERATOR_TYPING_GRACE_MS)
        longest = longerHold(longest, { until: at + OPERATOR_TYPING_GRACE_MS });
    }
    return longest;
  };
  const windowOf = (windowId: number): WindowHolds => {
    let held = windows.get(windowId);
    if (held === undefined) {
      held = { open: new Set(), typedAt: new Map() };
      windows.set(windowId, held);
    }
    return held;
  };
  return {
    surfaces: (windowId, bindingIds) => {
      const held = windowOf(windowId);
      const next = new Set(bindingIds);
      reshow([...held.open, ...next], () => { held.open = next; });
    },
    typed: (windowId, bindingId) => {
      windowOf(windowId).typedAt.set(bindingId, clock());
      emit({ bindingId, open: shows(bindingId), typed: true });
    },
    dropWindow: (windowId) => {
      const held = windows.get(windowId);
      if (held !== undefined) reshow(held.open, () => { windows.delete(windowId); });
    },
    hold,
    holds: (bindingId, now) => hold(bindingId, now) !== undefined,
    shows,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};

const live = makeOperatorHolds();
/** The live holds of this process, for the cut, the views that carry them to a seat's own machine, and the reports from the window. */
export const liveOperatorHolds: OperatorHolds = live;

const typedListeners = new Set<(bindingId: string) => void>();
/**
 * The operator typed into a binding's terminal: in a window here, or in a
 * peer's view of a seat this machine runs (seat-attach.ts). A key warms the
 * seat's session at its cache window.
 */
export const noteOperatorTyped = (bindingId: string): void => {
  for (const listener of typedListeners) listener(bindingId);
};
export const subscribeOperatorTyped = (listener: (bindingId: string) => void): (() => void) => {
  typedListeners.add(listener);
  return () => { typedListeners.delete(listener); };
};
live.subscribe((change) => {
  if (change.typed) noteOperatorTyped(change.bindingId);
});

/** Holds kept elsewhere: what this machine's peers hold on the seats it runs. */
export type OperatorHoldSource = (bindingId: string, now: number) => OperatorHold | undefined;
const sources = new Set<OperatorHoldSource>();
export const addOperatorHoldSource = (source: OperatorHoldSource): (() => void) => {
  sources.add(source);
  return () => { sources.delete(source); };
};

/**
 * The operator's hold on the seat on this binding, from a window here or from
 * the machine that edits its canvas: the longest of them.
 */
export const operatorHold = (bindingId: string, now: number): OperatorHold | undefined => {
  let longest = live.hold(bindingId, now);
  for (const source of sources) longest = longerHold(longest, source(bindingId, now));
  return longest;
};

/**
 * Whether the operator is viewing or has just typed into the seat. The cut at
 * the cache window leaves a held seat's session alone.
 */
export const operatorHolds = (bindingId: string, now: number): boolean => operatorHold(bindingId, now) !== undefined;

/**
 * When the operator's hold on the seat ends, when only typing holds it.
 * Undefined while a window shows the seat (its close is when), or when
 * nothing holds it.
 */
export const operatorHeldUntil = (bindingId: string, now: number): number | undefined =>
  operatorHold(bindingId, now)?.until;
