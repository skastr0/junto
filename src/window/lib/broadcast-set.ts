/**
 * The seats a Broadcast choice reaches, as this window reads them now. The
 * function that says who is reached is shared (shared/broadcast.ts); this
 * feeds it what the window holds: the canvas, each seat's last state event,
 * the open signals, and whether the seat's machine can be read.
 *
 * A seat on this machine is always current. A seat on another machine is
 * current only with an event in hand and its machine neither unreachable nor
 * asleep, as last asked; otherwise a doing limit cannot hold it, so it comes
 * back apart as unread (never dropped, never guessed). The set is recomputed
 * as seats change state, signals change, the canvas changes or a machine's
 * reach is read again.
 */
import { use$ } from "@legendapp/state/react";
import { useMemo } from "react";
import { broadcastSet, seatReading, type BroadcastPick, type BroadcastSet, type SeatReading } from "@shared/broadcast";
import { asNodeId } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import { agentSeat$, seatEventForBinding } from "./agent-seat-state";
import { agentSignals$ } from "./agent-signals-state";
import { isOnMachine } from "./machines";
import { state$ } from "./state";
import { useCanvas } from "./use-model";
import type { RegionPick } from "./quick-thread-broadcast";

export const picksOf = (seats: ReadonlyArray<string>, regions: ReadonlyArray<RegionPick>): ReadonlyArray<BroadcastPick> => [
  ...seats.map((nodeId): BroadcastPick => ({ kind: "seat", nodeId })),
  ...regions.map((region): BroadcastPick => ({ kind: "region", regionId: region.regionId, doing: region.doing, needs: region.needs })),
];

/** Read the set now from what the window holds. Pure over its inputs, so a test can hand it any of them. */
export const readBroadcastSet = (input: {
  readonly canvasName: string;
  readonly canvas: Canvas;
  readonly picks: ReadonlyArray<BroadcastPick>;
  readonly machineName: string;
  readonly signals: Parameters<typeof seatReading>[0]["signals"];
  readonly eventOf: (bindingId: string | undefined) => Parameters<typeof seatReading>[0]["event"];
  readonly machineReadable: (host: string) => boolean;
}): BroadcastSet =>
  broadcastSet({
    canvasName: input.canvasName,
    canvas: input.canvas,
    machineName: input.machineName,
    picks: input.picks,
    readingOf: (nodeId): SeatReading => {
      const node = input.canvas.nodes.get(asNodeId(nodeId));
      const bindingId = node !== undefined && "bindingId" in node ? (node.bindingId as string | undefined) : undefined;
      const host = node !== undefined && "host" in node ? (node.host as string | undefined) : undefined;
      const here = node !== undefined && node.kind !== "peer" && (host === undefined || isOnMachine(host, input.machineName));
      // As the core reads it: a seat here with no state yet is off (gone), so a Doing limit holds it as off, never unread.
      const event = input.eventOf(bindingId) ?? (here ? { state: "gone" as const } : undefined);
      return seatReading({
        canvasName: input.canvasName,
        nodeId,
        event,
        current: here || (node?.kind !== "peer" && host !== undefined && input.machineReadable(host)),
        signals: input.signals,
      });
    },
  });

/**
 * A reader for sets, followed as seats change state while the operator
 * composes: it is a new function when anything it reads changed, so a set
 * memoized on it is read again. Reading is for any picks, which is how a
 * limit's count alone and a region's whole count are read beside the choice.
 */
export const useBroadcastReader = (canvasName: string): ((picks: ReadonlyArray<BroadcastPick>) => BroadcastSet) => {
  const canvas = useCanvas(canvasName);
  // Read for their changes: the seat events and the signals are read whole at the moment of the set.
  const rev = use$(agentSeat$.rev);
  const signals = use$(agentSignals$);
  const facts = use$(state$.machineFacts);
  const machineName = use$(state$.settings.machine.name);
  return useMemo(
    () => {
      const open = Object.values(signals);
      return (picks) =>
        readBroadcastSet({
          canvasName,
          canvas,
          picks,
          machineName,
          signals: open,
          eventOf: seatEventForBinding,
          machineReadable: (host) => facts[host]?.reachable !== false && facts[host]?.asleep !== true,
        });
    },
    // `rev` stands for the seat events: a nested write keeps the store's own identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasName, canvas, machineName, signals, facts, rev],
  );
};
