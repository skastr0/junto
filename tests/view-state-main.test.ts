/**
 * The window's view-state store (0.11, 04, V1): hydration announces the
 * canvases it filled, a write sends only the rows that changed, a push lands
 * in every reader, and a V3 read keeps its object until its row changes.
 * Driven through a fake `window.junto.viewState`, the preload's interface.
 */
import { describe, expect, it } from "vitest";
import type { JuntoViewStateApi } from "../src/shared/ipc";
import { artifactLabelOf, type ArtifactLabel } from "../src/shared/artifact-labels";
import type { ViewStateEvent, ViewStateSnapshot, ViewStateWrite } from "../src/shared/view-state";
import { createMainViewState } from "../src/renderer/lib/view-state-main";

const EMPTY: ViewStateSnapshot = { commandGroups: {}, nodes: {}, focusSizes: {}, sections: {} };

type Fake = {
  readonly api: JuntoViewStateApi;
  readonly applied: ViewStateWrite[];
  readonly push: (event: ViewStateEvent) => void;
  readonly setSnapshot: (next: ViewStateSnapshot) => void;
};

const fake = (initial: ViewStateSnapshot = EMPTY): Fake => {
  const applied: ViewStateWrite[] = [];
  const listeners = new Set<(event: ViewStateEvent) => void>();
  let snapshot = initial;
  return {
    applied,
    api: {
      snapshot: async () => snapshot,
      apply: async (write) => {
        applied.push(write);
        return { ok: true };
      },
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    push: (event) => {
      for (const listener of listeners) listener(event);
    },
    setSnapshot: (next) => {
      snapshot = next;
    },
  };
};

const tick = () => new Promise<void>((done) => setTimeout(done, 0));

const label = (raw: string): ArtifactLabel => {
  const folded = artifactLabelOf(raw);
  if (folded === undefined) throw new Error(`refused: ${raw}`);
  return folded;
};

const hydrated = async (snapshot: ViewStateSnapshot = EMPTY) => {
  const transport = fake(snapshot);
  const state = createMainViewState(transport.api);
  await tick();
  return { ...transport, state };
};

describe("the main-backed view-state store", () => {
  it("fills a canvas on load and announces it, and reads a stranger as undefined", async () => {
    const transport = fake({
      ...EMPTY,
      commandGroups: { main: { slots: [{ kind: "fixed", nodeId: "a" }, ...Array.from({ length: 8 }, () => ({ kind: "empty" as const }))], extras: [["a", "b"]] } },
    });
    const state = createMainViewState(transport.api);
    const announced: string[] = [];
    state.viewState.onChange((canvas) => announced.push(canvas));
    await tick();
    expect(announced).toEqual(["main"]);
    expect(state.viewState.read("main")!.slots[0]).toEqual({ kind: "fixed", nodeId: "a" });
    expect(state.viewState.read("main")!.extras).toEqual([["a", "b"]]);
    expect(state.viewState.read("other")).toBeUndefined();
    expect(state.viewState.read("")!).toBeUndefined();
  });

  it("writes one slot row at a time and applies this window's own change at once", async () => {
    const { state, applied } = await hydrated();
    state.viewState.writeSlot("main", 3, { kind: "fixed", nodeId: "a" });
    expect(applied).toEqual([{ area: "command-slot", canvasName: "main", slot: 3, value: { kind: "fixed", nodeId: "a" } }]);
    expect(state.viewState.read("main")!.slots[3]).toEqual({ kind: "fixed", nodeId: "a" });
    state.viewState.writeExtras("main", [["a", "b"]]);
    expect(applied[1]).toEqual({ area: "command-extras", canvasName: "main", value: [["a", "b"]] });
    // A blank canvas writes nothing.
    state.viewState.writeSlot("", 0, { kind: "empty" });
    expect(applied).toHaveLength(2);
  });

  it("sends only the node rows that changed, labels sorted", async () => {
    const { state, applied } = await hydrated({
      ...EMPTY,
      nodes: { main: { "artifacts-1": { artifactsFilter: { type: "document", archived: false, labels: [] }, openItem: { kind: "artifact", id: "a" } } } },
    });
    state.nodeView.writeArtifacts("main", "artifacts-1", { type: "document", archived: false, labels: [label("b"), label("a")], open: "a" });
    expect(applied).toEqual([
      { area: "artifacts-filter", canvasName: "main", nodeId: "artifacts-1", value: { type: "document", archived: false, labels: [label("a"), label("b")] } },
    ]);
    state.nodeView.writeArtifacts("main", "artifacts-1", { type: "document", archived: false, labels: [label("a"), label("b")], open: "b" });
    expect(applied[1]).toEqual({ area: "open-item", canvasName: "main", nodeId: "artifacts-1", value: { kind: "artifact", id: "b" } });
    // Nothing changed: nothing sent.
    state.nodeView.writeArtifacts("main", "artifacts-1", { type: "document", archived: false, labels: [label("a"), label("b")], open: "b" });
    expect(applied).toHaveLength(2);
  });

  it("keeps a V3 read's object until its row changes, and a push lands in it", async () => {
    const { state, push } = await hydrated({
      ...EMPTY,
      nodes: { main: { "artifacts-1": { artifactsFilter: { type: "all", archived: false, labels: [] }, openItem: { kind: "artifact", id: "a" } } } },
    });
    const first = state.nodeView.artifacts("main", "artifacts-1");
    expect(first).toEqual({ type: "all", archived: false, labels: [], open: "a" });
    expect(state.nodeView.artifacts("main", "artifacts-1")).toBe(first);
    // A command-group row does not touch a node read.
    state.viewState.writeSlot("main", 0, { kind: "fixed", nodeId: "a" });
    expect(state.nodeView.artifacts("main", "artifacts-1")).toBe(first);
    push({ area: "artifacts-filter", canvasName: "main", nodeId: "artifacts-1", value: { type: "pad", archived: true, labels: [] } });
    const next = state.nodeView.artifacts("main", "artifacts-1");
    expect(next).not.toBe(first);
    expect(next).toEqual({ type: "pad", archived: true, labels: [], open: "a" });
  });

  it("reads the snapshot again when main says rows went with a delete", async () => {
    const { state, push, setSnapshot } = await hydrated({
      ...EMPTY,
      commandGroups: { main: { slots: [{ kind: "fixed", nodeId: "a" }, ...Array.from({ length: 8 }, () => ({ kind: "empty" as const }))], extras: [] } },
      nodes: { main: { "artifacts-1": { artifactsFilter: { type: "document", archived: false, labels: [] } } } },
    });
    const announced: string[] = [];
    state.viewState.onChange((canvas) => announced.push(canvas));
    expect(state.nodeView.artifacts("main", "artifacts-1")?.type).toBe("document");
    setSnapshot(EMPTY);
    push({ area: "reload" });
    await tick();
    expect(state.nodeView.artifacts("main", "artifacts-1")).toBeUndefined();
    expect(state.viewState.read("main")).toBeUndefined();
    // A canvas whose board went is announced too, so V2 drops its cache.
    expect(announced).toContain("main");
  });

  it("reads the actor rail expanded by default, and writes both machine-wide flags as one section row", async () => {
    const { state, applied } = await hydrated();
    expect(state.nodeView.actorRailExpanded()).toBe(true);
    expect(state.nodeView.commentsRailOpen()).toBe(false);
    state.nodeView.writeActorRailExpanded(false);
    state.nodeView.writeCommentsRailOpen(true);
    expect(applied).toEqual([
      { area: "section", section: "seat-rail", open: false },
      { area: "section", section: "artifact-comments", open: true },
    ]);
    expect(state.nodeView.actorRailExpanded()).toBe(false);
    expect(state.nodeView.commentsRailOpen()).toBe(true);
    state.nodeView.writeCommentsRailOpen(true);
    expect(applied).toHaveLength(2);
  });

  it("keeps a surface size whole-pixel and stable across reads", async () => {
    const { state, applied } = await hydrated();
    state.nodeView.writeSurfaceSize("Tasks", { width: 800.4, height: 600.6 });
    expect(applied).toEqual([{ area: "focus-size", surface: "Tasks", value: { width: 800, height: 601 } }]);
    const size = state.nodeView.surfaceSize("Tasks");
    expect(size).toEqual({ width: 800, height: 601 });
    expect(state.nodeView.surfaceSize("Tasks")).toBe(size);
    state.nodeView.writeSurfaceSize("Tasks", { width: 800, height: 601 });
    expect(applied).toHaveLength(1);
    state.nodeView.writeSurfaceSize("Tasks", null);
    expect(applied[1]).toEqual({ area: "focus-size", surface: "Tasks", value: null });
    expect(state.nodeView.surfaceSize("Tasks")).toBeUndefined();
  });
});
