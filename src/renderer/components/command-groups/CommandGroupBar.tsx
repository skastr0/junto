import { useCanvasWorkAttention } from "../../lib/use-work-sink";
import { useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Plus } from "lucide-react";
import { asNodeId, nodesOf } from "@shared/model";
import type { MemberSeverity } from "@shared/region-rollup";
import { agentSeat$, seatEventForBinding, seatNeedsLook } from "../../lib/agent-seat-state";
import { seatSignalRollups$ } from "../../lib/agent-signals-state";
import { chatCoarse$ } from "../../lib/chat-state";
import {
  focusAndActivate,
  focusNode,
  forgetExtraGroup,
  frameGroup,
  promoteExtraGroupTo,
  recomputeHotbar,
  saveSelectionToCommandGroup,
  seatBindingOf,
  seatFactsOf,
  useCommandGroupUpkeep,
  useExtraGroups,
  useLiveNodeIds,
} from "../../lib/command-group-runtime";
import { currentSelectionIds, selectionIsGroup, swapHotbarSlots } from "../../lib/command-groups";
import { hotbarNodeSeverity, liveActivitySeverity } from "../../lib/hotbar-signal";
import { slotMemberIds, type HotbarSlot } from "../../lib/hotbar-slots";
import { kernel$ } from "../../lib/kernel-view";
import { decodeRollups, encodeRollups, seatRollupsForCanvas } from "../../lib/minimap-seat-colors";
import { seatAwareness$ } from "../../lib/seat-awareness";
import { digitHue } from "../../lib/seat-projections";
import { seatRollup, worseRollup, type SeatRollup } from "../../lib/seat-rollup";
import { state$ } from "../../lib/state";
import { useHealthClock } from "../../lib/thread-health";
import { modelStore } from "../../lib/use-model";
import { CommandGroupChip } from "./CommandGroupChip";
import "./command-group-bar.css";

/**
 * One tone per node on the bar, in the renewed seat vocabulary (seatRollup:
 * declared signal, proven attention, thread health, control state), the order
 * rings, the minimap, and cmd+K read. A node that is not a seat speaks through
 * its control state alone.
 *
 * The tones are worked out inside one selector that answers a string, so the
 * bar is redrawn when a tone changes and not when a card moves, is renamed,
 * or a seat reports the state it was already in.
 */
function useBarTones(nodeIds: ReadonlyArray<string>): ReadonlyMap<string, SeatRollup> {
  const canvasName = use$(state$.canvasName);
  const work = useCanvasWorkAttention(canvasName);
  const now = useHealthClock();
  const encoded = use$(() => {
    // The stores a tone is read from. Each is followed here and nowhere else.
    seatAwareness$.rev.get();
    agentSeat$.rev.get();
    kernel$.executionRev.get();
    const signals = seatSignalRollups$.get();
    const execution = kernel$.execution.get();
    const regionSeverity = state$.regionSeverityByNodeId.get();
    const chatByAgent = chatCoarse$.get() as
      | Record<string, { readonly pendingPermissionId?: string } | undefined>
      | undefined;
    modelStore.canvas$(canvasName).nodes.get();
    const canvas = modelStore.canvasOf(canvasName);

    const blocked = new Set(execution?.blocked ?? []);
    // A seat's control state is its live facts, not only its region's rollup.
    const control: Record<string, string> = { ...regionSeverity };
    for (const seat of nodesOf(canvas, "agent")) {
      control[seat.id] = digitHue(seatFactsOf(seat, { graphBlocked: blocked.has(seat.id), chatByAgent }));
    }
    const seats = seatRollupsForCanvas(canvas, { now, severityByNodeId: control, signalsByNodeId: signals });
    const out = new Map<string, SeatRollup>();
    for (const id of nodeIds) {
      const node = canvas.nodes.get(asNodeId(id));
      if (!node) continue;
      const seat = seats.get(id);
      if (seat) {
        out.set(id, seat);
        continue;
      }
      if (node.kind === "agent") continue;
      const isRegion = node.kind === "region";
      const bindingId = isRegion ? undefined : seatBindingOf(node);
      const severity = hotbarNodeSeverity(isRegion, {
        work: work.glances[id], items: work.items[id],
        regionSeverity: regionSeverity[id] as MemberSeverity | undefined,
        liveSeverity: isRegion
          ? undefined
          : liveActivitySeverity({
              seatState: seatEventForBinding(bindingId)?.state,
              seatNeedsLook: seatNeedsLook(bindingId),
            }),
      });
      const rollup = seatRollup({ control: severity });
      if (rollup) out.set(id, rollup);
    }
    return encodeRollups(out);
  });
  return useMemo(() => decodeRollups(encoded), [encoded]);
}

/** The worst tone among a chip's members. */
const chipTone = (memberIds: ReadonlyArray<string>, tones: ReadonlyMap<string, SeatRollup>) =>
  memberIds.reduce<SeatRollup | undefined>((worst, id) => worseRollup(worst, tones.get(id)), undefined);

type Drag = { readonly from: "slot" | "extra"; readonly index: number };

type Overflow = "none" | "start" | "end" | "both";

/**
 * Which ends of the row hide chips, kept current as the row resizes, scrolls,
 * or gains chips; a mouse wheel scrolls the row sideways.
 */
function useRowOverflow(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<Overflow>("none");
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const measure = (): void => {
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      setOverflow(start && end ? "both" : start ? "start" : end ? "end" : "none");
    };
    // The observer reports once on observe and again whenever the row or its
    // chips change size, each time after layout is done. Reading there costs
    // nothing; reading straight after a commit made the browser restyle the
    // whole window to answer.
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      row.removeEventListener("scroll", measure);
    };
  }, [count]);
  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const row = ref.current;
    if (!row || row.scrollWidth <= row.clientWidth || event.deltaX !== 0) return;
    row.scrollLeft += event.deltaY;
  };
  return { ref, overflow, onWheel };
}

/**
 * The operator's command groups in the top bar: slots 1 to 9 with their
 * hotkeys, then any groups past nine, shown without one, then a button that
 * saves the selection as a new group. Owns the board's upkeep.
 */
export function CommandGroupBar() {
  useCommandGroupUpkeep();
  const slots = use$(state$.hotbarSlots);
  const extras = useExtraGroups();
  // Which nodes the canvas holds: all the bar itself needs of it. Each chip
  // follows its own members.
  const live = useLiveNodeIds();
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const drag = useRef<Drag | null>(null);
  const row = useRowOverflow(slots.length + extras.length);

  const membersOf = (ids: ReadonlyArray<string>): string[] => ids.filter((id) => live.has(id));
  const onBar = useMemo(
    () => [...new Set([...slots.flatMap(slotMemberIds), ...extras.flat()])],
    [slots, extras],
  );
  const tones = useBarTones(onBar);
  const selection = currentSelectionIds(selectedNodeId, selectedNodeIds);

  const activate = (ids: ReadonlyArray<string>): void => {
    if (ids.length > 1) frameGroup(ids);
    else if (ids[0]) focusNode(ids[0]);
  };

  const dropOn = (slotIndex: number): void => {
    const from = drag.current;
    drag.current = null;
    if (!from) return;
    if (from.from === "extra") {
      promoteExtraGroupTo(from.index, slotIndex);
      return;
    }
    if (from.index === slotIndex) return;
    const current = state$.hotbarSlots.peek();
    const moving = current[from.index];
    if (!moving || (moving.kind !== "fixed" && moving.kind !== "group")) return;
    // Swap whole slots: the drop target moves to the drag origin.
    state$.hotbarSlots.set(swapHotbarSlots(current, from.index, slotIndex));
    recomputeHotbar();
  };

  const slotSelected = (slot: HotbarSlot): boolean =>
    slot.kind === "group"
      ? selectionIsGroup(selection, slot)
      : slot.kind !== "empty" && selectedNodeId === slotMemberIds(slot)[0];

  return (
    <div
      ref={row.ref}
      className="group-bar"
      role="toolbar"
      aria-label="Command groups"
      data-overflow={row.overflow === "none" ? undefined : row.overflow}
      onWheel={row.onWheel}
    >
      {slots.map((slot, index) => {
        const ids = slotMemberIds(slot);
        const members = membersOf(ids);
        return (
          <CommandGroupChip
            key={`slot-${index}`}
            hotkey={index + 1}
            testId={`hotbar-slot-${index + 1}`}
            tenure={slot.kind}
            memberIds={members}
            tone={chipTone(ids, tones)}
            selected={slotSelected(slot)}
            onActivate={() => activate(ids)}
            onOpen={() => {
              if (ids.length === 1) focusAndActivate(ids[0]!);
            }}
            dragProps={{
              draggable: slot.kind === "fixed" || slot.kind === "group",
              onDragStart: () => {
                drag.current = { from: "slot", index };
              },
              onDragOver: (event) => event.preventDefault(),
              onDrop: () => dropOn(index),
            }}
          />
        );
      })}
      {extras.length > 0 ? <span className="group-bar__rule" aria-hidden /> : null}
      {extras.map((ids, index) => {
        const members = membersOf(ids);
        return (
          <CommandGroupChip
            key={`extra-${ids.join(",")}`}
            hotkey={undefined}
            testId={`command-group-extra-${index + 1}`}
            tenure={ids.length > 1 ? "group" : "fixed"}
            memberIds={members}
            tone={chipTone(ids, tones)}
            selected={
              ids.length > 1
                ? selectionIsGroup(selection, { kind: "group", nodeIds: [...ids] })
                : selectedNodeId === ids[0]
            }
            onActivate={() => activate(ids)}
            onOpen={() => {
              if (ids.length === 1) focusAndActivate(ids[0]!);
            }}
            onForget={() => forgetExtraGroup(index)}
            dragProps={{
              draggable: true,
              onDragStart: () => {
                drag.current = { from: "extra", index };
              },
              onDragOver: (event) => event.preventDefault(),
              onDrop: () => {
                drag.current = null;
              },
            }}
          />
        );
      })}
      <button
        type="button"
        className="group-bar__new"
        disabled={selection.length === 0}
        aria-label="Save the selection as a new group"
        title={
          selection.length === 0
            ? "Select nodes, then save them as a new group"
            : "Save the selection as a new group: the next free slot, or past nine without a key"
        }
        onClick={() => {
          saveSelectionToCommandGroup(selection, "new");
        }}
      >
        <Plus size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
