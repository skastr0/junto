// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SheetPatch } from "../src/shared/artifact";
import { artifactLink } from "../src/shared/artifact-link";
import type { MentionOf } from "../src/shared/mention";
import type { SheetGrid } from "../src/shared/model/sheet";
import { asNodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import type { LinkableArtifact } from "../src/renderer/lib/artifact-link-draft";

const { opened, heads } = vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  return { opened: [] as unknown[], heads: new Map<string, ReadonlyArray<{ artifact: { artifactId: string; title: string; archived: boolean } }>>() };
});

vi.mock("../src/renderer/lib/mention-open", () => ({ openMention: (ref: unknown) => opened.push(ref) }));
vi.mock("../src/renderer/lib/artifacts-source", () => ({
  artifactsSource: () => ({
    list: async (_canvas: string, nodeId: string) => heads.get(nodeId) ?? [],
    onChanged: () => () => {},
  }),
}));

const { ArtifactSheetEditor } = await import("../src/renderer/components/artifacts/ArtifactSheetEditor");

const shelf = asNodeId("artifacts-shelf");
const ref = (artifactId: string): MentionOf<"artifact"> => ({ kind: "artifact", nodeId: shelf, artifactId: artifactId as ItemId });
const plan: LinkableArtifact = { ref: ref("01M5ZBT64KHP4JGH67RV1YCS6B"), title: "Launch plan", type: "document" };
const planLink = artifactLink(plan.ref, "Launch plan", "factory");

const cellLinks = {
  canvasName: "factory",
  links: { artifacts: [plan] },
  nodeKindOf: (nodeId: string) => (nodeId === shelf ? ("artifacts" as const) : undefined),
};

const grid: SheetGrid = {
  columns: [{ id: "c1", name: "Name" }, { id: "c2", name: "Notes" }],
  rows: [
    { id: "r1", cells: { c1: "ant", c2: `see ${planLink} first` } },
    { id: "r2", cells: {} },
  ],
};

let root: Root;
let host: HTMLDivElement;
let onPatch: ReturnType<typeof vi.fn<(patches: ReadonlyArray<SheetPatch>) => Promise<string | null>>>;

const cell = (a1: string) => host.querySelector<HTMLInputElement>(`[data-cell="${a1}"]`);
const field = () => host.querySelector<HTMLTextAreaElement>('[data-testid="artifact-sheet-cell-edit"]');
const words = (a1: string) => cell(a1)!.closest("td")!.querySelector(".junto-artifact-sheet__words");
const key = (on: HTMLElement, init: KeyboardEventInit) =>
  act(() => {
    on.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
const type = (text: string) => {
  const element = field()!;
  const next = `${element.value}${text}`;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, next);
    element.setSelectionRange(next.length, next.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const render = async (props: { readonly readOnly?: boolean } = {}) => {
  await act(async () => root.render(<ArtifactSheetEditor grid={grid} onPatch={onPatch} cellLinks={cellLinks} {...props} />));
  await act(async () => {});
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  opened.length = 0;
  heads.clear();
  host = document.createElement("div");
  host.setAttribute("data-focus-surface", "");
  document.body.append(host);
  root = createRoot(host);
  onPatch = vi.fn(async () => null);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("a link in a cell reads as its words, the artifact's title as it is now, never its address", async () => {
  heads.set(shelf, [{ artifact: { artifactId: plan.ref.artifactId, title: "Launch plan v2", archived: false } }]);
  await render();
  expect(cell("B1")!.value).toBe("see Launch plan v2 first");
  expect(cell("B1")!.dataset.links).toBe("true");
  expect(words("B1")!.querySelector(".junto-artifact-sheet__link")!.textContent).toBe("Launch plan v2");
  // A plain cell draws nothing over itself.
  expect(cell("A1")!.dataset.links).toBeUndefined();
  expect(words("A1")).toBeNull();
});

it("a link to an artifact gone keeps the title it was written with", async () => {
  await render();
  expect(cell("B1")!.value).toBe("see Launch plan first");
});

it("[[ in a cell's edit offers the artifacts in reach, and a pick writes the link by id", async () => {
  await render();
  await act(async () => cell("A2")!.focus());
  key(cell("A2")!, { key: "Enter" });
  expect(field()).not.toBeNull();
  expect(document.activeElement).toBe(field());
  type("[[Lau");
  const options = [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  expect(options[0]).toContain("Launch plan");
  key(field()!, { key: "Enter" });
  // The pick placed the link; the field is still the edit.
  expect(field()).not.toBeNull();
  expect(field()!.value).toBe("[[Launch plan]] ");
  key(field()!, { key: "Enter" });
  await act(async () => {});
  // The space the pick put after the link, last in the cell, does not land.
  expect(onPatch.mock.calls.at(-1)![0]).toEqual([{ op: "cell", rowId: "r2", columnId: "c1", value: planLink }]);
  // Enter moved down a row; the grid has none, so the cell keeps the keyboard.
  expect(field()).toBeNull();
  expect(document.activeElement).toBe(cell("A2"));
});

it("Escape in a link edit puts the cell back and the cell keeps the keyboard", async () => {
  await render();
  await act(async () => cell("B1")!.focus());
  key(cell("B1")!, { key: "Enter" });
  type(" more");
  key(field()!, { key: "Escape" });
  expect(field()).toBeNull();
  expect(document.activeElement).toBe(cell("B1"));
  expect(cell("B1")!.value).toBe("see Launch plan first");
});

it("Cmd+Enter on a cell opens its first link", async () => {
  await render();
  await act(async () => cell("B1")!.focus());
  key(cell("B1")!, { key: "Enter", metaKey: true });
  expect(opened).toEqual([plan.ref]);
  expect(field()).toBeNull();
  key(cell("A1")!, { key: "Enter", metaKey: true });
  expect(opened).toHaveLength(1);
});

it("read only draws links and edits nothing", async () => {
  await render({ readOnly: true });
  expect(cell("B1")!.value).toBe("see Launch plan first");
  await act(async () => cell("B1")!.focus());
  key(cell("B1")!, { key: "Enter" });
  expect(field()).toBeNull();
});
