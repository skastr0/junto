/**
 * Command groups, live: the hotbar's upkeep (leases from seat activity,
 * pruning, per-canvas memory) and every operator action on a group (save,
 * new, assign, recall, jump, promote past nine). The keys are in the key table. The pure contract
 * is command-groups.ts and hotbar-slots.ts; the top bar's CommandGroupBar and
 * the bottom bar's command cards drive it.
 */
import { useEffect, useMemo } from "react";
import { batch } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { asNodeId, nodesOf, regionMembers, type Canvas, type Node } from "@shared/model";
import { activateNodeSurface, nodeSurfaceKind } from "./activate-node-surface";
import { agentSeat$, seatEventForBinding } from "./agent-seat-state";
import { chatCoarse$ } from "./chat-state";
import { focusCanvasNode } from "./command-bar";
import {
  canvasCommandGroups,
  currentSelectionIds,
  firstFreeSlotIndex,
  jumpCommandGroup,
  promoteExtraGroup,
  pruneExtraGroups,
  recallCommandGroup,
  saveSelectionAsNewGroup,
  saveSelectionToSlot,
  type CommandGroupRetap,
  type ExtraGroup,
  type RecallContext,
  type RecallStep,
} from "./command-groups";
import { dock$ } from "./dock-state";
import { focusMruNodeIds } from "./focus-switcher";
import {
  assignFixedSlot,
  clearHotbarNode,
  filterLeaseCandidateIds,
  fixedOrderOf,
  purgeNonEligibleSoftSlots,
  resolveHotbarSlots,
  slotIndexOf,
  touchActiveMru,
} from "./hotbar-slots";
import { digitLease, liveAttentionReasons, seatFactsForNode, type SeatFacts } from "./seat-projections";
import { selectNodes, state$ } from "./state";
import { terminal$ } from "./terminal-state";
import { modelStore, nodeAt } from "./use-model";

/** The open canvas as the store holds it now. Read, never followed. */
const canvasNow = (): Canvas => modelStore.canvasOf(state$.canvasName.peek());

const liveNodeIds = (canvas: Canvas): string[] => [...canvas.nodes.keys()];

/**
 * Opportunistic hotbar leases are **actors only** (crew role): a seat. Notes,
 * tasks, regions, pages and the rest never auto-lease. Operator fixed slots
 * (⌘1–9) remain unrestricted.
 */
export const isLeaseActor = (node: Node | undefined): boolean => node?.kind === "agent";

const leaseEligibleActorIds = (canvas: Canvas): Set<string> =>
  new Set(nodesOf(canvas, "agent").map((seat) => seat.id as string));

/** The session a node's live seat state is read from. */
export const seatBindingOf = (node: Node): string | undefined =>
  node.kind === "agent" || node.kind === "terminal"
    ? node.bindingId
    : agentSeat$.bindingIdByNodeId[node.id].peek();

export const seatFactsOf = (
  node: Node,
  extra: {
    readonly graphBlocked?: boolean;
    readonly chatByAgent?: Readonly<
      Record<string, { readonly pendingPermissionId?: string } | undefined>
    >;
    readonly needsLook?: boolean;
  } = {},
): SeatFacts => {
  const bindingId = seatBindingOf(node);
  const session = bindingId ? terminal$.sessionByBindingId[bindingId].peek() : undefined;
  return seatFactsForNode({
    nodeId: node.id,
    seatEvent: seatEventForBinding(bindingId),
    session,
    graphBlocked: extra.graphBlocked,
    // seat-projections reads a document node for the agent key and nothing
    // else. This literal is all it reads; it goes when that file takes the key.
    attentionReasons:
      node.kind === "agent"
        ? liveAttentionReasons({ ether: { entity: { kind: "agent", name: node.agentKey } } }, extra.chatByAgent)
        : [],
    managedSeat: node.kind === "agent",
    needsLook: extra.needsLook,
  });
};

/**
 * Actors that keep a hard lease while busy: only working or attention. Idle
 * demotes to an idle soft-hold.
 */
const stickyWorkingNodeIds = (canvas: Canvas): string[] => {
  const chatByAgent = chatCoarse$.peek() as
    | Record<string, { readonly pendingPermissionId?: string } | undefined>
    | undefined;
  const out: string[] = [];
  for (const seat of nodesOf(canvas, "agent")) {
    if (digitLease(seatFactsOf(seat, { chatByAgent }))) out.push(seat.id);
  }
  return out;
};

// --- groups beyond nine --------------------------------------------------------

/** The open canvas's groups past slot 9. */
export const extraGroupsNow = (): ReadonlyArray<ExtraGroup> =>
  state$.extraCommandGroups.peek()[state$.canvasName.peek()] ?? [];

const setExtraGroups = (groups: ReadonlyArray<ExtraGroup>): void => {
  const canvasName = state$.canvasName.peek();
  if (!canvasName) return;
  state$.extraCommandGroups.set({ ...state$.extraCommandGroups.peek(), [canvasName]: [...groups] });
};

/** The open canvas's groups past slot 9, live. */
export const useExtraGroups = (): ReadonlyArray<ExtraGroup> => {
  const canvasName = use$(state$.canvasName);
  const byCanvas = use$(state$.extraCommandGroups);
  return byCanvas[canvasName] ?? [];
};

/** Forget one group past nine. */
export const forgetExtraGroup = (extraIndex: number): void => {
  setExtraGroups(extraGroupsNow().filter((_, index) => index !== extraIndex));
};

/** Drag a group past nine onto a slot: it takes that digit. */
export const promoteExtraGroupTo = (extraIndex: number, slotIndex: number): void => {
  const next = promoteExtraGroup(
    state$.hotbarSlots.peek(),
    extraGroupsNow(),
    extraIndex,
    slotIndex,
    liveNodeIds(canvasNow()),
  );
  batch(() => {
    state$.hotbarSlots.set(next.slots);
    setExtraGroups(next.extras);
  });
  recomputeHotbar();
};

// --- upkeep ------------------------------------------------------------------

const ID_SPLIT = "";

/**
 * Which nodes the open canvas holds, as a set that changes only when a node
 * comes or goes. The store's own list is in stacking order, and dropping a
 * card restacks it, so that list changes on a move that adds and removes
 * nothing; this one is put in id order and compared as one string.
 */
export const useLiveNodeIds = (): ReadonlySet<string> => {
  const key = use$(() =>
    [...modelStore.canvas$(state$.canvasName.get()).nodeIds.get()].sort().join(ID_SPLIT),
  );
  return useMemo(() => new Set(key === "" ? [] : key.split(ID_SPLIT)), [key]);
};

/** Whether two values say the same thing. A reader is woken only when they do not. */
const saysTheSame = (held: unknown, next: unknown): boolean =>
  JSON.stringify(held) === JSON.stringify(next);

/** Recompute leases after fixed mutations, activity MRU, or seat sticky set changes. */
export const recomputeHotbar = (): void => {
  const canvas = canvasNow();
  const live = liveNodeIds(canvas);
  const actors = leaseEligibleActorIds(canvas);
  // Focus MRU orders fill among sticky actors only — it does not pin hard leases.
  let mru: ReadonlyArray<string> = filterLeaseCandidateIds(state$.hotbarActiveMru.peek(), actors);
  const selected = state$.selectedNodeId.peek();
  if (selected && live.includes(selected) && actors.has(selected)) {
    mru = touchActiveMru(mru, selected);
  }
  if (!saysTheSame(state$.hotbarActiveMru.peek(), mru)) state$.hotbarActiveMru.set([...mru]);
  const sticky = stickyWorkingNodeIds(canvas);
  const next = purgeNonEligibleSoftSlots(
    resolveHotbarSlots(state$.hotbarSlots.peek(), live, mru, sticky),
    actors,
  );
  // Upkeep runs often and usually changes nothing; a slot array that says
  // what the held one says is not written, or the bar would redraw for it.
  if (!saysTheSame(state$.hotbarSlots.peek(), next)) state$.hotbarSlots.set(next);
  // Compat mirror: dense fixed-only order for any remaining legacy readers.
  const fixedOrder = fixedOrderOf(next);
  if (!saysTheSame(state$.regionSlotOrder.peek(), fixedOrder)) state$.regionSlotOrder.set(fixedOrder);
  const extras = extraGroupsNow();
  const pruned = pruneExtraGroups(extras, live);
  if (pruned.length !== extras.length || pruned.some((group, index) => group !== extras[index])) {
    setExtraGroups(pruned);
  }
};

/**
 * Keep the board current: prune dead ids and refresh leases when a node comes
 * or goes, on selection, and on seat changes (idle seats demote to soft-hold, not vanish),
 * and remember the operator's slots per canvas for a switch back.
 */
export const useCommandGroupUpkeep = (): void => {
  // Which nodes there are is all the board keeps of the canvas: a card that
  // moves or is renamed changes no lease, so it wakes nothing here.
  const nodeIds = useLiveNodeIds();
  const selectedNodeId = use$(state$.selectedNodeId);
  const seatRev = use$(agentSeat$.rev);
  useEffect(() => {
    recomputeHotbar();
  }, [nodeIds, selectedNodeId, seatRev]);
  useEffect(
    () =>
      state$.hotbarSlots.onChange(({ value }) => {
        canvasCommandGroups.remember(state$.canvasName.peek(), value);
      }),
    [],
  );
};

// --- operator actions ----------------------------------------------------------

/** Assign node to first free slot as fixed. Empty preferred; then evicted. */
const assignToFirstFreeSlot = (nodeId: string): void => {
  const slots = state$.hotbarSlots.peek();
  const index = slotIndexOf(slots, nodeId);
  if (index !== null) {
    // Already on bar (fixed / leased / evicted) — promote to fixed in place.
    if (slots[index]?.kind !== "fixed") {
      state$.hotbarSlots.set(assignFixedSlot(slots, nodeId, index));
      recomputeHotbar();
    }
    return;
  }
  // Empty, then idle soft-hold, then lease. A bar full of operator slots
  // leaves them alone rather than overwriting slot 9.
  const target = firstFreeSlotIndex(slots);
  if (target === null) return;
  state$.hotbarSlots.set(assignFixedSlot(slots, nodeId, target));
  recomputeHotbar();
};

/**
 * Save node ids as the operator's command group: into a slot (one node is a
 * fixed slot), or `"new"` for the first free slot, else a group past nine.
 * Shared by ⌘1–9, the multi-select menu, and the top bar. False when no live
 * node was given, so nothing changed.
 */
export const saveSelectionToCommandGroup = (
  selectedIds: ReadonlyArray<string>,
  target: number | "new",
): boolean => {
  const documentNodeIds = liveNodeIds(canvasNow());
  const slots = state$.hotbarSlots.peek();
  if (target === "new") {
    const next = saveSelectionAsNewGroup(slots, extraGroupsNow(), selectedIds, documentNodeIds);
    if (!next) return false;
    batch(() => {
      state$.hotbarSlots.set(next.slots);
      setExtraGroups(next.extras);
    });
    recomputeHotbar();
    return true;
  }
  const next = saveSelectionToSlot(slots, selectedIds, target, documentNodeIds);
  if (!next) return false;
  state$.hotbarSlots.set(next);
  recomputeHotbar();
  return true;
};

/** Toggle fixed assignment: clear if fixed, else fix into first free. */
export const toggleSlotAssignment = (nodeId: string): void => {
  const slots = state$.hotbarSlots.peek();
  const index = slotIndexOf(slots, nodeId);
  if (index !== null && slots[index]?.kind === "fixed") {
    state$.hotbarSlots.set(clearHotbarNode(slots, nodeId));
    recomputeHotbar();
    return;
  }
  assignToFirstFreeSlot(nodeId);
};

export const focusNode = (nodeId: string): void => {
  focusCanvasNode(nodeId);
  recomputeHotbar();
};

/** Select a command group's members and frame them together. */
export const frameGroup = (nodeIds: ReadonlyArray<string>): void => {
  batch(() => {
    selectNodes(nodeIds);
    state$.focusNodeIds.set([...nodeIds]);
  });
};

/** Focus then open the live surface when the node has one (actor model, etc.). */
export const focusAndActivate = (nodeId: string): void => {
  focusNode(nodeId);
  const node = nodeAt(state$.canvasName.peek(), nodeId);
  if (node) activateNodeSurface(node.id);
};

/** Carry out one recall step from the command-group contract. */
const runRecallStep = (step: RecallStep): void => {
  switch (step.kind) {
    case "none":
      return;
    case "focus":
      focusNode(step.nodeId);
      return;
    case "frame-group":
      frameGroup(step.nodeIds);
      return;
    case "open":
      focusAndActivate(step.nodeId);
      return;
  }
};

const recallContext = (canvas: Canvas): RecallContext => ({
  documentNodeIds: liveNodeIds(canvas),
  regionIds: new Set(nodesOf(canvas, "region").map((region) => region.id as string)),
  regionMembers: (regionId) => {
    const region = canvas.nodes.get(asNodeId(regionId));
    return region?.kind === "region" ? regionMembers(canvas, region).map((member) => member.id as string) : [];
  },
});

let retap: CommandGroupRetap | null = null;

/**
 * Save the live selection to a slot. One node fixes it; two or more save a
 * control group. Saving never moves the camera.
 */
export const assignSelectionToSlot = (slotIndex: number): void => {
  const selection = currentSelectionIds(state$.selectedNodeId.peek(), state$.selectedNodeIds.peek());
  if (saveSelectionToCommandGroup(selection, slotIndex)) retap = null;
};

/**
 * Recall a slot on the canvas. Groups frame their members; a re-tap cycles
 * and opens. False when the slot is empty.
 */
export const recallSlot = (slotIndex: number): boolean => {
  const { step, memory } = recallCommandGroup(
    state$.hotbarSlots.peek(),
    slotIndex,
    recallContext(canvasNow()),
    retap,
    performance.now(),
  );
  if (step.kind === "none") return false;
  retap = memory;
  runRecallStep(step);
  return true;
};

/**
 * Jump to a slot from a terminal, a field or a working modal: open its first
 * agent, or the next one when one of them is already in front. False when the
 * slot holds nothing that opens.
 */
export const jumpToSlot = (slotIndex: number): boolean => {
  // What opens is asked of the native node: activate-node-surface
  // takes one. The node itself is the store's, read once here.
  const canvasName = state$.canvasName.peek();
  const registry = dock$.registry.peek();
  const nodeId = jumpCommandGroup(
    state$.hotbarSlots.peek(),
    slotIndex,
    recallContext(canvasNow()),
    (id) => {
      const node = nodeAt(canvasName, id);
      return node !== undefined && nodeSurfaceKind(node) !== null;
    },
    focusMruNodeIds(registry.surfaces, registry.focusMru)[0] ?? null,
  );
  if (nodeId === null) return false;
  focusAndActivate(nodeId);
  return true;
};
