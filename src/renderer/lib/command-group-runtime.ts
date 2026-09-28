/**
 * Command groups, live: the hotbar's upkeep (leases from seat activity,
 * pruning, per-canvas memory), the digit keys, and every operator action on
 * a group (save, new, assign, recall, promote past nine). The pure contract
 * is command-groups.ts and hotbar-slots.ts; the top bar's CommandGroupBar and
 * the bottom bar's command cards drive it.
 */
import { useEffect } from "react";
import { batch } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { groupMembers } from "@shared/graph";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { activateNodeSurface } from "./activate-node-surface";
import { agentSeat$, bindingIdForNode, seatEventForNode } from "./agent-seat-state";
import { chatCoarse$ } from "./chat-state";
import { focusCanvasNode, isHotbarLeaseActor } from "./command-bar";
import {
  canvasCommandGroups,
  commandGroupKey,
  currentSelectionIds,
  firstFreeSlotIndex,
  promoteExtraGroup,
  pruneExtraGroups,
  recallCommandGroup,
  saveSelectionAsNewGroup,
  saveSelectionToSlot,
  type CommandGroupRetap,
  type ExtraGroup,
  type RecallStep,
} from "./command-groups";
import { dock$ } from "./dock-state";
import { isOperatorTyping } from "./focus-ownership";
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
import { isMac } from "./platform";
import { digitLease, liveAttentionReasons, seatFactsForNode, type SeatFacts } from "./seat-projections";
import { selectNodes, state$ } from "./state";
import { terminal$ } from "./terminal-state";

/** A focus surface or Settings owns the keyboard; digits must not drive the canvas behind it. */
const keyboardOwnedAboveCanvas = (): boolean =>
  state$.settingsOpen.peek() ||
  dock$.registry.surfaces.peek().some((surface) => surface.zone === "focus");

const liveNodeIds = (doc: { readonly nodes: ReadonlyArray<{ readonly id: string }> }): string[] =>
  doc.nodes.map((n) => n.id);

/**
 * Opportunistic hotbar leases are **actors only** (crew role).
 * Well-known: `agent`. Notes, tasks, regions, pages, etc. never auto-lease.
 * Operator fixed slots (⌘1–9) remain unrestricted. Shared with the command
 * bar via lib/command-bar so focus commits lease identically everywhere.
 */
const leaseEligibleActorIds = (nodes: ReadonlyArray<CanvasNode>): Set<string> => {
  const out = new Set<string>();
  for (const node of nodes) {
    if (isHotbarLeaseActor(node)) out.add(node.id);
  }
  return out;
};

const managedSeatOf = (node: CanvasNode): boolean => {
  const harness = node.ether?.terminal?.harness;
  return typeof harness === "string" && isHarnessId(harness);
};

/** One seat's control facts from the live stores, read without subscribing. */
export const seatFactsOf = (
  node: CanvasNode,
  extra: {
    readonly graphBlocked?: boolean;
    readonly chatByAgent?: Readonly<
      Record<string, { readonly pendingPermissionId?: string } | undefined>
    >;
    readonly needsLook?: boolean;
  } = {},
): SeatFacts => {
  const bindingId = bindingIdForNode(node);
  const session = bindingId ? terminal$.sessionByBindingId[bindingId].peek() : undefined;
  return seatFactsForNode({
    nodeId: node.id,
    seatEvent: seatEventForNode(node),
    session,
    graphBlocked: extra.graphBlocked,
    attentionReasons: liveAttentionReasons(node, extra.chatByAgent),
    managedSeat: managedSeatOf(node),
    needsLook: extra.needsLook,
  });
};

/**
 * Actors that keep a hard lease while busy: only working or attention. Idle
 * demotes to an idle soft-hold.
 */
const stickyWorkingNodeIds = (nodes: ReadonlyArray<CanvasNode>): string[] => {
  const chatByAgent = chatCoarse$.peek() as
    | Record<string, { readonly pendingPermissionId?: string } | undefined>
    | undefined;
  const out: string[] = [];
  for (const node of nodes) {
    if (!isHotbarLeaseActor(node)) continue;
    if (digitLease(seatFactsOf(node, { chatByAgent }))) out.push(node.id);
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
    liveNodeIds(state$.doc.peek()),
  );
  batch(() => {
    state$.hotbarSlots.set(next.slots);
    setExtraGroups(next.extras);
  });
  recomputeHotbar();
};

// --- upkeep ------------------------------------------------------------------

/** Recompute leases after fixed mutations, activity MRU, or seat sticky set changes. */
export const recomputeHotbar = (): void => {
  const doc = state$.doc.peek();
  const live = liveNodeIds(doc);
  const actors = leaseEligibleActorIds(doc.nodes);
  // Focus MRU orders fill among sticky actors only — it does not pin hard leases.
  let mru: ReadonlyArray<string> = filterLeaseCandidateIds(state$.hotbarActiveMru.peek(), actors);
  const selected = state$.selectedNodeId.peek();
  if (selected && live.includes(selected) && actors.has(selected)) {
    mru = touchActiveMru(mru, selected);
  }
  state$.hotbarActiveMru.set([...mru]);
  const sticky = stickyWorkingNodeIds(doc.nodes);
  const next = purgeNonEligibleSoftSlots(
    resolveHotbarSlots(state$.hotbarSlots.peek(), live, mru, sticky),
    actors,
  );
  state$.hotbarSlots.set(next);
  // Compat mirror: dense fixed-only order for any remaining legacy readers.
  state$.regionSlotOrder.set(fixedOrderOf(next));
  const extras = extraGroupsNow();
  const pruned = pruneExtraGroups(extras, live);
  if (pruned.length !== extras.length || pruned.some((group, index) => group !== extras[index])) {
    setExtraGroups(pruned);
  }
};

/**
 * Keep the board current: prune dead ids and refresh leases on document,
 * selection, and seat changes (idle seats demote to soft-hold, not vanish),
 * and remember the operator's slots per canvas for a switch back.
 */
export const useCommandGroupUpkeep = (): void => {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const seatRev = use$(agentSeat$.rev);
  useEffect(() => {
    recomputeHotbar();
  }, [doc, selectedNodeId, seatRev]);
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
  const documentNodeIds = liveNodeIds(state$.doc.peek());
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
  const node = state$.doc.peek().nodes.find((n) => n.id === nodeId);
  if (node) activateNodeSurface(node);
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

/** ⌘1–9 saves the selection to a slot; a bare 1–9 recalls it. */
export const useHotbarHotkeys = (): void => {
  useEffect(() => {
    let retap: CommandGroupRetap | null = null;
    const onKey = (event: KeyboardEvent) => {
      if (isOperatorTyping(event.target)) return;
      const intent = commandGroupKey(event, isMac());
      if (intent === null) return;
      if (keyboardOwnedAboveCanvas()) return;
      // ⌘1–9 (Ctrl elsewhere): save the live selection to this slot. One node
      // fixes it; two or more save a control group. Saving never moves the camera.
      if (intent.kind === "save") {
        event.preventDefault();
        const selection = currentSelectionIds(
          state$.selectedNodeId.peek(),
          state$.selectedNodeIds.peek(),
        );
        if (saveSelectionToCommandGroup(selection, intent.slotIndex)) retap = null;
        return;
      }

      // 1–9: recall. Groups frame their members; re-tap cycles and opens.
      const doc = state$.doc.peek();
      const { step, memory } = recallCommandGroup(
        state$.hotbarSlots.peek(),
        intent.slotIndex,
        {
          documentNodeIds: liveNodeIds(doc),
          regionIds: new Set(doc.nodes.filter((n) => n.type === "group").map((n) => n.id)),
          regionMembers: (regionId) => groupMembers(doc).get(regionId) ?? [],
        },
        retap,
        performance.now(),
      );
      if (step.kind === "none") return;
      event.preventDefault();
      retap = memory;
      runRecallStep(step);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
};
