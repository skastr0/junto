// @vitest-environment jsdom
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { LinkNode } from "../src/renderer/components/nodes/LinkNode";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { toFlowOfCanvas } from "../src/renderer/lib/convert";
import { page } from "./support/model-nodes";

it("draws a page from the store with the window document empty", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  const canvas = "native-page-reader";
  state$.canvasName.set(canvas);
  const release = modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, wires: [], nodes: [page("web", { url: "https://native.example.com" })] });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    const flow = toFlowOfCanvas(modelStore.canvasOf(canvas), { canvasName: canvas, resolveActorRef: () => undefined, itemsOf: () => [] });
    await act(async () => root.render(<ReactFlowProvider><ReactFlow nodes={flow.nodes} edges={[]} nodeTypes={{ link: LinkNode }} /></ReactFlowProvider>));
    expect(host.textContent).toContain("native.example.com");
  } finally {
    act(() => root.unmount()); release(); host.remove(); state$.canvasName.set("");
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
