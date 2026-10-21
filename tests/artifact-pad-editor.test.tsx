// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactPadPatch } from "../src/shared/artifact";
import { emptyPad } from "../src/shared/pad";
import { ArtifactPadEditor } from "../src/renderer/components/artifacts/ArtifactPadEditor";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root;
let host: HTMLDivElement;
let onPatch: ReturnType<typeof vi.fn<(patches: ReadonlyArray<ArtifactPadPatch>) => Promise<string | null>>>;

const pointer = (target: Element, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
const svg = () => {
  const el = host.querySelector<SVGSVGElement>('[data-testid="pad-svg"]')!;
  el.setPointerCapture = () => {};
  return el;
};
const drag = async (from: [number, number], to: [number, number]) => {
  const el = svg();
  await act(async () => pointer(el, "pointerdown", ...from));
  await act(async () => pointer(el, "pointermove", ...to));
  await act(async () => pointer(el, "pointerup", ...to));
};

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

it("renders a pinless pad with no P tool, and P selects nothing", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={emptyPad()} onPatch={onPatch} />));
  expect(host.querySelector('[data-testid="pad-svg"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="pad-tool-pin"]')).toBeNull();
  expect(host.querySelector(".pad-toolbar__hint")?.textContent).not.toContain("P");
  await act(async () => svg().dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true })));
  await drag([20, 30], [80, 70]);
  expect(onPatch).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="pad-pin"]')).toBeNull();
});

it("a committed shape emits one upsert patch through onPatch", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={emptyPad()} onPatch={onPatch} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="pad-tool-box"]')!.click());
  await drag([10, 10], [110, 90]);
  expect(onPatch).toHaveBeenCalledTimes(1);
  const [patch] = onPatch.mock.calls[0]![0];
  expect(patch).toMatchObject({ op: "upsert", shape: { type: "box", w: 100, h: 80 } });
});

it("the comment tool turns a dragged area into a box and writes no pin", async () => {
  const onCommentBox = vi.fn();
  await act(async () => root.render(
    <ArtifactPadEditor pad={emptyPad()} onPatch={onPatch} onCommentBox={onCommentBox} />,
  ));
  const tool = host.querySelector<HTMLButtonElement>('[data-testid="pad-tool-pin"]')!;
  expect(tool.getAttribute("aria-label")).toBe("Comment on an area (P)");
  expect(host.querySelector(".pad-toolbar__hint")?.textContent).toContain("Pcomment");
  await act(async () => tool.click());
  await drag([20, 30], [80, 70]);
  expect(onCommentBox).toHaveBeenCalledWith({ x: 20, y: 30, w: 60, h: 40 });
  expect(onPatch).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="pad-pin"]')).toBeNull();
  await drag([90, 90], [90, 90]);
  expect(onCommentBox).toHaveBeenCalledTimes(1);
});

it("read only renders the pad without tools", async () => {
  await act(async () => root.render(<ArtifactPadEditor pad={emptyPad()} readOnly onPatch={onPatch} />));
  expect(host.querySelector('[data-testid="artifact-pad"]')!.getAttribute("data-readonly")).toBe("true");
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
});
