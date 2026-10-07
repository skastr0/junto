// @vitest-environment jsdom
/**
 * The bottom bar's region strip: a small set of keys that each say what
 * they open (an icon and a word), say whether that thing is set, and look
 * pressed only while it is open. Once they were three 26px icons with no
 * words, lit amber both when set and when open, and the Environment screen
 * had no key here at all: the operator could not find it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { modelStore } from "../src/renderer/lib/use-model";
import { region as regionNode } from "./support/model-nodes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName, type Region } from "../src/shared/model";

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

const region = (id: string): Region => regionNode(id,
  { x: 0, y: 0, width: 600, height: 400 }, { label: "backend" });

let host: HTMLDivElement;
let root: Root;

let release: (() => void) | undefined;

// The strip reads the region held in the node store.
const select = async (node: Region) => {
  await act(async () => {
    release?.();
    state$.canvasName.set("factory");
    release = modelStore.adopt({ canvas: asCanvasName("factory"), seq: 0, nodes: [node], wires: [] });
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
  release?.();
  release = undefined;
});

const strip = () => host.querySelector('[role="toolbar"][aria-label="Region fields"]')!;
const keys = () => Array.from(strip().querySelectorAll<HTMLButtonElement>("button"));
const key = (caption: string) => keys().find((button) => button.querySelector(".rts-region-key__caption")?.textContent === caption)!;
const stateWord = (caption: string) => key(caption).querySelector(".rts-region-key__state")?.textContent;

describe("the region strip in the bottom bar", () => {
  it("is three worded keys, in this order: briefing, folder paths, environment", () => {
    const captions = keys().map((button) => button.querySelector(".rts-region-key__caption")?.textContent);
    expect(captions.slice(0, 3)).toEqual(["Briefing", "Folder paths", "Environment"]);
    // Each key draws an icon too; the word is what makes it readable at a glance.
    for (const button of keys().slice(0, 3)) expect(button.querySelector("svg")).not.toBeNull();
  });

  it("each key says in words whether its thing is set, and its tooltip says the same", () => {
    for (const caption of ["Briefing", "Folder paths", "Environment"]) expect(stateWord(caption)).toBe("none yet");
    expect(key("Briefing").getAttribute("title")).toBe("Region briefing: none yet");
    expect(key("Folder paths").getAttribute("title")).toBe("Folder paths: none yet");
    expect(key("Environment").getAttribute("title")).toBe("Environment and secrets: none yet");
  });

  it("a region with all three set says so on each key, and no key looks pressed for it", async () => {
    await select({
      ...region("r2"),
      instruction: "Own the login flow.",
      defaults: { paths: { local: "/srv/app" } },
      environment: { sources: [] },
    });
    for (const caption of ["Briefing", "Folder paths", "Environment"]) {
      expect(stateWord(caption)).toBe("set");
      expect(key(caption).getAttribute("data-state")).toBe("set");
      expect(key(caption).getAttribute("aria-pressed")).toBe("false");
    }
    expect(key("Environment").getAttribute("title")).toBe("Environment and secrets: set");
  });

  it("keeps the names assistive tech and the walks already use", () => {
    expect(key("Briefing").getAttribute("aria-label")).toBe("Region briefing");
    expect(key("Folder paths").getAttribute("aria-label")).toBe("Folder paths");
    expect(key("Environment").getAttribute("aria-label")).toBe("Environment and secrets");
  });

  it("the environment key opens the region's Environment screen and looks pressed only while it is open", async () => {
    expect(host.querySelector('[data-testid="region-environment-modal"]')).toBeNull();
    await act(async () => key("Environment").click());
    const modal = host.querySelector('[data-testid="region-environment-modal"]');
    expect(modal?.getAttribute("data-node")).toBe("r1");
    expect(key("Environment").getAttribute("aria-pressed")).toBe("true");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="close-environment"]')!.click());
    expect(host.querySelector('[data-testid="region-environment-modal"]')).toBeNull();
    expect(key("Environment").getAttribute("aria-pressed")).toBe("false");
  });

  it("selecting another region closes the screen that was open for the first", async () => {
    await act(async () => key("Environment").click());
    expect(host.querySelector('[data-testid="region-environment-modal"]')).not.toBeNull();
    await select(region("r3"));
    expect(host.querySelector('[data-testid="region-environment-modal"]')).toBeNull();
  });
});
