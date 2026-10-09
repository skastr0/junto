import { observe } from "@legendapp/state";
import { describe, expect, it, vi } from "vitest";
import type { Changed, Command, Node, Opened, Wire } from "../src/shared/model";
import { createModelStore, keepUnchanged, type ModelApi } from "../src/renderer/lib/model-store";

const canvas = "factory" as Opened["canvas"];

const seat = (id: string, over: Record<string, unknown> = {}): Node =>
  ({
    kind: "agent",
    id,
    x: 0,
    y: 0,
    width: 216,
    height: 96,
    z: 0,
    agentKey: `local:${id}`,
    label: id,
    host: "local",
    overseer: false,
    bindingId: `binding-${id}`,
    harness: "claude",
    launch: { kind: "harness", argv: ["claude"] },
    onRemove: "detach",
    ...over,
  }) as unknown as Node;

const wire = (id: string, from: string, to: string): Wire =>
  ({ id, from, to, verb: "messages" }) as unknown as Wire;

const changed = (seq: number, rows: Partial<Omit<Changed, "canvas" | "seq">>): Changed =>
  ({ canvas, seq, nodes: [], wires: [], removedNodes: [], removedWires: [], ...rows }) as Changed;

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const harness = (opened: () => Opened) => {
  let notify: ((event: Changed) => void) | undefined;
  const off = vi.fn(() => {
    notify = undefined;
  });
  const api = {
    modelOpen: vi.fn(async () => opened()),
    modelCommand: vi.fn(async (_command: Command) => ({ seq: 0 })),
    onModelChanged: vi.fn((listener: (event: Changed) => void) => {
      notify = listener;
      return off;
    }),
  } satisfies ModelApi;
  const store = createModelStore(() => api);
  return { api, store, off, emit: (event: Changed) => notify?.(event) };
};

const count = (read: () => unknown): { readonly calls: () => number } => {
  let calls = -1;
  observe(() => {
    read();
    calls += 1;
  });
  return { calls: () => calls };
};

describe("model store", () => {
  it("fills from Opened and lists nodes in paint order", async () => {
    const { store } = harness(() => ({
      canvas,
      seq: 7,
      nodes: [seat("b", { z: 2 }), seat("a", { z: 1 })],
      wires: [wire("w", "a", "b")],
    }));
    store.open(canvas);
    expect(store.canvas$(canvas).status.peek()).toBe("opening");
    await store.ready(canvas);
    const state = store.canvas$(canvas).peek();
    expect(state.status).toBe("open");
    expect(state.seq).toBe(7);
    expect(state.nodeIds).toEqual(["a", "b"]);
    expect(state.wireIds).toEqual(["w"]);
  });

  it("tells a listener about its own field and nothing else", async () => {
    const { store, emit } = harness(() => ({ canvas, seq: 1, nodes: [seat("a"), seat("b")], wires: [] }));
    store.open(canvas);
    await store.ready(canvas);
    const labelOfA = count(() => (store.node$(canvas, "a").get() as { label: string }).label);
    const xOfA = count(() => store.canvas$(canvas).nodes.a.x.get());
    const launchOfA = count(() => (store.canvas$(canvas).nodes.a as never as { launch: { get(): unknown } }).launch.get());
    const nodeB = count(() => store.node$(canvas, "b").get());
    const ids = count(() => store.canvas$(canvas).nodeIds.get());

    emit(changed(2, { nodes: [seat("a", { x: 40 })] }));
    expect(xOfA.calls()).toBe(1);
    expect(launchOfA.calls()).toBe(0);
    expect(nodeB.calls()).toBe(0);
    expect(ids.calls()).toBe(0);
    expect(labelOfA.calls()).toBeLessThanOrEqual(1);
    expect(store.canvas$(canvas).seq.peek()).toBe(2);
  });

  it("applies removals and keeps the lists right", async () => {
    const { store, emit } = harness(() => ({
      canvas,
      seq: 1,
      nodes: [seat("a"), seat("b", { z: 1 })],
      wires: [wire("w", "a", "b")],
    }));
    store.open(canvas);
    await store.ready(canvas);
    emit(changed(2, { removedNodes: ["b" as never], removedWires: ["w" as never], nodes: [seat("c", { z: 5 })] }));
    const state = store.canvas$(canvas).peek();
    expect(state.nodeIds).toEqual(["a", "c"]);
    expect(state.wireIds).toEqual([]);
    expect(state.nodes.b).toBeUndefined();
  });

  it("ignores a change it has already seen and reads afresh on a gap", async () => {
    let seq = 3;
    const { store, emit, api } = harness(() => ({ canvas, seq, nodes: [seat("a", { label: `at ${seq}` })], wires: [] }));
    store.open(canvas);
    await store.ready(canvas);
    emit(changed(3, { nodes: [seat("a", { label: "stale" })] }));
    expect((store.node$(canvas, "a").peek() as { label: string }).label).toBe("at 3");
    expect(api.modelOpen).toHaveBeenCalledTimes(1);

    seq = 9;
    emit(changed(6, { nodes: [seat("a", { label: "skipped ahead" })] }));
    await store.ready(canvas);
    expect(api.modelOpen).toHaveBeenCalledTimes(2);
    expect(store.canvas$(canvas).seq.peek()).toBe(9);
    expect((store.node$(canvas, "a").peek() as { label: string }).label).toBe("at 9");
  });

  it("applies changes that arrive while the canvas is being read, in order", async () => {
    let finish!: (opened: Opened) => void;
    const { store, emit, api } = harness(() => ({ canvas, seq: 0, nodes: [], wires: [] }));
    api.modelOpen.mockImplementationOnce(() => new Promise<Opened>((resolve) => { finish = resolve; }));
    store.open(canvas);
    await flush();
    emit(changed(4, { nodes: [seat("a", { label: "old news" })] }));
    emit(changed(5, { nodes: [seat("a", { label: "five" })] }));
    emit(changed(6, { nodes: [seat("b")] }));
    finish({ canvas, seq: 4, nodes: [seat("a", { label: "four" })], wires: [] });
    await store.ready(canvas);
    await flush();
    const state = store.canvas$(canvas).peek();
    expect(state.seq).toBe(6);
    expect((state.nodes.a as { label: string }).label).toBe("five");
    expect(state.nodeIds).toEqual(["a", "b"]);
    expect(api.modelOpen).toHaveBeenCalledTimes(1);
  });

  it("shows a move at once and stays quiet when main confirms it", async () => {
    const { store, emit, api } = harness(() => ({ canvas, seq: 1, nodes: [seat("a")], wires: [] }));
    store.open(canvas);
    await store.ready(canvas);
    const x = count(() => store.canvas$(canvas).nodes.a.x.get());
    const move: Command = { _tag: "Move", canvas, moves: [{ id: "a" as never, x: 12, y: 3 }] };
    const sent = store.send(move);
    expect(store.canvas$(canvas).nodes.a.x.peek()).toBe(12);
    expect(x.calls()).toBe(1);
    await sent;
    expect(api.modelCommand).toHaveBeenCalledWith(move);
    emit(changed(2, { nodes: [seat("a", { x: 12, y: 3 })] }));
    expect(x.calls()).toBe(1);
    expect(store.canvas$(canvas).seq.peek()).toBe(2);
  });

  it("edits fields, clears the ones set to null, and takes wires with a removed node", async () => {
    const { store } = harness(() => ({
      canvas,
      seq: 1,
      nodes: [seat("a", { harness: "codex" }), seat("b")],
      wires: [wire("w", "a", "b")],
    }));
    store.open(canvas);
    await store.ready(canvas);
    await store.send({ _tag: "Edit", canvas, id: "a" as never, change: { kind: "agent", label: "lead", launch: null } });
    const a = store.node$(canvas, "a").peek() as { label: string; harness: string };
    expect(a.label).toBe("lead");
    expect("launch" in a).toBe(false);
    expect(a.harness).toBe("codex");
    await store.send({ _tag: "Remove", canvas, nodes: ["b" as never], wires: [] });
    expect(store.canvas$(canvas).nodeIds.peek()).toEqual(["a"]);
    expect(store.canvas$(canvas).wireIds.peek()).toEqual([]);
  });

  it("reads the canvas again when main refuses a command", async () => {
    const { store, api } = harness(() => ({ canvas, seq: 1, nodes: [seat("a")], wires: [] }));
    store.open(canvas);
    await store.ready(canvas);
    api.modelCommand.mockRejectedValueOnce(new Error("refused"));
    await expect(
      store.send({ _tag: "Move", canvas, moves: [{ id: "a" as never, x: 99, y: 0 }] }),
    ).rejects.toThrow("refused");
    await store.ready(canvas);
    expect(api.modelOpen).toHaveBeenCalledTimes(2);
    expect(store.canvas$(canvas).nodes.a.x.peek()).toBe(0);
  });

  it("closes the canvas and stops listening when the last holder lets go", async () => {
    const { store, off, emit } = harness(() => ({ canvas, seq: 1, nodes: [seat("a")], wires: [] }));
    const first = store.open(canvas);
    const second = store.open(canvas);
    await store.ready(canvas);
    first();
    first();
    expect(off).not.toHaveBeenCalled();
    expect(store.canvas$(canvas).status.peek()).toBe("open");
    second();
    expect(off).toHaveBeenCalledOnce();
    emit(changed(2, { nodes: [seat("b")] }));
    expect(store.canvas$(canvas).status.peek()).toBe("closed");
    expect(store.canvas$(canvas).nodeIds.peek()).toEqual([]);
  });
});

describe("keepUnchanged", () => {
  it("keeps the old value where nothing changed and replaces only what did", () => {
    const before = { a: { deep: [1, 2] }, b: "x", c: [{ id: 1 }] };
    const same = keepUnchanged(before, { a: { deep: [1, 2] }, b: "x", c: [{ id: 1 }] });
    expect(same).toBe(before);
    const next = keepUnchanged(before, { a: { deep: [1, 2] }, b: "y", c: [{ id: 1 }] });
    expect(next).not.toBe(before);
    expect(next.a).toBe(before.a);
    expect(next.c).toBe(before.c);
    expect(next.b).toBe("y");
    expect(keepUnchanged(before, { a: { deep: [1, 2] }, b: "x" })).not.toBe(before);
  });
});
