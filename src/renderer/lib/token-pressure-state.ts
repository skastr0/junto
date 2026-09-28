/**
 * Token pressure as main last read it, one snapshot per running seat, keyed
 * `canvasName::nodeId`. Display only: main owns the reading, the threshold
 * crossing, the nudge, and the rotation.
 */
import { observable } from "@legendapp/state";
import {
  pressureKey,
  type SeatPressureSnapshot,
  type SeatTokenPressure,
  type TokenPressureChange,
} from "@shared/token-pressure";
import { getJuntoApi } from "./junto-api";
import { commitDoc } from "./mutations";
import { state$ } from "./state";

export const tokenPressure$ = observable<{
  readonly bySeat: Record<string, SeatPressureSnapshot>;
}>({ bySeat: {} });

export const applyTokenPressureChange = (change: TokenPressureChange): void => {
  const next = { ...tokenPressure$.bySeat.peek() };
  for (const key of change.removed) delete next[key];
  for (const snapshot of change.upserts) next[pressureKey(snapshot.canvasName, snapshot.nodeId)] = snapshot;
  tokenPressure$.bySeat.set(next);
};

/** One seat's snapshot, or undefined while it is not running. */
export const seatPressureOf = (canvasName: string, nodeId: string): SeatPressureSnapshot | undefined =>
  tokenPressure$.bySeat.get()[pressureKey(canvasName, nodeId)];

let active: (() => void) | undefined;

/** Subscribe first, then hydrate; a later change always wins over the snapshot. */
export const subscribeTokenPressure = (): (() => void) => {
  if (active) return active;
  const api = getJuntoApi();
  if (!api || typeof api.onTokenPressureChanged !== "function") return () => undefined;
  let changed = false;
  const off = api.onTokenPressureChanged((change) => {
    changed = true;
    applyTokenPressureChange(change);
  });
  if (typeof api.tokenPressureSnapshot === "function") {
    void api.tokenPressureSnapshot().then(
      (snapshots) => {
        if (changed || !Array.isArray(snapshots)) return;
        applyTokenPressureChange({ upserts: snapshots, removed: [] });
      },
      () => undefined,
    );
  }
  active = () => {
    off();
    active = undefined;
  };
  return active;
};

/**
 * Set one seat's own limit, or clear it (undefined) so the Settings default
 * applies. Written on the seat's terminal like its harness and session.
 */
export const setSeatTokenPressure = (nodeId: string, value: SeatTokenPressure | undefined): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((node) => {
      const terminal = node.ether?.terminal;
      if (node.id !== nodeId || terminal === undefined) return node;
      const { tokenPressure: _previous, ...rest } = terminal;
      return {
        ...node,
        ether: { ...node.ether, terminal: value === undefined ? rest : { ...rest, tokenPressure: value } },
      };
    }),
  });
};
