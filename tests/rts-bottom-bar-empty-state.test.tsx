// @vitest-environment jsdom
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node, Wire } from "@shared/model";
import { batch } from "@legendapp/state";
import { modelStore } from "../src/renderer/lib/use-model";

// jsdom has no ResizeObserver; a module the bar imports builds one at load.
vi.hoisted(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

import { RtsBottomBar } from "../src/renderer/components/rts/RtsBottomBar";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const canvasName = "rts-regression";
const nativeNote = (id: string, x = 0, z = 0, text = id) => Schema.decodeUnknownSync(Node)({ kind: "note", id, x, y: 0, width: 200, height: 80, z, text });
const seed = (...ids: string[]) => batch(() => {
  state$.canvasName.set(canvasName);
  modelStore.canvas$(canvasName).nodes.set(Object.fromEntries(ids.map(id => [id, nativeNote(id)])));
  modelStore.canvas$(canvasName).nodeIds.set(ids);
});

describe("RTS bottom bar follows displayed facts", () => {
  let host: HTMLDivElement;
  let root: Root;
  let errors: ReturnType<typeof vi.spyOn>;
  let canvasContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    canvasContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    errors.mockRestore();
    canvasContext.mockRestore();
    seed();
    state$.canvasName.set("");
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set("");
    modelStore.canvas$(canvasName).wires.set({});
    modelStore.canvas$(canvasName).wireIds.set([]);
  });

  const reactErrors = (): string[] => errors.mock.calls.map((call: unknown[]) => String(call[0]));

  it("shows the empty state, then the node again when it comes back", () => {
    act(() => {
      seed("a", "b");
      state$.selectedNodeId.set("a");
      state$.selectedNodeIds.set(["a"]);
      root.render(<RtsBottomBar minimap={null} />);
    });
    expect(host.querySelector(".rts-cmd__title")?.textContent).toBe("a");

    // The node goes while it is still the selection.
    expect(() => act(() => seed("b"))).not.toThrow();
    expect(host.textContent).toContain("No selection");

    // It comes back, then goes again, in the same mounted bar.
    expect(() => act(() => seed("a", "b"))).not.toThrow();
    expect(host.querySelector(".rts-cmd__title")?.textContent).toBe("a");
    expect(() => act(() => seed("b"))).not.toThrow();

    expect(host.textContent).toContain("No selection");
    expect(reactErrors()).toEqual([]);
  });
  it("does not commit any bar descendant for moves, restacking, or repeated selection ids", () => {
    let commits = 0;
    act(() => {
      seed("a", "b", "outside");
      state$.selectedNodeId.set("a"); state$.selectedNodeIds.set(["a"]);
      root.render(<Profiler id="bar" onRender={() => { commits += 1; }}><RtsBottomBar minimap={null} /></Profiler>);
    });
    commits = 0;
    act(() => batch(() => {
      modelStore.node$(canvasName, "a").set(nativeNote("a", 100, 10));
      modelStore.node$(canvasName, "outside").set(nativeNote("outside", 900, 11));
      modelStore.canvas$(canvasName).nodeIds.set(["b", "a", "outside"]);
      modelStore.canvas$(canvasName).seq.set(2);
      state$.selectedNodeIds.set(["a"]);
    }));
    expect(commits).toBe(0);
    act(() => modelStore.node$(canvasName, "a").set(nativeNote("a", 100, 10, "Renamed")));
    expect(host.querySelector(".rts-cmd__title")?.textContent).toBe("Renamed");
    expect(commits).toBeGreaterThan(0);
    act(() => { state$.selectedNodeId.set(""); state$.selectedNodeIds.set(["b", "a"]); });
    expect(host.textContent).toContain("shared settings");
    commits = 0;
    act(() => batch(() => {
      state$.selectedNodeIds.set(["a", "b"]);
      modelStore.node$(canvasName, "b").set(nativeNote("b", 500, 20));
      modelStore.canvas$(canvasName).nodeIds.set(["outside", "a", "b"]);
    }));
    expect(commits).toBe(0);
    expect(reactErrors()).toEqual([]);
  });

  it("updates region membership and title while ignoring moves within the same region", () => {
    let commits = 0;
    const region = Schema.decodeUnknownSync(Node)({ kind: "region", id: "region", x: 0, y: 0, width: 1000, height: 1000, z: 0, label: "Team", hold: false });
    act(() => {
      seed("a");
      modelStore.node$(canvasName, "region").set(region);
      modelStore.canvas$(canvasName).nodeIds.set(["region", "a"]);
      state$.selectedNodeId.set("region"); state$.selectedNodeIds.set(["region"]);
      root.render(<Profiler id="bar" onRender={() => { commits += 1; }}><RtsBottomBar minimap={null} /></Profiler>);
    });
    expect(host.textContent).toContain("Team");
    commits = 0;
    act(() => modelStore.node$(canvasName, "a").set(nativeNote("a", 100, 2)));
    expect(commits).toBe(0);
    act(() => modelStore.node$(canvasName, "region").set({ ...region, label: "New team" }));
    expect(host.textContent).toContain("New team");
    commits = 0;
    act(() => modelStore.node$(canvasName, "a").set(nativeNote("a", 2000, 2)));
    expect(commits).toBeGreaterThan(0);
    expect(reactErrors()).toEqual([]);
  });

  it("keeps a selected relation quiet on moves and follows endpoint names and verb changes", () => {
    let commits = 0;
    const agent = Schema.decodeUnknownSync(Node)({ kind: "agent", id: "seat", x: 0, y: 0, width: 100, height: 100, z: 0, label: "Planner", agentKey: "local:planner", bindingId: "planner-binding", host: "local", harness: "codex", overseer: false, onRemove: "detach" });
    const task = Schema.decodeUnknownSync(Node)({ kind: "task", id: "tasks", x: 400, y: 0, width: 100, height: 100, z: 0, name: "Backlog" });
    const wire = Schema.decodeUnknownSync(Wire)({ id: "link", from: agent.id, to: task.id, verb: "contributes" });
    act(() => {
      seed(); modelStore.node$(canvasName, agent.id).set(agent); modelStore.node$(canvasName, task.id).set(task);
      modelStore.canvas$(canvasName).nodeIds.set([agent.id, task.id]);
      modelStore.wire$(canvasName, wire.id).set(wire); modelStore.canvas$(canvasName).wireIds.set([wire.id]);
      state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]); state$.selectedEdgeId.set(wire.id);
      root.render(<Profiler id="bar" onRender={() => { commits += 1; }}><RtsBottomBar minimap={null} /></Profiler>);
    });
    expect(host.textContent).toContain("Planner contributes to Backlog");
    commits = 0;
    act(() => batch(() => {
      modelStore.node$(canvasName, agent.id).set({ ...agent, x: 50, z: 2 });
      modelStore.node$(canvasName, task.id).set({ ...task, x: 700, z: 3 });
      modelStore.canvas$(canvasName).nodeIds.set([task.id, agent.id]);
    }));
    expect(commits).toBe(0);
    act(() => modelStore.node$(canvasName, task.id).set({ ...task, name: "Shipping" }));
    expect(host.textContent).toContain("Planner contributes to Shipping");
    act(() => modelStore.wire$(canvasName, wire.id).set({ ...wire, verb: "manages" }));
    expect(host.textContent).toContain("Planner manages Shipping");
    act(() => modelStore.wire$(canvasName, wire.id).delete());
    expect(host.textContent).not.toContain("Planner manages Shipping");
    expect(reactErrors()).toEqual([]);
  });

  it("does not commit for unselected region labels or member names", () => {
    let commits = 0;
    const region = Schema.decodeUnknownSync(Node)({ kind: "region", id: "region", x: 0, y: 0, width: 1000, height: 1000, z: 0, label: "Other region", hold: false });
    act(() => {
      seed("a", "outside"); modelStore.node$(canvasName, "region").set(region);
      modelStore.node$(canvasName, "outside").set(nativeNote("outside", 2000));
      modelStore.canvas$(canvasName).nodeIds.set(["region", "a", "outside"]);
      state$.selectedNodeId.set("outside"); state$.selectedNodeIds.set(["outside"]);
      root.render(<Profiler id="bar" onRender={() => { commits += 1; }}><RtsBottomBar minimap={null} /></Profiler>);
    });
    commits = 0;
    act(() => modelStore.node$(canvasName, "region").set({ ...region, label: "Renamed elsewhere" }));
    act(() => modelStore.node$(canvasName, "a").set(nativeNote("a", 0, 0, "Renamed elsewhere")));
    expect(commits).toBe(0);
  });

  it("updates minimap region counts without committing commands when selected cards cross regions", () => {
    let commits = 0;
    const region = Schema.decodeUnknownSync(Node)({ kind: "region", id: "region", x: 0, y: 0, width: 1000, height: 1000, z: 0, label: "Team", hold: false });
    act(() => {
      seed("a", "b"); modelStore.node$(canvasName, "region").set(region);
      modelStore.canvas$(canvasName).nodeIds.set(["region", "a", "b"]);
      state$.selectedNodeId.set(""); state$.selectedNodeIds.set(["a", "b"]);
      root.render(<Profiler id="bar" onRender={() => { commits += 1; }}><RtsBottomBar minimap={null} /></Profiler>);
    });
    expect(state$.regionCountsByNodeId.region.peek()?.total).toBe(2);
    commits = 0;
    act(() => batch(() => {
      modelStore.node$(canvasName, "a").set(nativeNote("a", 2000));
      modelStore.node$(canvasName, "b").set(nativeNote("b", 2200));
    }));
    expect(state$.regionCountsByNodeId.region.peek()?.total).toBe(0);
    expect(host.textContent).toContain("shared settings");
    expect(commits).toBe(0);
    act(() => batch(() => {
      modelStore.node$(canvasName, "a").set(nativeNote("a", 50));
      modelStore.node$(canvasName, "b").set(nativeNote("b", 300));
    }));
    expect(state$.regionCountsByNodeId.region.peek()?.total).toBe(2);
    expect(commits).toBe(0);
  });

  it("keeps the selected agent glance quiet while its seat moves", () => {
    let commits = 0;
    const agent = Schema.decodeUnknownSync(Node)({ kind: "agent", id: "seat", x: 0, y: 0, width: 100, height: 100, z: 0, label: "Planner", agentKey: "local:planner", bindingId: "planner-binding", host: "local", harness: "codex", overseer: false, onRemove: "detach" });
    act(() => {
      seed(); modelStore.node$(canvasName, agent.id).set(agent);
      modelStore.canvas$(canvasName).nodeIds.set([agent.id]);
      state$.selectedNodeId.set(agent.id); state$.selectedNodeIds.set([agent.id]);
      root.render(<Profiler id="bar" onRender={() => { commits += 1; }}><RtsBottomBar minimap={null} /></Profiler>);
    });
    expect(host.textContent).toContain("Planner");
    commits = 0;
    act(() => batch(() => {
      modelStore.node$(canvasName, agent.id).set({ ...agent, x: 50, z: 2 });
      state$.selectedNodeIds.set([agent.id]);
    }));
    expect(commits).toBe(0);
    act(() => modelStore.node$(canvasName, agent.id).set({ ...agent, color: "1" }));
    expect(commits).toBeGreaterThan(0);
    expect(host.querySelectorAll('.rts-swatch[aria-pressed="true"]').length).toBe(1);
    expect(reactErrors()).toEqual([]);
  });

});
