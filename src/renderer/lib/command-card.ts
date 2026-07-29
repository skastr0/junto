import type { CanvasNode } from "@shared/canvas";

/**
 * Selection kind for the RTS left command card primary row.
 * Derived from node shape + herdr meta. Open vocabulary entity.kind is
 * folded into these tactical surfaces only.
 */
export type CommandSelectionKind =
  | "herdr"
  | "region"
  | "link"
  | "default";

/** Kind-specific primary actions (after flags; before shared utilities). */
export type PrimaryCommandAction =
  | "open-terminal"
  | "mark-seen"
  | "kill-pane"
  | "arm-region"
  | "pulse-region"
  | "dry-pulse-region"
  | "hold-region"
  | "slot-cue"
  | "open-link";

export type CommandCardCaps = {
  /** herdr: pane has agent_status "done" (Idle+!seen) and a paneId. */
  readonly canMarkSeen?: boolean;
  /** herdr: kill-pane available (paneId present). */
  readonly canKill?: boolean;
  /** region: always true when kind is region; slot index 0–8 or null if unslotted. */
  readonly slotIndex?: number | null;
};

/**
 * Classify a selected node for the command card primary row.
 * Precedence: region → herdr → link → default.
 */
export function commandSelectionKind(node: CanvasNode): CommandSelectionKind {
  if (node.type === "group") return "region";
  if (node.ether?.herdr || node.ether?.entity?.kind === "herdr") return "herdr";
  if (node.type === "link") return "link";
  return "default";
}

/**
 * Primary actions for a selection kind, filtered by live capabilities.
 * Does not include shared utilities (flags, focus, edit, connect, copy, delete).
 */
export function primaryCommandActions(
  kind: CommandSelectionKind,
  caps: CommandCardCaps = {},
): ReadonlyArray<PrimaryCommandAction> {
  switch (kind) {
    case "herdr": {
      const out: PrimaryCommandAction[] = ["open-terminal"];
      if (caps.canMarkSeen) out.push("mark-seen");
      if (caps.canKill) out.push("kill-pane");
      return out;
    }
    case "region":
      // Ops only — dense field editors (briefing/defaults/background/paths)
      // live as individual kind-strip keys, not this card.
      return ["arm-region", "pulse-region", "dry-pulse-region", "hold-region", "slot-cue"];
    case "link":
      return ["open-link"];
    case "default":
      return [];
  }
}

/** 1-based slot label for region chips (empty → cue to Ctrl+N). */
export function regionSlotCueLabel(slotIndex: number | null | undefined): string {
  if (slotIndex === null || slotIndex === undefined || slotIndex < 0 || slotIndex > 8) {
    return "slot · Ctrl+1–9";
  }
  return `slot ${slotIndex + 1}`;
}

/** Index of regionId in presentational slot order, or null if not assigned. */
export function slotIndexOf(
  order: ReadonlyArray<string>,
  regionId: string,
): number | null {
  const index = order.indexOf(regionId);
  return index >= 0 && index <= 8 ? index : null;
}
