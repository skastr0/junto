// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SheetPatch } from "../src/shared/artifact";
import type { SheetGrid } from "../src/shared/model/sheet";
import { ArtifactSheetEditor, selectionRange } from "../src/renderer/components/artifacts/ArtifactSheetEditor";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
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
