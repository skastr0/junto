// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactPadPatch } from "../src/shared/artifact";
import { asPadElementId, emptyPad, type Pad } from "../src/shared/pad";
import { ArtifactPadEditor } from "../src/renderer/components/artifacts/ArtifactPadEditor";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root;
let host: HTMLDivElement;
let onPatch: ReturnType<typeof vi.fn<(patches: ReadonlyArray<ArtifactPadPatch>) => Promise<string | null>>>;

const byTestId = <T extends Element = HTMLButtonElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);
const pointer = (target: Element, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
const svg = () => {
  const el = byTestId<SVGSVGElement>("pad-svg")!;
  el.setPointerCapture = () => {};
  return el;
};
const click = async (x: number, y: number) => {
  await act(async () => pointer(svg(), "pointerdown", x, y));
  await act(async () => pointer(svg(), "pointerup", x, y));
};

const withBox = (): Pad => ({
  ...emptyPad(),
  shapes: [{ id: asPadElementId("b"), type: "box", x: 0, y: 0, w: 100, h: 60, z: 0 }],
});

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
});

it("the toolbar offers every drawable kind and the stencil row", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={emptyPad()} onPatch={onPatch} />));
  for (const tool of ["select", "box", "ellipse", "triangle", "diamond", "cylinder", "label", "image", "ink"]) {
    expect(byTestId(`pad-tool-${tool}`), tool).not.toBeNull();
  }
  for (const stencil of ["sticky", "process", "decision", "store", "flow"]) {
    expect(byTestId(`pad-stencil-${stencil}`), stencil).not.toBeNull();
  }
});

it("a stencil writes its shapes and edge as one batch", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={emptyPad()} onPatch={onPatch} />));
  await act(async () => byTestId("pad-stencil-flow")!.click());
  expect(onPatch).toHaveBeenCalledTimes(1);
  const batch = onPatch.mock.calls[0]![0];
  expect(batch.map((patch) => patch.op === "upsert" ? patch.layer : patch.op)).toEqual(["shape", "shape", "edge"]);
});

it("the decision stencil is a diamond with its text", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={emptyPad()} onPatch={onPatch} />));
  await act(async () => byTestId("pad-stencil-decision")!.click());
  expect(onPatch.mock.calls[0]![0][0]).toMatchObject({ shape: { type: "diamond", text: "Decide?" } });
});

it("a selected shape shows the strip, and status and fill write the shape", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={withBox()} onPatch={onPatch} />));
  expect(byTestId("pad-selbar")).toBeNull();
  await click(50, 30);
  expect(byTestId("pad-selbar")).not.toBeNull();
  await act(async () => byTestId("pad-status-blocked")!.click());
  expect(onPatch.mock.calls[0]![0][0]).toMatchObject({ shape: { id: "b", status: "blocked" } });
  await act(async () => byTestId("pad-fill-green")!.click());
  expect(onPatch.mock.calls[1]![0][0]).toMatchObject({ shape: { fill: "#5fb98e2e", status: "blocked" } });
  await act(async () => byTestId("pad-status-none")!.click());
  const cleared = onPatch.mock.calls[2]![0][0];
  expect(cleared.op === "upsert" && cleared.layer === "shape" && "status" in cleared.shape).toBe(false);
});

it("Text on a box opens the editor and Enter writes the text", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={withBox()} onPatch={onPatch} />));
  await click(50, 30);
  await act(async () => byTestId("pad-edit-text")!.click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Shape text"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "Ship it");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(onPatch.mock.calls.at(-1)![0][0]).toMatchObject({ shape: { id: "b", text: "Ship it" } });
});

it("each toolbar is one Tab stop, and the arrows, Home and End move along it", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={withBox()} onPatch={onPatch} />));
  const bar = host.querySelector<HTMLElement>('[role="toolbar"][aria-label="Pad tools"]')!;
  const stops = () => Array.from(bar.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.tabIndex === 0);
  expect(stops().map((b) => b.dataset.testid)).toEqual(["pad-tool-select"]);
  const key = async (name: string) =>
    act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
  await act(async () => byTestId("pad-tool-select")!.focus());
  await key("ArrowRight");
  expect((document.activeElement as HTMLElement).dataset.testid).toBe("pad-tool-box");
  expect(stops()).toEqual([document.activeElement]);
  await key("ArrowLeft");
  await key("ArrowLeft");
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Fit view");
  await key("Home");
  expect((document.activeElement as HTMLElement).dataset.testid).toBe("pad-tool-select");
  await click(50, 30);
  const strip = byTestId<HTMLElement>("pad-selbar")!;
  expect(Array.from(strip.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.tabIndex === 0))
    .toEqual([byTestId("pad-status-none")]);
});

const typeAndEnter = async (input: HTMLInputElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
};

it("double-click on a box edits its text", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={withBox()} onPatch={onPatch} />));
  await act(async () => svg().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50, clientY: 30 })));
  await typeAndEnter(host.querySelector<HTMLInputElement>('input[aria-label="Shape text"]')!, "Double");
  expect(onPatch.mock.calls.at(-1)![0][0]).toMatchObject({ shape: { id: "b", text: "Double" } });
});

it("the strip sets and clears an edge label", async () => {
  const pad: Pad = {
    ...emptyPad(),
    shapes: [
      { id: asPadElementId("a"), type: "box", x: 0, y: 0, w: 60, h: 40, z: 0 },
      { id: asPadElementId("c"), type: "box", x: 200, y: 0, w: 60, h: 40, z: 1 },
    ],
    edges: [{ id: asPadElementId("e"), from: asPadElementId("a"), to: asPadElementId("c"), fromSide: "right", toSide: "left" }],
  };
  await act(async () => root.render(<ArtifactPadEditor pad={pad} onPatch={onPatch} />));
  await click(130, 20);
  expect(byTestId("pad-selbar")?.getAttribute("aria-label")).toBe("Edge");
  await act(async () => byTestId("pad-edit-text")!.click());
  await typeAndEnter(host.querySelector<HTMLInputElement>('input[aria-label="Edge label"]')!, "then");
  expect(onPatch.mock.calls.at(-1)![0][0]).toMatchObject({ op: "upsert", layer: "edge", edge: { id: "e", label: "then" } });
});
