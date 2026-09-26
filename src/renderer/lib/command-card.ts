import type { HotbarSlot } from "./hotbar-slots";
import type { CanvasNode } from "@shared/canvas";

/**
 * Selection kind for the RTS left command card primary row.
 * Derived from node shape. Open vocabulary entity.kind is
 * folded into these tactical surfaces only.
 */
export type CommandSelectionKind =
  | "region"
  | "link"
  | "default";

/** Kind-specific primary actions (before shared utilities). */
export type PrimaryCommandAction =
  | "hold-region"
  | "slot-cue"
  | "open-link";

export type CommandCardCaps = {
  /** region: always true when kind is region; slot index 0–8 or null if unslotted. */
  readonly slotIndex?: number | null;
};

/**
 * Classify a selected node for the command card primary row.
 * Precedence: region → page (link+page) → default.
 * Plain link furniture is retired.
 */
export function commandSelectionKind(node: CanvasNode): CommandSelectionKind {
  if (node.type === "group") return "region";
  if (
    node.type === "link" &&
    node.ether?.entity?.kind === "page" &&
    Boolean(node.ether?.browser)
  ) {
    return "link";
  }
  return "default";
}

/**
 * Primary actions for a selection kind, filtered by live capabilities.
 * Does not include shared utilities (focus, edit, connect, copy, delete).
 */
export function primaryCommandActions(
  kind: CommandSelectionKind,
  caps: CommandCardCaps = {},
): ReadonlyArray<PrimaryCommandAction> {
  switch (kind) {
    case "region":
      // Ops only — dense field editors (briefing/defaults/background/paths)
      // live as individual kind-strip keys, not this card.
      return ["hold-region", "slot-cue"];
    case "link":
      return ["open-link", "slot-cue"];
    case "default":
      return ["slot-cue"];
  }
}

/** 1-based slot label for hotbar chips (empty → cue to Ctrl/⌘+N). */
export function regionSlotCueLabel(slotIndex: number | null | undefined): string {
  if (slotIndex === null || slotIndex === undefined || slotIndex < 0 || slotIndex > 8) {
    return "Assign hotkey slot";
  }
  return `Hotkey slot ${slotIndex + 1}`;
}

/** Index of nodeId in presentational slot order, or null if not assigned. */
export function slotIndexOf(
  order: ReadonlyArray<string>,
  nodeId: string,
): number | null {
  const index = order.indexOf(nodeId);
  return index >= 0 && index <= 8 ? index : null;
}

/** Index of nodeId on a 9-slot hotbar (fixed, leased, or evicted soft-hold). */
export function hotbarSlotIndexOf(
  slots: ReadonlyArray<HotbarSlot>,
  nodeId: string,
): number | null {
  const fixed = slots.findIndex(
    (slot) => slot.kind === "fixed" && slot.nodeId === nodeId,
  );
  if (fixed >= 0 && fixed <= 8) return fixed;
  const leased = slots.findIndex(
    (slot) => slot.kind === "leased" && slot.nodeId === nodeId,
  );
  if (leased >= 0 && leased <= 8) return leased;
  const evicted = slots.findIndex(
    (slot) => slot.kind === "evicted" && slot.nodeId === nodeId,
  );
  return evicted >= 0 && evicted <= 8 ? evicted : null;
}
