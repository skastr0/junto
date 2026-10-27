// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SheetPatch } from "../src/shared/artifact";
import type { SheetGrid } from "../src/shared/model/sheet";
import { ArtifactSheetEditor, selectionRange } from "../src/renderer/components/artifacts/ArtifactSheetEditor";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

let root: Root;
let host: HTMLDivElement;
let onPatch: ReturnType<typeof vi.fn<(patches: ReadonlyArray<SheetPatch>) => Promise<string | null>>>;
const grid: SheetGrid = {
  columns: [{ id: "c1", name: "Name" }, { id: "c2", name: "Count" }],
  rows: [{ id: "r1", cells: { c1: "ant" } }, { id: "r2", cells: {} }],
};

const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const cell = (a1: string) => host.querySelector<HTMLInputElement>(`[data-cell="${a1}"]`)!;
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  // As in the app, the sheet sits in the Artifacts modal's focus surface.
  host.setAttribute("data-focus-surface", "");
  document.body.append(host);
  root = createRoot(host);
  onPatch = vi.fn(async () => null);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("typing a cell emits one cell patch, on blur, and shows it at once", async () => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  const b2 = cell("B2");
  await act(async () => b2.focus());
  await act(async () => { setValue(b2, "4"); setValue(b2, "42"); });
  expect(onPatch).not.toHaveBeenCalled();
  await act(async () => b2.blur());
  expect(onPatch).toHaveBeenCalledTimes(1);
  expect(onPatch.mock.calls[0]![0]).toEqual([{ op: "cell", rowId: "r2", columnId: "c2", value: "42" }]);
  expect(cell("B2").value).toBe("42");
});

it("typing settles into one cell patch after the debounce", async () => {
  vi.useFakeTimers();
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  const a1 = cell("A1");
  await act(async () => { setValue(a1, "ante"); setValue(a1, "antelope"); });
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(onPatch).toHaveBeenCalledTimes(1);
  expect(onPatch.mock.calls[0]![0]).toEqual([{ op: "cell", rowId: "r1", columnId: "c1", value: "antelope" }]);
});

it("add row emits row.add with an id the grid does not hold", async () => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  await act(async () => button("Row").click());
  const [patch] = onPatch.mock.calls[0]![0];
  expect(patch!.op).toBe("row.add");
  const rowId = (patch as { rowId: string }).rowId;
  expect(grid.rows.map((row) => row.id)).not.toContain(rowId);
  expect(host.querySelector('[data-testid="artifact-sheet-grid"]')!.getAttribute("data-row-count")).toBe("3");
});

it("a refusal puts the grid back and says why", async () => {
  onPatch.mockResolvedValueOnce("a sheet holds 500 rows");
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  await act(async () => button("Row").click());
  expect(host.querySelector('[role="status"]')!.textContent).toBe("a sheet holds 500 rows");
  expect(host.querySelector('[data-testid="artifact-sheet-grid"]')!.getAttribute("data-row-count")).toBe("2");
});

it("comment on a cell names it B2-style, and a shift-click range top left first", async () => {
  const onCommentCells = vi.fn();
  await act(async () => root.render(
    <ArtifactSheetEditor grid={grid} onPatch={onPatch} onCommentCells={onCommentCells} />,
  ));
  await act(async () => cell("B2").focus());
  const comment = host.querySelector<HTMLButtonElement>('[data-testid="artifact-sheet-comment"]')!;
  await act(async () => comment.click());
  expect(onCommentCells).toHaveBeenLastCalledWith("B2");
  await act(async () => cell("A1").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true })));
  await act(async () => comment.click());
  expect(onCommentCells).toHaveBeenLastCalledWith("A1:B2");
  expect(selectionRange({ anchor: { row: 0, column: 1 }, focus: { row: 2, column: 0 } })).toBe("A1:B3");
});

it("read only writes nothing and offers no structure controls", async () => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} readOnly onPatch={onPatch} />));
  expect(cell("A1").readOnly).toBe(true);
  expect(button("Row")).toBeUndefined();
});

it("a new grid from the host re-syncs the view", async () => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  const next: SheetGrid = { ...grid, rows: [{ id: "r1", cells: { c1: "bee" } }] };
  await act(async () => root.render(<ArtifactSheetEditor grid={next} onPatch={onPatch} />));
  expect(cell("A1").value).toBe("bee");
  expect(cell("A2")).toBeNull();
});

const key = (target: HTMLElement, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
const active = () => document.activeElement as HTMLInputElement;

it("is one Tab stop: arrows move the active cell, Shift+arrow grows the range", async () => {
  const onCommentCells = vi.fn();
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} onCommentCells={onCommentCells} />));
  const cells = [...host.querySelectorAll<HTMLInputElement>("[data-cell]")];
  expect(cells.filter((input) => input.tabIndex === 0).map((input) => input.dataset.cell)).toEqual(["A1"]);
  expect([...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Delete row"]')].every((b) => b.tabIndex === -1)).toBe(true);
  await act(async () => cell("A1").focus());
  await act(async () => { key(active(), { key: "ArrowRight" }); });
  expect(active().dataset.cell).toBe("B1");
  expect(cell("B1").tabIndex).toBe(0);
  expect(cell("A1").tabIndex).toBe(-1);
  await act(async () => { key(active(), { key: "ArrowDown", shiftKey: true }); });
  expect(active().dataset.cell).toBe("B2");
  await act(async () => { key(active(), { key: "ArrowLeft", shiftKey: true }); });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="artifact-sheet-comment"]')!.click());
  expect(onCommentCells).toHaveBeenLastCalledWith("A1:B2");
  expect(host.querySelectorAll('td[aria-selected="true"]')).toHaveLength(4);
  // The edge stops the cell; it never wraps.
  await act(async () => { key(active(), { key: "ArrowLeft" }); });
  expect(active().dataset.cell).toBe("A2");
});

it("a cell only navigates until Enter, F2 or a typed character starts an edit", async () => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  await act(async () => cell("A1").focus());
  expect(cell("A1").readOnly).toBe(true);
  await act(async () => { key(active(), { key: "Enter" }); });
  expect(cell("A1").readOnly).toBe(false);
  expect(host.querySelector('[data-testid="artifact-sheet-status"]')!.textContent).toBe("Editing A1");
  await act(async () => { setValue(cell("A1"), "antelope"); });
  await act(async () => { key(active(), { key: "Enter" }); });
  expect(onPatch.mock.calls[0]![0]).toEqual([{ op: "cell", rowId: "r1", columnId: "c1", value: "antelope" }]);
  // Enter commits and moves down, out of the edit.
  expect(active().dataset.cell).toBe("A2");
  expect(cell("A2").readOnly).toBe(true);
  await act(async () => { key(active(), { key: "7" }); });
  expect(cell("A2").readOnly).toBe(false);
  expect(cell("A2").value).toBe("7");
  await act(async () => { key(active(), { key: "Tab" }); });
  expect(onPatch.mock.calls[1]![0]).toEqual([{ op: "cell", rowId: "r2", columnId: "c1", value: "7" }]);
  expect(active().dataset.cell).toBe("B2");
  await act(async () => { key(active(), { key: "F2" }); });
  expect(cell("B2").readOnly).toBe(false);
});

it("Escape puts the cell back and stays on it; Delete clears; Cmd+Backspace removes the row", async () => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  await act(async () => cell("A1").focus());
  await act(async () => { key(active(), { key: "x" }); });
  expect(cell("A1").value).toBe("x");
  let escaped = true;
  document.body.addEventListener("keydown", (event) => { if (event.key === "Escape") escaped = false; }, { once: true });
  await act(async () => { key(active(), { key: "Escape" }); });
  expect(escaped, "Escape in an edit stays in the sheet").toBe(true);
  expect(cell("A1").value).toBe("ant");
  expect(cell("A1").readOnly).toBe(true);
  expect(active().dataset.cell).toBe("A1");
  expect(onPatch).not.toHaveBeenCalled();
  await act(async () => { key(active(), { key: "Delete" }); });
  expect(onPatch.mock.calls[0]![0]).toEqual([{ op: "cell", rowId: "r1", columnId: "c1", value: "" }]);
  await act(async () => { key(active(), { key: "Backspace", metaKey: true }); });
  expect(onPatch.mock.calls[1]![0]).toEqual([{ op: "row.remove", rowId: "r1" }]);
});

it("tells assistive tech the sheet's size and each row's place", async () => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} />));
  const table = host.querySelector("table")!;
  expect(table.getAttribute("role")).toBe("grid");
  expect(table.getAttribute("aria-rowcount")).toBe("3");
  expect([...host.querySelectorAll("tbody tr[aria-rowindex]")].map((row) => row.getAttribute("aria-rowindex"))).toEqual(["2", "3"]);
  expect(host.querySelectorAll('tbody th[scope="row"]')).toHaveLength(2);
  expect(host.querySelector("[data-pane-entry]")!.hasAttribute("tabindex")).toBe(true);
});
