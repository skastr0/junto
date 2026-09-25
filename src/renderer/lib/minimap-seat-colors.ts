/**
 * Minimap colours by seat health: each agent seat is painted with its
 * `seatRollup` tone (declared signal, proven attention, Jev's reading, control
 * state), the same order its ring and name line use. Everything else keeps the
 * existing severity and identity colours.
 *
 * Cost: the rollups are derived in one selector that returns a compact key,
 * so the minimap re-renders only when some seat's tone actually changes, not
 * on every awareness window event. The minimap then recolours in the pass it
 * already runs when its colour callbacks change; there is no per-frame work.
 */

import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentSignalKind, SeatSignalRollup } from "@shared/agent-signals";
import type { MemberSeverity } from "@shared/region-rollup";
import { bindingIdForNode } from "./agent-seat-state";
import { seatSignalRollups$ } from "./agent-signals-state";
import { activityToneHex, minimapFill, signalMark } from "./signal-mark";
import { seatAwareness$ } from "./seat-awareness";
import { seatRollup, type SeatRollup, type SeatRollupTone } from "./seat-rollup";
import { state$ } from "./state";
import { threadHealthMark, threadHealthView, useHealthClock } from "./thread-health";
import { withAlpha } from "./theme";

/** A faded Jev reading, as the ring draws it. */
const STALE_FILL_ALPHA = 0.45;

const isAgentSeat = (node: CanvasNode): boolean =>
  node.type !== "group" && node.ether?.entity?.kind === "agent";

export const rollupToneHex = (tone: SeatRollupTone): string => activityToneHex(tone);

/** Fill and outline for one minimap rectangle. */
export const minimapNodeColors = (
  node: CanvasNode | undefined,
  severity: MemberSeverity | undefined,
  seat: SeatRollup | undefined,
  ground: string,
): { readonly fill: string; readonly stroke: string } => {
  if (seat !== undefined) {
    const hue = rollupToneHex(seat.tone);
    return { fill: seat.stale ? withAlpha(hue, STALE_FILL_ALPHA) : hue, stroke: hue };
  }
  return {
    fill: minimapFill(node, severity),
    stroke: severity && severity !== "idle" ? signalMark(severity).hue : withAlpha(ground, 0.85),
  };
};

/** Every agent seat's rollup at `now`, from the three stores' current values. */
export const seatRollupsForNodes = (
  nodes: ReadonlyArray<CanvasNode>,
  input: {
    readonly now: number;
    readonly severityByNodeId: Readonly<Record<string, string>>;
    readonly signalsByNodeId: Readonly<Record<string, SeatSignalRollup | undefined>>;
    readonly bindingOf?: (node: CanvasNode) => string | undefined;
  },
): ReadonlyMap<string, SeatRollup> => {
  const bindingOf = input.bindingOf ?? bindingIdForNode;
  const out = new Map<string, SeatRollup>();
  for (const node of nodes) {
    if (!isAgentSeat(node)) continue;
    const signal: AgentSignalKind | undefined = input.signalsByNodeId[node.id]?.kind;
    const view = threadHealthView(bindingOf(node), input.now);
    const health =
      view === undefined
        ? undefined
        : threadHealthMark(view.reading, { now: input.now, freshness: view.freshness, signal });
    const rollup = seatRollup({
      signal,
      control: input.severityByNodeId[node.id] as MemberSeverity | undefined,
      health,
    });
    if (rollup !== undefined) out.set(node.id, rollup);
  }
  return out;
};

const encode = (rollups: ReadonlyMap<string, SeatRollup>): string => {
  const parts: string[] = [];
  for (const [id, r] of rollups) parts.push(`${id}\u0001${r.source}\u0001${r.tone}\u0001${r.stale ? 1 : 0}\u0001${r.reason}`);
  return parts.join("\u0002");
};

const decode = (key: string): ReadonlyMap<string, SeatRollup> => {
  const out = new Map<string, SeatRollup>();
  if (key === "") return out;
  for (const part of key.split("\u0002")) {
    const [id, source, tone, stale, reason] = part.split("\u0001");
    if (!id || !source || !tone) continue;
    out.set(id, {
      source: source as SeatRollup["source"],
      tone: tone as SeatRollupTone,
      stale: stale === "1",
      reason: reason ?? "",
    });
  }
  return out;
};

/**
 * Seat rollups for the open canvas, keyed by node id. The selector returns a
 * string, so a store change that leaves every seat's tone where it was (a new
 * awareness window, an unrelated document edit) does not re-render the caller.
 */
export const useSeatRollups = (): ReadonlyMap<string, SeatRollup> => {
  const now = useHealthClock();
  const key = use$(() => {
    seatAwareness$.rev.get();
    return encode(
      seatRollupsForNodes(state$.doc.get().nodes, {
        now,
        severityByNodeId: state$.regionSeverityByNodeId.get(),
        signalsByNodeId: seatSignalRollups$.get(),
      }),
    );
  });
  return useMemo(() => decode(key), [key]);
};
