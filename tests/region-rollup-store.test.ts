import { observable, observe } from "@legendapp/state";
import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node, asCanvasName, type Changed, type Opened, type Wire } from "../src/shared/model";
import { Task } from "../src/shared/work-model";
import type { AgentActivity, RegionRollup } from "../src/shared/region-rollup";
import { deriveRegionRollups } from "../src/shared/region-rollup";
import type { WorkSurfaceActivity } from "../src/shared/terminal";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";
import { createModelStore } from "../src/renderer/lib/model-store";
import { createRegionRollupStore } from "../src/renderer/lib/region-rollup-store";

const name = asCanvasName("regions");
const placed = { x: 10, y: 10, width: 40, height: 40, z: 0 };
const node = (row: object) => Schema.decodeUnknownSync(Node)({ ...placed, ...row });
const region = (id: string, x: number, width = 200) => node({ kind: "region", id, x, y: 0, width, height: 200, label: id, hold: false });
const note = (id: string, x: number) => node({ kind: "note", id, x, text: id });
const agent = (id: string, x = 10) => node({
  kind: "agent", id, x, label: id, agentKey: `local:${id}`, bindingId: `binding-${id}`,
  host: "local", harness: "codex", overseer: false, onRemove: "detach",
});
const wire = (id: string, from: string, to: string) => ({ id, from, to, verb: "contributes" }) as Wire;

const harness = async (nodes: Node[], wires: Wire[] = []) => {
  let notify: ((event: Changed) => void) | undefined;
  let seq = 1;
  const model = createModelStore(() => ({
    modelOpen: async () => ({ canvas: name, seq, nodes, wires }) as Opened,
    modelCommand: async () => ({ seq }),
    onModelChanged: (listener) => { notify = listener; return () => { notify = undefined; }; },
  }));
  const close = model.open(name);
  await model.ready(name);
  const refs = observable([actorRefFixture("seat", name)]);
  const items = observable<Record<string, Task[]>>({});
  const activity = observable<Record<string, AgentActivity>>({});
  const surfaces = observable<Record<string, WorkSurfaceActivity>>({});
  const derive = vi.fn(deriveRegionRollups);
  const store = createRegionRollupStore({
    model, actorRefs: () => refs.get(), items: (_canvas, id) => items[id].get() ?? [],
    agentActivity: (key) => activity[key].get() ?? {},
    surface: (binding) => surfaces[binding].get(),
  }, derive);
  const release = store.retain(name);
  const state = store.state(name);
  const byId = (id: string) => state.byRegionId[id].peek() as RegionRollup;
  const computed = () => derive.mock.calls.map(([input]) => [...input.canvas.nodes.values()].find((n) => n.kind === "region")?.id);
  const change = (rows: Partial<Changed>) => notify?.({ canvas: name, seq: ++seq, nodes: [], wires: [], removedNodes: [], removedWires: [], ...rows } as Changed);
  return { model, state, byId, items, refs, activity, surfaces, derive, computed, change, dispose: () => { release(); close(); } };
};

describe("local per-region rollups", () => {
  it("renames a member and removes an in-region note without waking another region", async () => {
    const h = await harness([region("left", 0), region("right", 300), agent("seat"), note("inside", 80), note("other", 310), note("outside", 700)]);
    const right = h.byId("right");
    const changedRight = vi.fn();
    const off = observe(() => h.state.byRegionId.right.get(), changedRight);
    changedRight.mockClear(); h.derive.mockClear();
    try {
      h.change({ nodes: [node({ ...agent("seat"), label: "renamed" })] });
      expect(h.byId("left").members.find((m) => m.nodeId === "seat")?.label).toBe("renamed");
      expect(h.computed()).toEqual(["left"]);
      expect(h.byId("right")).toBe(right);
      expect(changedRight).not.toHaveBeenCalled();
      h.derive.mockClear();
      h.change({ removedNodes: ["inside" as Node["id"]] });
      expect(h.byId("left").counts.total).toBe(1);
      expect(h.computed().every((id) => id === "left")).toBe(true);
      expect(h.computed().length).toBeGreaterThan(0);
      expect(changedRight).not.toHaveBeenCalled();
      h.derive.mockClear();
      h.change({ nodes: [node({ ...note("outside", 700), text: "outside rename" })] });
      h.change({ nodes: [note("outside", 900)] });
      h.change({ nodes: [note("new-outside", 800)] });
      h.change({ removedNodes: ["outside" as Node["id"]] });
      expect(h.derive).not.toHaveBeenCalled();
    } finally { off(); h.dispose(); }
  });

  it("tracks membership boundaries, nesting, paint order and wire endpoints locally", async () => {
    const h = await harness([region("outer", 0, 600), region("inner", 0), agent("seat"), note("outside", 700), node({ kind: "task", id: "tasks", x: 800 }), node({ kind: "task", id: "other-tasks", x: 900 })], [wire("w", "seat", "tasks")]);
    try {
      expect(h.byId("outer").members.map((m) => m.nodeId)).toContain("seat");
      expect(h.byId("inner").members.map((m) => m.nodeId)).toContain("seat");
      h.change({ nodes: [note("outside", 80)] });
      expect(h.byId("inner").counts.total).toBe(2);
      h.change({ nodes: [note("outside", 180)] }); // its full rect crosses the inner edge
      expect(h.byId("inner").counts.total).toBe(1);
      expect(h.byId("outer").counts.total).toBe(2);
      h.derive.mockClear();
      h.change({ wires: [wire("w", "seat", "other-tasks")] });
      expect(h.computed().sort()).toEqual(["inner", "outer"]);
      h.derive.mockClear();
      h.items.tasks.set([]);
      expect(h.derive).not.toHaveBeenCalled();
      h.change({ removedNodes: ["inner" as Node["id"]] });
      expect(h.state.regionIds.peek()).toEqual(["outer"]);
      expect(h.state.byRegionId.inner.peek()).toBeUndefined();
    } finally { h.dispose(); }
  });

  it("keeps a seat blocked by exact external Work rows without a main rollup", async () => {
    const h = await harness([region("left", 0), region("right", 300), agent("seat"), note("other", 310), node({ kind: "task", id: "tasks", x: 700 })], [wire("w", "seat", "tasks")]);
    const wait = Schema.decodeUnknownSync(Task)({ id: "wait", state: "input-required", history: [{ messageId: "brief", role: "user", parts: [{ kind: "text", text: "approve delivery" }] }], claimedBy: actorRefFixture("seat", name).seatId });
    try {
      h.derive.mockClear();
      h.items.tasks.set([wait]);
      expect(h.byId("left")).toMatchObject({ severity: "blocked", counts: { blocked: 1 } });
      expect(h.byId("left").members[0]?.reasons).toEqual(["edge:1 need input - approve delivery"]);
      expect(h.computed()).toEqual(["left"]);
      h.derive.mockClear();
      h.items.unrelated.set([wait]);
      expect(h.derive).not.toHaveBeenCalled();
      h.refs.set([actorRefFixture("seat", name), actorRefFixture("seat", name)]);
      expect(h.byId("left").severity).toBe("idle"); // ambiguous identity fails closed
      h.refs.set([actorRefFixture("seat", name)]);
      expect(h.byId("left").severity).toBe("blocked");
      h.items.tasks.set([]);
      expect(h.byId("left").severity).toBe("idle");
      h.activity["local:seat"].set({ permissionPending: true });
      expect(h.byId("left").severity).toBe("attention");
      h.activity["local:seat"].set({ permissionPending: false });
      h.surfaces["binding-seat"].set({ session: "running", harness: "working", source: "native" });
      expect(h.byId("left").severity).toBe("working");
      h.surfaces["binding-seat"].set({ session: "running", harness: "idle", ready: true, source: "native" });
      expect(h.byId("left").severity).toBe("ready");
      h.surfaces["binding-seat"].set({ session: "exited", harness: "unknown", source: "native" });
      expect(h.byId("left").severity).toBe("idle");
    } finally { h.dispose(); }
  });

  it("disposes selectors with the last holder", async () => {
    const h = await harness([region("left", 0), agent("seat")]);
    h.dispose(); h.derive.mockClear();
    h.activity["local:seat"].set({ permissionPending: true });
    expect(h.derive).not.toHaveBeenCalled();
  });
});
