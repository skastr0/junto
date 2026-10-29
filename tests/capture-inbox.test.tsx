// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { setNodeViewStore } from "../src/renderer/lib/node-view-state";
import { makeMemoryNodeViewStore } from "../src/renderer/lib/view-state-stand-in";
import { artifacts, region } from "./support/model-nodes";

// Main has the added node only once the flush resolves: the order is what the Inbox row depends on.
const sent: string[] = [];
let flush: () => void = () => undefined;
vi.mock("../src/renderer/lib/mutations", () => ({
  addNode: (node: { id: string }) => sent.push(`add ${node.id}`),
  renameNode: (id: string, name: string) => sent.push(`rename ${id} ${name}`),
  flushPendingCanvasSave: () => new Promise<void>((done) => (flush = done)),
}));

const { captureInboxOf, edgeSpot, makeCaptureInbox, setCaptureInbox, INBOX_NAME } = await import("../src/renderer/lib/capture-inbox");
const { CaptureInboxAsk } = await import("../src/renderer/components/capture/CaptureInboxAsk");
const { InboxSettingsSection } = await import("../src/renderer/components/settings/InboxSettingsSection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "capture-inbox";
const NODES = [
  region("product", { x: 0, y: 0, width: 1000, height: 800 }, { label: "Product" }),
  artifacts("specs", { x: 40, y: 40, label: "Specs" }),
  artifacts("drafts", { x: 2000, y: 100, label: "Drafts" }),
];

let host: HTMLDivElement;
let root: Root;
let release: () => void;

beforeEach(() => {
  sent.length = 0;
  setNodeViewStore(makeMemoryNodeViewStore());
  release = modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
  state$.canvasName.set(CANVAS);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  release();
});

const rows = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')];

describe("where a new Inbox goes", () => {
  it("sits at the left edge of what is on the canvas, below it, and at the origin on an empty one", () => {
    expect(edgeSpot([])).toEqual({ x: 0, y: 0 });
    expect(
      edgeSpot([
        { x: 40, y: 40, width: 240, height: 120 },
        { x: 2000, y: 100, width: 240, height: 120 },
        { x: 10, y: 700, width: 100, height: 100 },
      ]),
    ).toEqual({ x: 10, y: 880 });
  });
});

describe("the first Cmd+T's ask", () => {
  it("lists the Artifacts nodes with their region, and a pick sets the Inbox and says so", () => {
    const chosen: string[] = [];
    act(() => root.render(<CaptureInboxAsk canvas={CANVAS} onChosen={(id) => chosen.push(id)} />));
    expect(rows().map((row) => row.textContent)).toEqual(["DraftsNo region", "SpecsProduct"]);
    expect(captureInboxOf(CANVAS)).toBeUndefined();
    act(() => rows()[1]!.click());
    expect(chosen).toEqual(["specs"]);
    expect(captureInboxOf(CANVAS)).toBe("specs");
  });

  it("moves focus with the arrows without picking", () => {
    act(() => root.render(<CaptureInboxAsk canvas={CANVAS} onChosen={() => undefined} />));
    const [first, second] = rows();
    act(() => {
      first!.focus();
      first!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(second);
    expect(captureInboxOf(CANVAS)).toBeUndefined();
  });

  it("Make an Inbox adds the node, names it, and sets it only after main has taken it", async () => {
    const chosen: string[] = [];
    act(() => root.render(<CaptureInboxAsk canvas={CANVAS} onChosen={(id) => chosen.push(id)} />));
    const make = [...host.querySelectorAll("button")].find((button) => button.textContent === "Make an Inbox")!;
    await act(async () => make.click());
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^add artifacts-/);
    expect(sent[1]).toMatch(new RegExp(`^rename artifacts-\\S+ ${INBOX_NAME}$`));
    expect(captureInboxOf(CANVAS)).toBeUndefined();
    await act(async () => flush());
    expect(chosen).toHaveLength(1);
    expect(captureInboxOf(CANVAS)).toBe(chosen[0]);
  });

  it("refuses to add to a canvas that is not the one in front", async () => {
    await expect(makeCaptureInbox("elsewhere")).rejects.toThrow(/not the one in front of you/);
    expect(sent).toEqual([]);
  });
});

describe("Settings, Inbox", () => {
  it("says there is none, shows the pick checked once made, and asks again on request", () => {
    act(() => root.render(<InboxSettingsSection />));
    expect(host.textContent).toContain("have no home yet");
    act(() => rows()[0]!.click());
    expect(captureInboxOf(CANVAS)).toBe("drafts");
    expect(host.textContent).toContain("land in Drafts");
    expect(rows()[0]!.getAttribute("aria-checked")).toBe("true");
    const again = [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Ask again"))!;
    act(() => again.click());
    expect(captureInboxOf(CANVAS)).toBeUndefined();
    setCaptureInbox(CANVAS, "specs");
    expect(captureInboxOf(CANVAS)).toBe("specs");
  });
});
