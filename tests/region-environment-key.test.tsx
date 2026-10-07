// @vitest-environment jsdom
/**
 * The region's Environment screen is reachable from the bottom bar: a key in
 * the region strip beside Folder paths. Once, it opened only from the small
 * toolbar above a selected region, and the operator could not find it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The bottom bar's modules measure themselves on import; jsdom has no observer.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

vi.mock("../src/renderer/components/region-environment/RegionEnvironmentModal", () => ({
  RegionEnvironmentModal: ({ nodeId, onClose }: { readonly nodeId: string; readonly onClose: () => void }) => (
    <div data-testid="region-environment-modal" data-node={nodeId}>
      <button data-testid="close-environment" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

const { state$ } = await import("../src/renderer/lib/state");
const { KindSurface } = await import("../src/renderer/components/rts/KindSurface");

const region = (id: string, environment?: unknown): CanvasNode =>
  ({
    id,
    type: "group",
    label: "backend",
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    ether: { region: environment === undefined ? {} : { environment } },
  }) as unknown as CanvasNode;

let host: HTMLDivElement;
let root: Root;

const select = async (node: CanvasNode) => {
  await act(async () => {
    state$.doc.set({ nodes: [node], edges: [] });
    state$.selectedNodeIds.set([node.id]);
    state$.selectedNodeId.set(node.id);
    state$.selectedEdgeId.set("");
  });
};

beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await select(region("r1"));
  await act(async () => root.render(<KindSurface />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const strip = () => host.querySelector('[role="toolbar"][aria-label="Region fields"]')!;
const key = () => strip().querySelector<HTMLButtonElement>('[data-testid="rts-region-environment"]');

describe("the region strip in the bottom bar", () => {
  it("has an Environment key right after Folder paths, named in plain words", () => {
    const labels = Array.from(strip().querySelectorAll("button")).map((button) => button.getAttribute("title"));
    expect(labels.indexOf("Environment and secrets")).toBe(labels.indexOf("Folder paths") + 1);
    expect(key()?.getAttribute("aria-label")).toBe("Environment and secrets");
    expect(host.querySelector('[data-testid="region-environment-modal"]')).toBeNull();
  });

  it("opens the region's Environment screen, and closing it goes back", async () => {
    await act(async () => key()!.click());
    const modal = host.querySelector('[data-testid="region-environment-modal"]');
    expect(modal?.getAttribute("data-node")).toBe("r1");
    expect(key()?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="close-environment"]')!.click());
    expect(host.querySelector('[data-testid="region-environment-modal"]')).toBeNull();
  });

  it("shows as set when the region already has an environment", async () => {
    expect(key()?.getAttribute("aria-pressed")).not.toBe("true");
    await select(region("r2", { variables: [] }));
    expect(key()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("selecting another region closes the screen that was open for the first", async () => {
    await act(async () => key()!.click());
    expect(host.querySelector('[data-testid="region-environment-modal"]')).not.toBeNull();
    await select(region("r3"));
    expect(host.querySelector('[data-testid="region-environment-modal"]')).toBeNull();
  });
});
