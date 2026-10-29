// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName, type Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, type ItemId } from "../src/shared/resource-command";
import { makeLocalArtifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { ArtifactMoveDialog, type MoveDone } from "../src/renderer/components/artifacts/ArtifactMove";
import {
  matchTargets,
  moveEntryTitle,
  movedLine,
  moveSetOf,
  moveTargets,
  rangeOf,
  reachChange,
  reachLine,
} from "../src/renderer/components/artifacts/artifact-move-model";
import { artifacts, canvasOf, region } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out: a highlight brought into view goes nowhere.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

// Junto holds Product and Release, side by side. Specs sits in a region of
// its own inside Product, Drafts in Product itself, Shelf in Release, and
// Inbox outside every region.
const NODES = [
  region("junto", { x: 0, y: 0, width: 4000, height: 2000 }, { label: "Junto" }),
  region("product", { x: 10, y: 10, width: 1400, height: 1000 }, { label: "Product" }),
  region("specs-area", { x: 20, y: 20, width: 400, height: 400 }, { label: "Specs area" }),
  region("release", { x: 1500, y: 10, width: 1400, height: 1000 }, { label: "Release" }),
  artifacts("specs", { x: 40, y: 40, label: "Specs" }),
  artifacts("drafts", { x: 600, y: 600, label: "Drafts" }),
  artifacts("shelf", { x: 1600, y: 100, label: "Shelf" }),
  artifacts("inbox", { x: 6000, y: 6000, label: "Inbox" }),
];
const canvas: Canvas = canvasOf(NODES);
const id = asNodeId;

describe("where Move to offers, and whose reach it says", () => {
  it("lists every other Artifacts node by name with its innermost regions, the current one left out", () => {
    expect(moveTargets(canvas, id("specs"))).toEqual([
      { id: "drafts", title: "Drafts", place: "Product" },
      { id: "inbox", title: "Inbox", place: "No region" },
      { id: "shelf", title: "Shelf", place: "Release" },
    ]);
    expect(matchTargets(moveTargets(canvas, id("specs")), "rel").map((target) => target.id)).toEqual(["shelf"]);
  });

  it("names the outermost region that loses reach and the one that gains it", () => {
    const change = reachChange(canvas, id("specs"), id("shelf"));
    expect(change).toEqual({ lost: ["Product"], gained: ["Release"] });
    expect(reachLine(change, 1)).toBe("Seats in Product will no longer reach this; seats in Release will.");
    expect(reachLine(change, 3)).toBe("Seats in Product will no longer reach these; seats in Release will.");
  });

  it("says nothing when no seat's reach changes, and one side when only one does", () => {
    // Specs area is below Product: a seat there reached Drafts already, and one in Product reaches both.
    expect(reachLine(reachChange(canvas, id("drafts"), id("specs")), 1)).toBe(null);
    expect(reachLine(reachChange(canvas, id("specs"), id("drafts")), 1)).toBe(null);
    // Outside every region, every region reaches it.
    expect(reachLine(reachChange(canvas, id("specs"), id("inbox")), 1)).toBe("Seats in Release will reach this too.");
    expect(reachLine(reachChange(canvas, id("inbox"), id("shelf")), 2)).toBe("Seats in Product will no longer reach these.");
  });

  it("takes the selection from a row in it, that row alone from one outside it, and the selection from the header", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveSetOf(order, new Set(["c", "a"]), "c")).toEqual(["a", "c"]);
    expect(moveSetOf(order, new Set(["c", "a"]), "b")).toEqual(["b"]);
    expect(moveSetOf(order, new Set(["a"]), "a")).toEqual(["a"]);
    expect(moveSetOf(order, new Set(["d", "b"]), null)).toEqual(["b", "d"]);
    expect(rangeOf(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeOf(order, null, "b")).toEqual(["b"]);
  });

  it("says a finished move, and history's line names both nodes", () => {
    expect(movedLine(["Plan"], 0, "Shelf")).toBe("Moved Plan to Shelf.");
    expect(movedLine(["Plan", "Notes"], 0, "Shelf")).toBe("Moved 2 artifacts to Shelf.");
    expect(movedLine(["Plan"], 1, "Shelf")).toBe("Queued: Plan moves to Shelf when the editing machine rules it.");
    const nodeOf = (node: string) => canvas.nodes.get(id(node));
    expect(moveEntryTitle(nodeOf, id("specs"), id("shelf"))).toBe("Moved from Specs to Shelf");
    expect(moveEntryTitle(nodeOf, id("gone"), id("shelf"))).toBe("Moved from a node no longer on the canvas to Shelf");
  });
});

describe("the Move to picker", () => {
  const CANVAS = "move-window";
  let host: HTMLDivElement;
  let root: Root;
  let release: () => void;
  let source: ArtifactsSource;
  let done: MoveDone | null;
  let plan: ItemId;
  let notes: ItemId;

  beforeEach(async () => {
    release = modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
    source = makeLocalArtifactsSource();
    setArtifactsSource(source);
    plan = mintItemId();
    notes = mintItemId();
    await source.apply(CANVAS, id("specs"), plan, mintItemId() as never, { op: "create", title: "Plan", body: { type: "document", markdown: "" } });
    await source.apply(CANVAS, id("specs"), notes, mintItemId() as never, { op: "create", title: "Notes", body: { type: "document", markdown: "" } });
    done = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    release();
  });

  const open = (moving: ReadonlyArray<{ readonly artifactId: ItemId; readonly title: string }>) =>
    act(() =>
      root.render(
        <ArtifactMoveDialog canvasName={CANVAS} from={id("specs")} artifacts={moving} onDone={(moved) => (done = moved)} onCancel={() => undefined} />,
      ),
    );
  const field = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const press = (key: string) =>
    act(async () => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  const reach = () => document.querySelector(".artifact-move__reach")?.textContent;

  it("offers the other nodes with their region, says the reach change on the pick, and moves on Enter", async () => {
    await open([{ artifactId: plan, title: "Plan" }]);
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? document.body.textContent).toContain("Move Plan");
    expect(options()).toEqual(["DraftsProduct", "InboxNo region", "ShelfRelease"]);
    await press("ArrowDown");
    // Drafts is in Product too: nothing to say.
    expect(reach()).toBe("");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(reach()).toBe("Seats in Product will no longer reach this; seats in Release will.");
    expect(done).toBe(null);
    await press("Enter");
    expect(done).toEqual({ titles: ["Plan"], queued: 0, to: { id: "shelf", title: "Shelf", place: "Release" } });
    expect((await source.list(CANVAS, id("shelf"))).map((head) => head.artifact.title)).toEqual(["Plan"]);
    expect((await source.list(CANVAS, id("specs"))).map((head) => head.artifact.title)).toEqual(["Notes"]);
    const moves = await source.moves(CANVAS, plan);
    expect(moves.map(({ from, to, by }) => ({ from, to, by }))).toEqual([{ from: "specs", to: "shelf", by: { kind: "operator" } }]);
  });

  it("moves several at once, each its own move", async () => {
    await open([
      { artifactId: plan, title: "Plan" },
      { artifactId: notes, title: "Notes" },
    ]);
    expect(document.body.textContent).toContain("Move 2 artifacts");
    await press("ArrowDown");
    await press("Enter");
    expect(done?.titles).toEqual(["Plan", "Notes"]);
    expect((await source.list(CANVAS, id("drafts"))).length).toBe(2);
    expect(await source.list(CANVAS, id("specs"))).toEqual([]);
  });

  it("with nothing picked, Enter on a list of one picks it so its line shows first", async () => {
    await open([{ artifactId: plan, title: "Plan" }]);
    await act(async () => {
      const input = field();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "shelf");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options()).toEqual(["ShelfRelease"]);
    await press("Enter");
    expect(done).toBe(null);
    expect(reach()).toBe("Seats in Product will no longer reach this; seats in Release will.");
    await press("Enter");
    expect(done?.to.id).toBe("shelf");
  });

  it("keeps a refusal in the picker and tries only what did not move", async () => {
    const gone = mintItemId();
    await open([
      { artifactId: plan, title: "Plan" },
      { artifactId: gone, title: "Gone" },
    ]);
    await press("ArrowDown");
    await press("Enter");
    expect(done).toBe(null);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/^Gone was not moved: /);
    expect(document.body.textContent).toContain("Move Gone");
    expect((await source.list(CANVAS, id("drafts"))).map((head) => head.artifact.title)).toEqual(["Plan"]);
  });
});
