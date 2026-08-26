/**
 * Pure multi-select + bulk-action helpers for the task board.
 * Column select-all and bulk actions must not depend on React state shape.
 */

import type { TaskState } from "@shared/canvas";
import { canTransitionTaskState } from "@shared/task";

export type TaskBoardSelectMode = "replace" | "toggle" | "add";

export type TaskBoardBulkItem = {
  readonly id: string;
  readonly state: TaskState;
  readonly isProposal: boolean;
  /** True when complete requires finishCriteria evidence (CLI/agent only). */
  readonly hardFinishGate: boolean;
};

export type TaskBoardBulkAction =
  | {
      readonly kind: "approve_proposals";
      readonly label: string;
    }
  | {
      readonly kind: "reject_proposals";
      readonly label: string;
    }
  | {
      readonly kind: "transition";
      readonly state: TaskState;
      readonly label: string;
    };

const TRANSITION_BULK: ReadonlyArray<{
  readonly state: TaskState;
  readonly label: string;
}> = [
  { state: "submitted", label: "Unassign to Queue" },
  { state: "working", label: "Move to Working" },
  { state: "completed", label: "Complete" },
  { state: "failed", label: "Mark failed" },
  { state: "rejected", label: "Reject" },
  { state: "canceled", label: "Cancel" },
  { state: "archived", label: "Delete from board" },
];

/** Apply a select gesture to an id set. Returns a new set. */
export const applyTaskBoardSelection = (
  current: ReadonlySet<string>,
  taskId: string,
  mode: TaskBoardSelectMode,
): Set<string> => {
  if (mode === "replace") return new Set([taskId]);
  const next = new Set(current);
  if (mode === "add") {
    next.add(taskId);
    return next;
  }
  // toggle
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  return next;
};

/** Select every id in a column, or clear when the column is already fully selected. */
export const toggleSelectAllInColumn = (
  current: ReadonlySet<string>,
  columnIds: ReadonlyArray<string>,
): Set<string> => {
  if (columnIds.length === 0) return new Set(current);
  const allSelected = columnIds.every((id) => current.has(id));
  if (allSelected) {
    const next = new Set(current);
    for (const id of columnIds) next.delete(id);
    return next;
  }
  const next = new Set(current);
  for (const id of columnIds) next.add(id);
  return next;
};

export const columnSelectionState = (
  selected: ReadonlySet<string>,
  columnIds: ReadonlyArray<string>,
): "none" | "partial" | "all" => {
  if (columnIds.length === 0) return "none";
  let hit = 0;
  for (const id of columnIds) {
    if (selected.has(id)) hit += 1;
  }
  if (hit === 0) return "none";
  if (hit === columnIds.length) return "all";
  return "partial";
};

/**
 * Intersection of bulk actions that apply to every selected item.
 * Mixed proposal + task selections get no actions (operator must narrow).
 */
export const resolveTaskBoardBulkActions = (
  items: ReadonlyArray<TaskBoardBulkItem>,
): ReadonlyArray<TaskBoardBulkAction> => {
  if (items.length === 0) return [];

  const allProposals = items.every((item) => item.isProposal);
  const anyProposal = items.some((item) => item.isProposal);
  if (anyProposal && !allProposals) return [];

  if (allProposals) {
    return [
      {
        kind: "approve_proposals",
        label:
          items.length === 1
            ? "Approve to Queue"
            : `Approve ${items.length} to Queue`,
      },
      {
        kind: "reject_proposals",
        label:
          items.length === 1
            ? "Reject pending work"
            : `Reject ${items.length} pending items`,
      },
    ];
  }

  const actions: TaskBoardBulkAction[] = [];
  for (const option of TRANSITION_BULK) {
    const ok = items.every((item) => {
      if (item.state === option.state) return false;
      if (option.state === "completed" && item.hardFinishGate) return false;
      // Completed → Queue is QA reject (needs a comment) — not bulk-safe.
      if (item.state === "completed" && option.state === "submitted") return false;
      return canTransitionTaskState(item.state, option.state);
    });
    if (!ok) continue;
    const plural =
      items.length === 1
        ? option.label
        : option.state === "archived"
          ? `Delete ${items.length} from board`
          : option.state === "canceled"
            ? `Cancel ${items.length}`
            : option.state === "submitted"
              ? `Unassign ${items.length} to Queue`
              : `${option.label} (${items.length})`;
    actions.push({
      kind: "transition",
      state: option.state,
      label: plural,
    });
  }
  return actions;
};
