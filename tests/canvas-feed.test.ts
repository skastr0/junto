import { afterEach, describe, expect, it } from "vitest";
import { asCanvasName, asNodeId, asWireId } from "../src/shared/model";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { ArtifactHead, ResourceChanged } from "../src/shared/resource-ipc";
import { applyAgentSeatStateEvent, resetAgentSeatState } from "../src/window/lib/agent-seat-state";
import { artifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/window/lib/artifacts-source";
import { regionUrgency$, seatUrgency$ } from "../src/window/lib/region-urgency";
import { state$ } from "../src/window/lib/state";
import { modelStore } from "../src/window/lib/use-model";
import { retainCanvasFeed, retainSceneOps } from "../src/window/canvas/feed";
import type { SceneOp, SeatLive } from "../src/window/canvas/contract";
import { seatCacheWindow$, seatNextTurn$ } from "../src/window/lib/seat-next-launch";
import { THIS_MACHINE } from "./support/machines";
import { artifacts, file, git, link, note, peer, region, seat, stub, taskBoard, terminal, wire } from "./support/model-nodes";

/**
/// The feed's done-test (canvas-gpu-plan.md, track E): with every canvas card
/// unmounted, a seat report still moves the minimap's seat colours
/// (`seatUrgency$`, what CanvasBottomBar's seatMarkOf reads) and the regions'
/// urgency (`regionUrgency$`), and a model `Changed` emits one scene op per
/// row it names — never a rebuild.
 */

const CANVAS = "feed-test";

const seatEvent = (partial: Partial<AgentSeatStateEvent> & { bindingId: string; state: AgentSeatStateEvent["state"] }): AgentSeatStateEvent => ({
  epoch: "e1",
  reason: partial.state,
  confidence: "high",
  at: 1_700_000_000_000,
  ...partial,
});

const releases: Array<() => void> = [];

const originalArtifacts = artifactsSource();

/** A source whose list reads the test answers, as canvas-artifacts.test.tsx's. */
const fakeArtifacts = (base: ArtifactsSource) => {
  const calls: Array<{ readonly nodeId: string; readonly resolve: (heads: ReadonlyArray<ArtifactHead>) => void }> = [];
  const listeners = new Set<(changed: ResourceChanged) => void>();
  const source: ArtifactsSource = {
    ...base,
    list: (_canvas, nodeId) =>
      new Promise((resolve) => calls.push({ nodeId, resolve })),
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const head = (id: string, nodeId: string): ArtifactHead =>
    ({ artifact: { artifactId: id, nodeId, title: id, type: "document", labels: [], archived: false, updatedAt: 1, version: 1 }, body: null, bodyRef: null }) as unknown as ArtifactHead;
  return {
    source,
    /** Answer every waiting read with one head per node. */
    answer: () => {
      for (const call of calls.splice(0)) call.resolve([head(`art-${call.nodeId}`, call.nodeId)]);
    },
  };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  setArtifactsSource(originalArtifacts);
  resetAgentSeatState();
  seatNextTurn$.set({});
  seatCacheWindow$.set({});
  seatUrgency$.set({});
  regionUrgency$.set({});
  state$.regionSeverityByNodeId.set({});
  state$.regionCountsByNodeId.set({});
});

describe("canvas feed with no card mounted", () => {
  it("a seat report moves the minimap's seat colours and the region's urgency", () => {
    state$.canvasName.set(CANVAS);
    // The seat sits inside the region geometrically: the region holds it.
    const releaseModel = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      nodes: [
        region("r1", { x: 0, y: 0, width: 800, height: 600 }),
        seat("seat1", { x: 40, y: 40, z: 1 }),
      ],
      wires: [],
    });
    releases.push(releaseModel);
    releases.push(retainCanvasFeed(CANVAS));

    expect(seatUrgency$["seat1"].peek()).toBeUndefined();
    expect(regionUrgency$["r1"].peek()).toBeUndefined();

    // The seat asks for the operator: attention is the ring's "call".
    applyAgentSeatStateEvent(seatEvent({ bindingId: "binding-seat1", state: "attention", reason: "permission" }));

    expect(seatUrgency$["seat1"].peek()).toBe("needs-you");
    expect(regionUrgency$["r1"].peek()).toEqual({ urgency: "needs-you", reach: "direct" });
  });
});

describe("scene ops", () => {
  it("a model Changed touches only the rows it names, one op per row", () => {
    state$.canvasName.set(CANVAS);
    const releaseModel = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      nodes: [note("n1", "one"), note("n2", "two"), note("n3", "three")],
      wires: [],
    });
    releases.push(releaseModel);

    const ops: SceneOp[] = [];
    releases.push(retainSceneOps(CANVAS, (batch) => ops.push(...batch)));

    // The open pass: one load with every card, then the standing observers'
    // first emissions (theme, selection). Clear them before the change.
    expect(ops.some((op) => op.kind === "load" && op.cards.length === 3)).toBe(true);
    ops.length = 0;

    // A Changed naming two rows: two card ops, nothing else.
    const moved1 = note("n1", "one, moved");
    const moved2 = note("n2", "two, moved");
    modelStore.applyChanged({
      canvas: asCanvasName(CANVAS),
      seq: 1,
      nodes: [moved1, moved2],
      wires: [],
      removedNodes: [],
      removedWires: [],
    });
    const cardOps = ops.filter((op) => op.kind === "card");
    expect(cardOps.map((op) => (op.kind === "card" ? op.fact.id : ""))).toEqual(["n1", "n2"]);
    expect(ops.every((op) => op.kind === "card")).toBe(true);
    ops.length = 0;

    // A Changed naming a removal and an addition: one op each.
    modelStore.applyChanged({
      canvas: asCanvasName(CANVAS),
      seq: 2,
      nodes: [note("n4", "four")],
      wires: [],
      removedNodes: [asNodeId("n3")],
      removedWires: [],
    });
    expect(ops.map((op) => op.kind).sort()).toEqual(["card", "removeCard"]);
    ops.length = 0;

    // A Changed naming nothing the feed draws: no ops at all.
    modelStore.applyChanged({
      canvas: asCanvasName(CANVAS),
      seq: 3,
      nodes: [],
      wires: [],
      removedNodes: [],
      removedWires: [],
    });
    expect(ops).toEqual([]);
  });

  it("a connection focus emits the neighborhood as focusMode, keyboard focus rides the fact", () => {
    state$.canvasName.set(CANVAS);
    const releaseModel = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      nodes: [seat("seatA"), seat("seatB"), note("n1", "lonely")],
      wires: [wire("w1", "seatA", "seatB", "messages")],
    });
    releases.push(releaseModel);

    const ops: SceneOp[] = [];
    releases.push(retainSceneOps(CANVAS, (batch) => ops.push(...batch)));
    ops.length = 0;

    // Focusing seatA cones it and its one wire partner; n1 is an outsider.
    state$.connectionFocusNodeId.set("seatA");
    const focused = ops.filter((op) => op.kind === "selection").at(-1);
    expect(focused).toMatchObject({
      kind: "selection",
      fact: {
        connectionFocusNodeId: "seatA",
        focusMode: {
          kind: "connection",
          rootId: "seatA",
          memberIds: expect.arrayContaining(["seatA", "seatB"]),
          leadIds: [],
          wireIds: [asWireId("w1")],
        },
      },
    });
    ops.length = 0;

    // Keyboard focus is its own field on the same fact.
    state$.focusedNodeId.set("seatB");
    const keyed = ops.filter((op) => op.kind === "selection").at(-1);
    expect(keyed).toMatchObject({ kind: "selection", fact: { focusedNodeId: "seatB" } });
    state$.focusedNodeId.set("");
    state$.connectionFocusNodeId.set("");
  });
});

describe("kind and spine live facts", () => {
  it("reach the card ops with no card mounted, and follow the stores", async () => {
    state$.canvasName.set(CANVAS);
    const releaseModel = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      nodes: [
        taskBoard("tasks1"),
        terminal("term1"),
        artifacts("art1"),
        peer("peer1"),
        stub("stub1", { of: "page", host: THIS_MACHINE }),
        stub("stub2"),
        link("link1"),
        git("git1"),
        file("file1"),
        seat("seatA", { x: 0, y: 0 }),
        seat("seatB", { x: 600, y: 0 }),
      ],
      wires: [wire("w1", "seatA", "seatB", "messages")],
    });
    releases.push(releaseModel);

    const fake = fakeArtifacts(artifactsSource());
    setArtifactsSource(fake.source);

    const ops: SceneOp[] = [];
    releases.push(retainCanvasFeed(CANVAS, (batch) => ops.push(...batch)));

    const load = ops.find((op) => op.kind === "load");
    expect(load?.kind).toBe("load");
    if (load?.kind !== "load") return;
    const byId = new Map(load.cards.map((card) => [card.id, card]));

    // The task board: its counts line, zeroed ledger, the enqueue instrument.
    const tasks = byId.get("tasks1");
    expect(tasks?.kind?.line).toBe("0 backlog, 0 open, 0 done");
    expect(tasks?.kind?.ledger).toEqual({ kind: "task", finished: 0, open: 0, asks: 0, stuck: 0, backlog: 0 });
    expect(tasks?.kind?.state).toBe("resting");
    expect(tasks?.kind?.stateSince).toEqual(expect.any(Number));

    // The bound terminal: its launch line and where it sits.
    const term = byId.get("term1");
    expect(term?.kind?.name).toBe("terminal");
    expect(term?.kind?.line).toBe("shell on studio");
    expect(term?.kind?.unbound).toBeUndefined();

    // Peer and stubs: dashed spine facts that say where they live.
    expect(byId.get("peer1")?.spine).toMatchObject({ leaf: "seat on studio", dashed: true, status: "none" });
    expect(byId.get("stub1")?.spine).toMatchObject({ leaf: "page on studio", dashed: true });
    expect(byId.get("stub2")?.spine).toMatchObject({ leaf: "git copy", dashed: true });
    expect(byId.get("peer1")?.derived.remote).toEqual({ machine: "studio" });

    // Link, git (no runtime: "reading") and file: their leaf lines.
    expect(byId.get("link1")?.kind).toMatchObject({ name: "example.com", line: "example.com/docs" });
    expect(byId.get("git1")?.kind).toMatchObject({ name: "git", line: "reading" });
    expect(byId.get("file1")?.kind).toMatchObject({ name: "file1.txt", lineTitle: "/Users/me/Projects/junto/file1.txt" });

    // The loom plans the wire's route with no card mounted, after the load.
    const routesOp = ops.find((op) => op.kind === "routes");
    expect(routesOp?.kind).toBe("routes");
    if (routesOp?.kind === "routes") {
      const fact = routesOp.set.find((route) => route.id === asWireId("w1"));
      expect(fact).toBeDefined();
      // The plan anchors on the rectangle the canvas draws (a seat is 216 by
      // 56 whatever its stored row says), so the engine keeps its route
      // instead of falling back to the elbow on every frame.
      expect(fact?.source).toEqual({ x: 216, y: 28 });
      expect(fact?.target).toEqual({ x: 600, y: 28 });
    }

    // The artifacts count starts empty and lands with its async read.
    const art = byId.get("art1");
    expect(art?.kind).toMatchObject({ line: "0 artifacts", ledger: { kind: "artifacts", count: 0 } });
    ops.length = 0;
    fake.answer();
    await flush();
    const artOps = ops.filter((op) => op.kind === "card" && op.fact.id === "art1");
    expect(artOps.at(-1)).toMatchObject({ kind: "card", fact: { kind: { line: "1 artifact", ledger: { kind: "artifacts", count: 1 } } } });

    // A seat report moves the terminal's line and ring, one card op, no card mounted.
    ops.length = 0;
    applyAgentSeatStateEvent(seatEvent({ bindingId: "terminal-term1", state: "attention", reason: "permission" }));
    const termOps = ops.filter((op) => op.kind === "card" && op.fact.id === "term1");
    expect(termOps).toHaveLength(1);
    expect(termOps[0]).toMatchObject({
      kind: "card",
      fact: { kind: { line: "permission", state: "waiting" } },
    });
  });
});

describe("seat status line", () => {
  const seatOps = (ops: ReadonlyArray<SceneOp>, id: string): ReadonlyArray<SeatLive> =>
    ops.flatMap((op) => (op.kind === "seat" && op.id === id ? [op.live] : []));

  it("a still seat reads the next-turn answer and its cache window, as its card would", () => {
    state$.canvasName.set(CANVAS);
    const releaseModel = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      nodes: [seat("seatA")],
      wires: [],
    });
    releases.push(releaseModel);

    const ops: SceneOp[] = [];
    releases.push(retainSceneOps(CANVAS, (batch) => ops.push(...batch)));

    // No answer yet: the still seat reads its control state.
    expect(seatOps(ops, "seatA").at(-1)?.line).toBe("not running");
    ops.length = 0;

    // Main's answer lands: the next turn starts fresh, the line says so.
    seatNextTurn$[CANVAS]["seatA"].set({ fresh: true });
    expect(seatOps(ops, "seatA").at(-1)?.line).toBe("fresh next");
    ops.length = 0;

    // A continuing turn instead reads against the cache window, on the same
    // clock the card's status line uses.
    seatNextTurn$[CANVAS]["seatA"].set({ fresh: false });
    const now = Date.now();
    seatCacheWindow$[CANVAS]["seatA"].set({
      windowMinutes: 60,
      stillSince: now - 14 * 60_000,
      windowEndsAt: now + 46 * 60_000,
      pastWindow: false,
      pastByMs: 0,
    });
    const warm = seatOps(ops, "seatA").at(-1);
    expect(warm?.line).toBe("not running 14m");
    expect(warm?.saying).toEqual({ kind: "cache" });
    ops.length = 0;

    // Past the window the same line ends in a comma and the amber words.
    seatCacheWindow$[CANVAS]["seatA"].set({
      windowMinutes: 60,
      stillSince: now - 74 * 60_000,
      windowEndsAt: now - 14 * 60_000,
      pastWindow: true,
      pastByMs: 14 * 60_000,
    });
    const expired = seatOps(ops, "seatA").at(-1);
    expect(expired?.line).toBe("not running 1h 14m,");
    expect(expired?.saying).toEqual({ kind: "cache", expired: true });
    ops.length = 0;

    // "fresh next" and the cache window never stand together.
    seatNextTurn$[CANVAS]["seatA"].set({ fresh: true });
    expect(seatOps(ops, "seatA").at(-1)?.line).toBe("fresh next");
    ops.length = 0;

    // A turn ends the still: the answer is dropped and the line is the state.
    applyAgentSeatStateEvent(seatEvent({ bindingId: "binding-seatA", state: "working" }));
    const running = seatOps(ops, "seatA").at(-1);
    expect(running?.line).not.toBe("fresh next");
    expect(seatNextTurn$[CANVAS]["seatA"].peek()).toBeUndefined();
    expect(seatCacheWindow$[CANVAS]["seatA"].peek()).toBeUndefined();
  });
});
