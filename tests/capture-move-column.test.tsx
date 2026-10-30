// @vitest-environment jsdom
/**
 * The desk's Move to column (0.12, the Cmd+T desk): up to three routes with
 * their reasons, the picked one in its amber state, nothing moving on its own,
 * a route into another region moving only on its second press, and the
 * keyboard path the surface's keys reach (focus, arrows, Enter).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import { mintItemId, type ItemId } from "../src/shared/resource-command";
import { makeLocalArtifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { CaptureMoveColumn, useCaptureMove, type CaptureMove } from "../src/renderer/components/capture/CaptureMoveColumn";
import type { CaptureArtifactRef } from "../src/renderer/components/capture/CaptureEditor";
import { artifacts, region } from "./support/model-nodes";

const CANVAS = "desk";
const INBOX = asNodeId("inbox");
const NODES = [
  region("product", { x: 0, y: 0, width: 1400, height: 1000 }, { label: "Product" }),
  region("desk", { x: 2000, y: 0, width: 2000, height: 1000 }, { label: "Desk" }),
  artifacts("specs", { x: 40, y: 40, label: "Specs" }),
  artifacts("ops", { x: 2100, y: 100, label: "Ops" }),
  artifacts("inbox", { x: 2600, y: 400, label: "Inbox" }),
];

let root: Root;
let host: HTMLDivElement;
let release: () => void;
let source: ArtifactsSource;
let move: CaptureMove;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

function Desk({ target }: { readonly target: CaptureArtifactRef | undefined }) {
  move = useCaptureMove(CANVAS, target);
  return <CaptureMoveColumn move={move} canvasName={CANVAS} />;
}

const create = async (nodeId: NodeId, title: string, markdown: string): Promise<ItemId> => {
  const id = mintItemId() as ItemId;
  await source.apply(CANVAS, nodeId, id, mintItemId() as never, { op: "create", title, body: { type: "document", markdown } });
  return id;
};

const mount = async (target: CaptureArtifactRef | undefined): Promise<void> => {
  await act(async () => root.render(<Desk target={target} />));
  await settle();
};

const routeButtons = (): ReadonlyArray<HTMLButtonElement> => [...host.querySelectorAll<HTMLButtonElement>("[data-capture-move-option]")];
const routeNamed = (name: string): HTMLButtonElement => routeButtons().find((one) => one.textContent?.includes(name))!;
const where = async (id: ItemId): Promise<string | undefined> => {
  for (const node of ["inbox", "specs", "ops"]) {
    if ((await source.list(CANVAS, asNodeId(node))).some((head) => head.artifact.artifactId === id)) return node;
  }
  return undefined;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  release = modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
  source = makeLocalArtifactsSource();
  setArtifactsSource(source);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  release();
  vi.unstubAllGlobals();
});

/** A capture in the Inbox (in Desk) like an artifact in Specs (in Product) and one in Ops (in Desk with it). */
const triage = async (): Promise<ItemId> => {
  await create(asNodeId("specs"), "Partner tier", "partner tier pricing three seats invoice");
  await create(asNodeId("ops"), "Revenue forecast", "quarterly revenue forecast churn");
  return create(INBOX, "Pricing call", "Pricing call\npartner tier pricing three seats invoice quarterly revenue forecast churn");
};

describe("the Move to column", () => {
  it("says why nothing can move while no saved capture is open, and ignores every key", async () => {
    await mount(undefined);
    expect(host.textContent).toContain("A capture can move once it is saved");
    expect(routeButtons()).toEqual([]);
    act(() => move.choose(0));
    expect(move.line).toBeNull();
  });

  it("offers its routes, each with its number and why, the first picked, and moves nowhere on its own", async () => {
    const id = await triage();
    await mount({ nodeId: INBOX, artifactId: id });
    expect(move.routes.length).toBeGreaterThan(0);
    expect(move.routes.length).toBeLessThanOrEqual(3);
    expect(move.routes.map((route) => route.title).sort()).toEqual(["Ops", "Specs"]);
    const first = routeButtons()[0]!;
    expect(first.dataset.picked).toBe("true");
    expect(first.querySelector("kbd")?.textContent).toBe("1");
    expect(first.querySelector(".capture-move__why")?.textContent).not.toBe("");
    expect(host.querySelector('[data-testid="capture-move-other"]')?.textContent).toBe("Other Artifacts node…");
    await settle();
    expect(await where(id)).toBe("inbox");
  });

  it("moves at once where no reach changes, and says so", async () => {
    const id = await triage();
    await mount({ nodeId: INBOX, artifactId: id });
    const ops = move.routes.findIndex((route) => route.title === "Ops");
    act(() => move.choose(ops));
    await settle();
    expect(await where(id)).toBe("ops");
    expect(host.querySelector(".capture-move__line")?.textContent).toBe("Moved Pricing call to Ops.");
  });

  it("into another region, says whose reach changes on the first press and moves on the second", async () => {
    const id = await triage();
    await mount({ nodeId: INBOX, artifactId: id });
    const specs = move.routes.findIndex((route) => route.title === "Specs");
    act(() => move.choose(specs));
    await settle();
    expect(await where(id)).toBe("inbox");
    expect(host.querySelector(".capture-move__line")?.textContent).toBe("Seats in Desk will no longer reach this; seats in Product will.");
    expect(routeNamed("Specs").dataset.armed).toBe("true");
    act(() => move.choose(specs));
    await settle();
    expect(await where(id)).toBe("specs");
  });

  it("is a keyboard path: focus lands on the first route, arrows move, Enter routes the focused one", async () => {
    const id = await triage();
    await mount({ nodeId: INBOX, artifactId: id });
    act(() => move.focusFirst());
    expect(document.activeElement).toBe(routeButtons()[0]);
    const ops = move.routes.findIndex((route) => route.title === "Ops");
    for (let at = 0; at < ops; at += 1) {
      act(() => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    }
    expect(document.activeElement).toBe(routeNamed("Ops"));
    expect(routeNamed("Ops").dataset.picked).toBe("true");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => (document.activeElement as HTMLElement).dispatchEvent(enter));
    // Kept from the surface, where Enter would edit the focused row.
    expect(enter.defaultPrevented).toBe(true);
    await settle();
    expect(await where(id)).toBe("ops");
  });

  it("does nothing for a number past the routes it has", async () => {
    const id = await triage();
    await mount({ nodeId: INBOX, artifactId: id });
    act(() => move.choose(move.routes.length));
    await settle();
    expect(await where(id)).toBe("inbox");
    expect(move.line).toBeNull();
  });
});
