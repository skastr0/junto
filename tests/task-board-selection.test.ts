import { describe, expect, it } from "vitest";
import {
  applyTaskBoardSelection,
  columnSelectionState,
  resolveTaskBoardBulkActions,
  toggleSelectAllInColumn,
} from "../src/renderer/components/work/task-board-selection";

describe("task-board-selection", () => {
  it("replace / toggle / add selection modes", () => {
    expect([...applyTaskBoardSelection(new Set(["a"]), "b", "replace")]).toEqual([
      "b",
    ]);
    expect([...applyTaskBoardSelection(new Set(["a"]), "b", "add")].sort()).toEqual([
      "a",
      "b",
    ]);
    expect([...applyTaskBoardSelection(new Set(["a", "b"]), "a", "toggle")]).toEqual([
      "b",
    ]);
    expect([...applyTaskBoardSelection(new Set(["b"]), "a", "toggle")].sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("selects all in a column and deselects when already full", () => {
    const column = ["p1", "p2", "p3"];
    const selected = toggleSelectAllInColumn(new Set(["x"]), column);
    expect([...selected].sort()).toEqual(["p1", "p2", "p3", "x"]);
    const cleared = toggleSelectAllInColumn(selected, column);
    expect([...cleared]).toEqual(["x"]);
  });

  it("reports none / partial / all column selection", () => {
    const column = ["a", "b", "c"];
    expect(columnSelectionState(new Set(), column)).toBe("none");
    expect(columnSelectionState(new Set(["a"]), column)).toBe("partial");
    expect(columnSelectionState(new Set(["a", "b", "c", "z"]), column)).toBe("all");
  });

  it("bulk-approves only pure proposal selections", () => {
    const proposals = resolveTaskBoardBulkActions([
      { id: "1", state: "submitted", isProposal: true, hardFinishGate: false },
      { id: "2", state: "submitted", isProposal: true, hardFinishGate: false },
    ]);
    expect(proposals.map((a) => a.kind)).toEqual([
      "approve_proposals",
      "reject_proposals",
    ]);
    expect(proposals[0]?.label).toContain("2");

    const mixed = resolveTaskBoardBulkActions([
      { id: "1", state: "submitted", isProposal: true, hardFinishGate: false },
      { id: "2", state: "submitted", isProposal: false, hardFinishGate: false },
    ]);
    expect(mixed).toEqual([]);
  });

  it("intersects transition bulk actions for queue tasks", () => {
    const actions = resolveTaskBoardBulkActions([
      { id: "1", state: "submitted", isProposal: false, hardFinishGate: false },
      { id: "2", state: "submitted", isProposal: false, hardFinishGate: false },
    ]);
    const states = actions
      .filter((a) => a.kind === "transition")
      .map((a) => (a.kind === "transition" ? a.state : ""));
    expect(states).toContain("canceled");
    expect(states).toContain("archived");
    expect(states).not.toContain("submitted");
  });

  it("hides complete when any selected task has a hard finish gate", () => {
    const actions = resolveTaskBoardBulkActions([
      { id: "1", state: "working", isProposal: false, hardFinishGate: true },
      { id: "2", state: "working", isProposal: false, hardFinishGate: false },
    ]);
    const states = actions
      .filter((a) => a.kind === "transition")
      .map((a) => (a.kind === "transition" ? a.state : ""));
    expect(states).not.toContain("completed");
    expect(states).toContain("canceled");
  });
});
