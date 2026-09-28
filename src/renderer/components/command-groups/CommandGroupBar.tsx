import { useMemo, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import { Plus } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { MemberSeverity } from "@shared/region-rollup";
import { agentSeat$, bindingIdForNode, seatEventForNode, seatNeedsLook } from "../../lib/agent-seat-state";
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
  seatFactsOf,
  useCommandGroupUpkeep,
  useExtraGroups,
  useHotbarHotkeys,
} from "../../lib/command-group-runtime";
import { isHotbarLeaseActor } from "../../lib/command-bar";
import { currentSelectionIds, selectionIsGroup, swapHotbarSlots } from "../../lib/command-groups";
import { hotbarNodeSeverity, liveActivitySeverity } from "../../lib/hotbar-signal";
import { slotMemberIds, type HotbarSlot } from "../../lib/hotbar-slots";
import { kernel$ } from "../../lib/kernel-view";
import { seatRollupsForNodes } from "../../lib/minimap-seat-colors";
import { seatAwareness$ } from "../../lib/seat-awareness";
import { digitHue } from "../../lib/seat-projections";
import { seatRollup, worseRollup, type SeatRollup } from "../../lib/seat-rollup";
import { state$ } from "../../lib/state";
import { useHealthClock } from "../../lib/thread-health";
import { CommandGroupChip } from "./CommandGroupChip";
import "./command-group-bar.css";

const isAgentSeat = (node: CanvasNode): boolean =>
  node.type !== "group" && node.ether?.entity?.kind === "agent";

/**
 * One tone per node on the bar, in the renewed seat vocabulary (seatRollup:
 * declared signal, proven attention, thread health, control state), the order
 * rings, the minimap, and cmd+K read. A node that is not a seat speaks through
 * its control state alone.
 */
function useBarTones(nodeIds: ReadonlyArray<string>): ReadonlyMap<string, SeatRollup> {
  const doc = use$(state$.doc);
  const now = useHealthClock();
  const signals = use$(seatSignalRollups$);
  const awarenessRev = use$(seatAwareness$.rev);
  const seatRev = use$(agentSeat$.rev);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const regionSeverity = use$(state$.regionSeverityByNodeId);
  const chatByAgent = use$(chatCoarse$) as
    | Record<string, { readonly pendingPermissionId?: string } | undefined>
    | undefined;
  const key = nodeIds.join(",");
  return useMemo(() => {
    const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
    const blocked = new Set(execution?.blocked ?? []);
    // A seat's control state is its live facts, not only its region's rollup.
    const control: Record<string, string> = { ...regionSeverity };
    for (const node of doc.nodes) {
      if (!isHotbarLeaseActor(node)) continue;
      control[node.id] = digitHue(seatFactsOf(node, { graphBlocked: blocked.has(node.id), chatByAgent }));
    }
    const seats = seatRollupsForNodes(doc.nodes, { now, severityByNodeId: control, signalsByNodeId: signals });
    const out = new Map<string, SeatRollup>();
    for (const id of nodeIds) {
      const node = byId.get(id);
      if (!node) continue;
      const seat = seats.get(id);
      if (seat) {
        out.set(id, seat);
        continue;
      }
      if (isAgentSeat(node)) continue;
      const severity = hotbarNodeSeverity(node, {
        regionSeverity: regionSeverity[id] as MemberSeverity | undefined,
        liveSeverity:
          node.type === "group"
            ? undefined
            : liveActivitySeverity({
                seatState: seatEventForNode(node)?.state,
                seatNeedsLook: seatNeedsLook(bindingIdForNode(node)),
              }),
      });
      const rollup = seatRollup({ control: severity });
      if (rollup) out.set(id, rollup);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for nodeIds; revs stamp the stores
  }, [key, doc, now, signals, awarenessRev, seatRev, execution, executionRev, regionSeverity, chatByAgent]);
}

/** The worst tone among a chip's members. */
const chipTone = (memberIds: ReadonlyArray<string>, tones: ReadonlyMap<string, SeatRollup>) =>
  memberIds.reduce<SeatRollup | undefined>((worst, id) => worseRollup(worst, tones.get(id)), undefined);

type Drag = { readonly from: "slot" | "extra"; readonly index: number };

/**
 * The operator's command groups in the top bar: slots 1 to 9 with their
 * hotkeys, then any groups past nine, shown without one, then a button that
 * saves the selection as a new group. Owns the digit keys and the board's
 * upkeep.
 */
export function CommandGroupBar() {
  useCommandGroupUpkeep();
  useHotbarHotkeys();
  const slots = use$(state$.hotbarSlots);
  const extras = useExtraGroups();
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const drag = useRef<Drag | null>(null);

  const byId = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node] as const)), [doc]);
  const membersOf = (ids: ReadonlyArray<string>): CanvasNode[] =>
    ids.flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    });
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
    <div className="group-bar" role="toolbar" aria-label="Command groups">
      {slots.map((slot, index) => {
        const ids = slotMemberIds(slot);
        const members = membersOf(ids);
        return (
          <CommandGroupChip
            key={`slot-${index}`}
            hotkey={index + 1}
            testId={`hotbar-slot-${index + 1}`}
            tenure={slot.kind}
            members={members}
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
            members={members}
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
