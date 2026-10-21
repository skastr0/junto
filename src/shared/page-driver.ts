import type { NodeId } from "./model/base";

/**
 * Who is driving a page node (plan 06). The operator and the seats connected
 * to the page act on the same live view, so the page carries one control
 * state for all of them:
 *
 * - `shared`: any seat with a grant may act; the operator watches or acts too.
 * - `operator-held`: the operator took over. Every seat action is refused
 *   with `operator_holds`, and a seat action already running is aborted by
 *   main. The seat keeps its edge and grant, so release resumes without a
 *   new admission.
 *
 * The mark the window shows is derived from the last actor: a seat with an
 * action running or one within `DRIVER_RECENT_MS` reads as driving.
 */

/** A seat that acted this recently still reads as driving. */
export const DRIVER_RECENT_MS = 8_000;

export type PageControl =
  | { readonly kind: "shared" }
  | { readonly kind: "operator-held"; readonly since: number };

export type PageActor =
  | { readonly kind: "none" }
  | { readonly kind: "operator"; readonly at: number }
  | { readonly kind: "seat"; readonly nodeId: NodeId; readonly at: number; readonly running: number };

export interface PageDriving {
  readonly control: PageControl;
  readonly last: PageActor;
}

export type PageDrivingEvent =
  | { readonly kind: "seat-start"; readonly nodeId: NodeId; readonly at: number }
  | { readonly kind: "seat-end"; readonly nodeId: NodeId; readonly at: number }
  | { readonly kind: "operator-act"; readonly at: number }
  | { readonly kind: "take-over"; readonly at: number }
  | { readonly kind: "release"; readonly at: number };

export type SeatAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: { readonly kind: "operator_holds"; readonly since: number } };

/** What the page chrome and the page card show. */
export type DriverMark =
  | { readonly kind: "idle" }
  | { readonly kind: "operator-held"; readonly since: number }
  | { readonly kind: "seat"; readonly nodeId: NodeId; readonly running: boolean }
  | { readonly kind: "operator" };

export const initialPageDriving: PageDriving = { control: { kind: "shared" }, last: { kind: "none" } };

/** Pure: may this seat act on the page now. */
export const admitSeat = (state: PageDriving): SeatAdmission =>
  state.control.kind === "operator-held"
    ? { ok: false, refusal: { kind: "operator_holds", since: state.control.since } }
    : { ok: true };

const assertNever = (value: never): never => {
  throw new Error(`unknown page driving event: ${JSON.stringify(value)}`);
};

/**
 * Pure: one event applied. A seat start while the operator holds the page is
 * the caller's bug (admission refuses it first), so it leaves state as is.
 */
export const reducePageDriving = (state: PageDriving, event: PageDrivingEvent): PageDriving => {
  switch (event.kind) {
    case "seat-start": {
      if (state.control.kind === "operator-held") return state;
      const running = state.last.kind === "seat" && state.last.nodeId === event.nodeId ? state.last.running + 1 : 1;
      return { ...state, last: { kind: "seat", nodeId: event.nodeId, at: event.at, running } };
    }
    case "seat-end": {
      if (state.last.kind !== "seat" || state.last.nodeId !== event.nodeId) return state;
      return { ...state, last: { ...state.last, at: event.at, running: Math.max(0, state.last.running - 1) } };
    }
    case "operator-act":
      return { ...state, last: { kind: "operator", at: event.at } };
    case "take-over":
      return state.control.kind === "operator-held"
        ? state
        : { control: { kind: "operator-held", since: event.at }, last: { kind: "operator", at: event.at } };
    case "release":
      return { ...state, control: { kind: "shared" } };
    default:
      return assertNever(event);
  }
};

/** Pure: the mark for the page at `now`. */
export const driverMark = (state: PageDriving, now: number): DriverMark => {
  if (state.control.kind === "operator-held") return { kind: "operator-held", since: state.control.since };
  const last = state.last;
  switch (last.kind) {
    case "none":
      return { kind: "idle" };
    case "operator":
      return { kind: "operator" };
    case "seat": {
      const running = last.running > 0;
      return running || now - last.at < DRIVER_RECENT_MS
        ? { kind: "seat", nodeId: last.nodeId, running }
        : { kind: "idle" };
    }
    default:
      return assertNever(last);
  }
};
