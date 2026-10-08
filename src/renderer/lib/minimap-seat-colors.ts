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
import type { Node } from "@shared/model";
import { nodesOf, regionMembers, type NodeOf, type Placed } from "@shared/model";
import type { AgentSignalKind, SeatSignalRollup } from "@shared/agent-signals";
import type { MemberSeverity } from "@shared/region-rollup";
import { seatSignalRollups$ } from "./agent-signals-state";
import { activityToneHex, identityHueOf, signalMark } from "./signal-mark";
import { seatAwareness$ } from "./seat-awareness";
import { seatRollup, worseRollup, type SeatRollup, type SeatRollupTone } from "./seat-rollup";
import { state$ } from "./state";
import { modelStore } from "./use-model";
import { threadHealthMark, threadHealthView, useHealthClock } from "./thread-health";
import { withAlpha } from "./theme";

/** A faded Jev reading, as the ring draws it. */
const STALE_FILL_ALPHA = 0.45;
/** A region is a tint of its worst member, never a solid block over them. */
const REGION_FILL_ALPHA = 0.3;
const STALE_REGION_FILL_ALPHA = 0.16;
/**
 * An agent seat with nothing to say keeps its identity hue, a little quieter:
 * agents are orange, which sits beside the amber of a seat in trouble. On the
 * map a seat is a dot rimmed in the ground, and an urgent one also wears a
 * rim in its state's colour and pings (FactoryMinimap), so a quiet seat can
 * stay visible without reading as a warning.
 */
const QUIET_SEAT_FILL_ALPHA = 0.7;

export const rollupToneHex = (tone: SeatRollupTone): string => activityToneHex(tone);

/** Fill and outline for one minimap rectangle. */
export const minimapNodeColors = (
  node: Node | undefined,
  severity: MemberSeverity | undefined,
  seat: SeatRollup | undefined,
  ground: string,
): { readonly fill: string; readonly stroke: string } => {
  if (seat !== undefined) {
    const hue = rollupToneHex(seat.tone);
    if (node?.kind === "region") {
      return { fill: withAlpha(hue, seat.stale ? STALE_REGION_FILL_ALPHA : REGION_FILL_ALPHA), stroke: hue };
    }
    return { fill: seat.stale ? withAlpha(hue, STALE_FILL_ALPHA) : hue, stroke: hue };
  }
  const quietSeat = node?.kind === "agent" && (severity === undefined || severity === "idle");
  const mark = signalMark(severity);
  const fill = mark.kind === "idle" ? identityHueOf(node) : mark.hue;
  return {
    fill: quietSeat ? withAlpha(fill, QUIET_SEAT_FILL_ALPHA) : fill,
    stroke: severity && severity !== "idle" ? signalMark(severity).hue : withAlpha(ground, 0.85),
  };
};

/**
 * Every agent seat's rollup at `now`, from the three stores' current values,
 * plus each region that holds at least one: the worse of the region's own
 * control severity and its worst member seat (membership is the canvas's own,
 * full-rect containment). A region with no rolled-up seat keeps its colours.
 */
export const seatRollupsForCanvas = (
  canvas: Placed,
  input: {
    readonly now: number;
    readonly severityByNodeId: Readonly<Record<string, string>>;
    readonly signalsByNodeId: Readonly<Record<string, SeatSignalRollup | undefined>>;
    /** The session a seat's thread health is read from; its own by default. */
    readonly bindingOf?: (seat: NodeOf<"agent">) => string | undefined;
  },
): ReadonlyMap<string, SeatRollup> => {
  const bindingOf = input.bindingOf ?? ((seat: NodeOf<"agent">) => seat.bindingId);
  const out = new Map<string, SeatRollup>();
  for (const node of nodesOf(canvas, "agent")) {
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
  if (out.size === 0) return out;
  const regions = new Map<string, SeatRollup>();
  for (const region of nodesOf(canvas, "region")) {
    let worst: SeatRollup | undefined;
    for (const member of regionMembers(canvas, region)) worst = worseRollup(worst, out.get(member.id));
    if (worst === undefined) continue;
    const own = seatRollup({ control: input.severityByNodeId[region.id] as MemberSeverity | undefined });
    regions.set(region.id, worseRollup(own, worst)!);
  }
  for (const [id, rollup] of regions) out.set(id, rollup);
  return out;
};

/** Rollups as one string, so a selector can answer them and be compared by value. */
export const encodeRollups = (rollups: ReadonlyMap<string, SeatRollup>): string => {
  const parts: string[] = [];
  for (const [id, r] of rollups) parts.push(`${id}\u0001${r.source}\u0001${r.tone}\u0001${r.stale ? 1 : 0}\u0001${r.reason}`);
  return parts.join("\u0002");
};

export const decodeRollups = (key: string): ReadonlyMap<string, SeatRollup> => {
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
 * awareness window, a card moved where no region gains or loses it) does not
 * re-render the caller.
 */
export const useSeatRollups = (): ReadonlyMap<string, SeatRollup> => {
  const now = useHealthClock();
  const key = use$(() => {
    seatAwareness$.rev.get();
    const canvasName = state$.canvasName.get();
    // Follow the canvas's nodes: a rollup reads which seats there are and
    // which regions hold them.
    modelStore.canvas$(canvasName).nodes.get();
    return encodeRollups(
      seatRollupsForCanvas(modelStore.canvasOf(canvasName), {
        now,
        severityByNodeId: state$.regionSeverityByNodeId.get(),
        signalsByNodeId: seatSignalRollups$.get(),
      }),
    );
  });
  return useMemo(() => decodeRollups(key), [key]);
};
