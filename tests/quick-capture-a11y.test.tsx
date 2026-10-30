// @vitest-environment jsdom
/**
 * Quick capture's desk, for a reader: three regions named, one live region that
 * was there before it had anything to say, and a Tab order that visits the list,
 * then the writing, then Move to.
 *
 * The announcement is the one that regressed once already: a status element
 * added together with its words is never read, so the sentence lives in a
 * region mounted for the surface's life and the visible line carries no role.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId } from "../src/shared/resource-command";
import { makeLocalArtifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { closeOperatorModal, openOperatorModal } from "../src/renderer/lib/operator-modal";
import { setCaptureInbox } from "../src/renderer/lib/capture-inbox";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { QuickCapture } from "../src/renderer/components/capture/QuickCapture";
import { artifacts, canvasOf, region } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const CANVAS = "capture-a11y";
const id = asNodeId;
const NODES = [
  region("junto", { x: 0, y: 0, width: 2000, height: 1200 }, { label: "Junto" }),
  artifacts("inbox", { x: 10, y: 10, label: "Inbox" }),
];

let host: HTMLDivElement;
let root: Root;
let release: () => void;
let source: ArtifactsSource;
let clock = 100;

const flush = async (turns = 2): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
};
const settle = (): Promise<void> => flush(14);

const regionNames = (): string[] =>
  [...document.querySelectorAll(".quick-capture__body > section")].map((section) => {
    const labelledBy = section.getAttribute("aria-labelledby");
    return labelledBy === null ? "" : (document.getElementById(labelledBy)?.textContent ?? "").trim();
  });
// The Captures column's: Move to keeps its own line for how a move went.
const liveRegions = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".quick-capture__list [role='status']")];
const search = (): HTMLInputElement => {
  const field = document.querySelector<HTMLInputElement>(".quick-capture__search input");
  if (field === null) throw new Error("no search field");
  return field;
};
const type = async (value: string): Promise<void> => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(search(), value);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};

beforeEach(async () => {
  clock = 100;
  release = modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
  state$.canvasName.set(CANVAS);
  setCaptureInbox(CANVAS, "inbox");
  source = makeLocalArtifactsSource({ kind: "operator" }, () => (clock += 10));
  setArtifactsSource(source);
  await source.apply(CANVAS, id("inbox"), mintItemId(), mintItemId() as never, {
    op: "create",
    title: "Plan",
    body: { type: "document", markdown: "the plan" },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => openOperatorModal("capture"));
  await act(async () => root.render(<QuickCapture />));
  await settle();
});

afterEach(() => {
  act(() => closeOperatorModal());
  act(() => root.unmount());
  host.remove();
  setCaptureInbox(CANVAS, null);
  release();
});

it("names its three columns as regions: Captures, Writing, Move to", () => {
  expect(regionNames()).toEqual(["Captures", "Writing", "Move to"]);
});

it("mounts its live region before it has anything to say, and says the empty line once", async () => {
  // Nothing is announced by opening the surface: the region is there, empty.
  const live = liveRegions();
  expect(live).toHaveLength(1);
  expect(live[0]?.textContent).toBe("");

  await type("zzzz no match");
  await settle();
  // The visible line is words for eyes; the mounted region carries them to ears.
  expect(document.querySelector(".quick-capture__none")?.getAttribute("role")).toBeNull();
  expect(liveRegions()).toHaveLength(1);
  expect(liveRegions()[0]?.textContent).toBe("No artifact matches.");
});
