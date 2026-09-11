import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  commitDoc,
  clearAbandonedCanvas,
  flushPendingCanvasSave,
  loadDoc,
  prepareCanvasRemoval,
  undo,
} from "../src/renderer/lib/mutations";
import {
  flushCanvasEdits,
  registerCanvasDraftCommit,
} from "../src/renderer/lib/canvas-editor-flush";
import { state$ } from "../src/renderer/lib/state";

const revisions = new Map<string, number>();
const writeCanvas = vi.fn(
  async (name: string, _doc: CanvasDoc, expectedRevision?: string) => {
    const next = (revisions.get(name) ?? 0) + 1;
    revisions.set(name, next);
    return { revision: `${expectedRevision ?? "new"}->${next}` };
  },
);
const createCanvas = vi.fn(async (name: string) => ({
  name,
  doc: { nodes: [], edges: [] } satisfies CanvasDoc,
  actorRefs: [],
  revision: `${name}-created`,
}));
const listCanvases = vi.fn(async () => createCanvas.mock.calls.map(([name]) => ({
  name,
  modifiedAt: "2026-07-18T00:00:00.000Z",
})));
const readCanvas = vi.fn(async (name: string) => ({
  name,
  doc: doc("disk-external"),
  actorRefs: [],
  revision: `${name}-disk`,
}));

const runtimeWindow = {
  vellumCommand: { createCanvas, listCanvases, writeCanvas, readCanvas },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: () => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const doc = (text: string): CanvasDoc => ({
  nodes: [{ id: "note", type: "text", text, x: 0, y: 0, width: 120, height: 60 }],
  edges: [],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
};

describe("renderer canvas save durability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeCanvas.mockClear();
    writeCanvas.mockImplementation(
      async (name: string, _doc: CanvasDoc, expectedRevision?: string) => {
        const next = (revisions.get(name) ?? 0) + 1;
        revisions.set(name, next);
        return { revision: `${expectedRevision ?? "new"}->${next}` };
      },
    );
    createCanvas.mockClear();
    listCanvases.mockClear();
    readCanvas.mockClear();
    readCanvas.mockImplementation(async (name: string) => ({
      name,
      doc: doc("disk-external"),
      actorRefs: [],
      revision: `${name}-disk`,
    }));
    revisions.clear();
    state$.canvasName.set("alpha");
    state$.error.set("");
    state$.saveState.set("saved");
    state$.canvases.set([]);
    clearAbandonedCanvas("alpha");
    clearAbandonedCanvas("beta");
    loadDoc(doc("alpha-base"), "alpha-r1", "alpha");
  });

  afterEach(async () => {
    await prepareCanvasRemoval("alpha");
    await prepareCanvasRemoval("beta");
    clearAbandonedCanvas("alpha");
    clearAbandonedCanvas("beta");
    vi.useRealTimers();
  });

  it("keeps a delayed save bound to the canvas, document, and revision that scheduled it", async () => {
    commitDoc(doc("alpha-edited"));

    // Reproduce the former switch race: renderer state changes before the
    // debounce fires. The pending write must still describe alpha.
    state$.canvasName.set("beta");
    state$.doc.set(doc("beta"));
    loadDoc(doc("beta"), "beta-r1", "beta");

    await vi.advanceTimersByTimeAsync(500);
    await flushPendingCanvasSave();

    expect(writeCanvas).toHaveBeenCalledOnce();
    expect(writeCanvas).toHaveBeenCalledWith("alpha", doc("alpha-edited"), "alpha-r1");
  });

  it("flushes a pending edit immediately for the quit boundary", async () => {
    commitDoc(doc("before-quit"));
    expect(writeCanvas).not.toHaveBeenCalled();

    await flushPendingCanvasSave();

    expect(writeCanvas).toHaveBeenCalledOnce();
    expect(writeCanvas).toHaveBeenCalledWith("alpha", doc("before-quit"), "alpha-r1");
  });

  it("commits an editor-local draft before acknowledging the quit boundary", async () => {
    const unregister = registerCanvasDraftCommit(() => commitDoc(doc("live-modal-draft")));
    try {
      expect(writeCanvas).not.toHaveBeenCalled();

      await flushCanvasEdits();

      expect(writeCanvas).toHaveBeenCalledOnce();
      expect(writeCanvas).toHaveBeenCalledWith("alpha", doc("live-modal-draft"), "alpha-r1");
    } finally {
      unregister();
    }
  });

  it("rebases disjoint local and external edits without moving interaction state", async () => {
    writeCanvas.mockRejectedValueOnce(new Error('canvas "alpha" revision conflict; reload before saving'));
    readCanvas.mockResolvedValueOnce({
      name: "alpha",
      doc: {
        nodes: [
          { ...doc("alpha-base").nodes[0]!, y: 90 },
          { id: "external", type: "text", text: "external", x: 200, y: 0, width: 120, height: 60 },
        ],
        edges: [],
      },
      actorRefs: [],
      revision: "alpha-disk",
    });
    state$.selectedNodeId.set("note");
    state$.selectedNodeIds.set(["note"]);
    state$.focusNodeId.set("note");
    state$.fitViewRequest.set(7);
    commitDoc(doc("local-unsaved"));

    await flushPendingCanvasSave();

    expect(createCanvas).not.toHaveBeenCalled();
    expect(readCanvas).toHaveBeenCalledWith("alpha");
    // First call: conflicted local write; second: rebased write at disk revision.
    expect(writeCanvas).toHaveBeenNthCalledWith(1, "alpha", doc("local-unsaved"), "alpha-r1");
    expect(writeCanvas.mock.calls[1]?.[0]).toBe("alpha");
    expect(writeCanvas.mock.calls[1]?.[2]).toBe("alpha-disk");
    expect(state$.canvasName.peek()).toBe("alpha");
    expect(state$.doc.peek().nodes).toEqual([
      { ...doc("local-unsaved").nodes[0]!, y: 90 },
      { id: "external", type: "text", text: "external", x: 200, y: 0, width: 120, height: 60 },
    ]);
    expect(state$.selectedNodeId.peek()).toBe("note");
    expect(state$.selectedNodeIds.peek()).toEqual(["note"]);
    expect(state$.focusNodeId.peek()).toBe("note");
    expect(state$.fitViewRequest.peek()).toBe(7);
    expect(state$.saveState.peek()).toBe("saved");
    expect(state$.error.peek()).toBe("");
  });

  it("saves a same-field draft as recovery without navigating the active canvas", async () => {
    writeCanvas.mockRejectedValueOnce(new Error('canvas "alpha" revision conflict; reload before saving'));
    state$.selectedNodeId.set("note");
    state$.selectedNodeIds.set(["note"]);
    state$.focusNodeId.set("note");
    state$.fitViewRequest.set(11);
    commitDoc(doc("local-unsaved"));

    await flushPendingCanvasSave();

    expect(createCanvas).toHaveBeenCalledOnce();
    const recoveryName = createCanvas.mock.calls[0]![0];
    expect(writeCanvas).toHaveBeenNthCalledWith(
      2,
      recoveryName,
      doc("local-unsaved"),
      `${recoveryName}-created`,
    );
    expect(state$.canvasName.peek()).toBe("alpha");
    expect(state$.doc.peek()).toEqual(doc("disk-external"));
    expect(state$.selectedNodeId.peek()).toBe("note");
    expect(state$.selectedNodeIds.peek()).toEqual(["note"]);
    expect(state$.focusNodeId.peek()).toBe("note");
    expect(state$.fitViewRequest.peek()).toBe(11);
    expect(state$.error.peek()).toContain("changed concurrently");
    expect(state$.error.peek()).toContain("current authority was reloaded");
    expect(state$.error.peek()).toContain(`saved as canvas "${recoveryName}"`);
  });

  it("updates the recovery copy when another edit arrives during its write", async () => {
    const recoveryWrite = deferred<{ revision: string }>();
    writeCanvas.mockRejectedValueOnce(new Error('canvas "alpha" revision conflict; reload before saving'));
    writeCanvas.mockImplementationOnce(async () => recoveryWrite.promise);
    commitDoc(doc("first-local"));

    const flush = flushPendingCanvasSave();
    await waitFor(() => writeCanvas.mock.calls.length === 2);
    commitDoc(doc("latest-local"));
    recoveryWrite.resolve({ revision: "recovery-r1" });
    await flush;

    expect(writeCanvas).toHaveBeenCalledTimes(3);
    const recoveryName = createCanvas.mock.calls[0]![0];
    expect(writeCanvas).toHaveBeenNthCalledWith(
      3,
      recoveryName,
      doc("latest-local"),
      "recovery-r1",
    );
    expect(state$.canvasName.peek()).toBe("alpha");
    expect(state$.doc.peek()).toEqual(doc("disk-external"));
  });

  it("blocks the original draft after recovery when authority cannot be re-read", async () => {
    writeCanvas.mockRejectedValueOnce(new Error('canvas "alpha" revision conflict; reload before saving'));
    readCanvas.mockRejectedValue(new Error("read failed"));
    commitDoc(doc("local-unsaved"));

    await flushPendingCanvasSave();

    expect(createCanvas).toHaveBeenCalledOnce();
    const recoveryName = createCanvas.mock.calls[0]![0];
    expect(recoveryName).toMatch(/^recovery-[a-z0-9]+-[a-z0-9]+$/);
    expect(state$.canvasName.peek()).toBe("alpha");
    expect(state$.doc.peek()).toEqual(doc("local-unsaved"));
    expect(state$.saveState.peek()).toBe("error");
    expect(state$.error.peek()).toContain(`saved as canvas "${recoveryName}"`);
    expect(state$.error.peek()).toContain("reload the original before editing");

    const writesAfterRecovery = writeCanvas.mock.calls.length;
    commitDoc(doc("must-remain-blocked"));
    await flushPendingCanvasSave();
    expect(writeCanvas).toHaveBeenCalledTimes(writesAfterRecovery);
    expect(state$.error.peek()).toContain("reload canvas \"alpha\"");
  });

  it("keeps the flush boundary pending until the rebased write is durable", async () => {
    let finishRebase!: (result: { revision: string }) => void;
    const rebaseWrite = new Promise<{ revision: string }>((resolve) => {
      finishRebase = resolve;
    });
    writeCanvas.mockRejectedValueOnce(new Error('canvas "alpha" revision conflict; reload before saving'));
    writeCanvas.mockImplementationOnce(async () => rebaseWrite);
    readCanvas.mockResolvedValueOnce({
      name: "alpha",
      doc: {
        nodes: [{ ...doc("alpha-base").nodes[0]!, y: 30 }],
        edges: [],
      },
      actorRefs: [],
      revision: "alpha-disk",
    });
    commitDoc(doc("durability-gate"));

    let flushed = false;
    const flush = flushPendingCanvasSave().then(() => {
      flushed = true;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

    expect(writeCanvas).toHaveBeenCalledTimes(2);
    expect(flushed).toBe(false);

    finishRebase({ revision: "rebased-durable" });
    await flush;
    expect(flushed).toBe(true);
    expect(state$.saveState.peek()).toBe("saved");
    expect(state$.canvasName.peek()).toBe("alpha");
  });

  it("rebases an edit that arrives while conflict resolution is reading authority", async () => {
    const authorityRead = deferred<Awaited<ReturnType<typeof readCanvas>>>();
    writeCanvas.mockRejectedValueOnce(new Error('canvas "alpha" revision conflict; reload before saving'));
    readCanvas.mockImplementationOnce(async () => authorityRead.promise);
    commitDoc({
      nodes: [{ ...doc("alpha-base").nodes[0]!, x: 15 }],
      edges: [],
    });

    const flush = flushPendingCanvasSave();
    await waitFor(() => readCanvas.mock.calls.length === 1);
    commitDoc({
      nodes: [{ ...doc("late-local").nodes[0]!, x: 15 }],
      edges: [],
    });
    authorityRead.resolve({
      name: "alpha",
      doc: {
        nodes: [{ ...doc("alpha-base").nodes[0]!, y: 30 }],
        edges: [],
      },
      actorRefs: [],
      revision: "alpha-disk",
    });

    await flush;

    expect(writeCanvas).toHaveBeenCalledTimes(3);
    expect(writeCanvas.mock.calls[1]?.[1].nodes[0]).toMatchObject({
      text: "alpha-base",
      x: 15,
      y: 30,
    });
    expect(writeCanvas.mock.calls[2]?.[1].nodes[0]).toMatchObject({
      text: "late-local",
      x: 15,
      y: 30,
    });
    expect(state$.doc.peek().nodes[0]).toMatchObject({
      text: "late-local",
      x: 15,
      y: 30,
    });
  });

  it("does not let an ordinary save mint or revoke overseer authority", async () => {
    const seat = (overseer?: boolean): CanvasDoc => ({
      nodes: [{
        id: "seat",
        type: "text",
        text: "Builder",
        x: 0,
        y: 0,
        width: 120,
        height: 60,
        ether: {
          entity: { kind: "agent", name: "local:builder" },
          terminal: { bindingId: "seat-1", harness: "codex" },
          ...(overseer === undefined ? {} : { overseer }),
        },
      }],
      edges: [],
    });
    loadDoc(seat(true), "alpha-r-seat", "alpha");
    commitDoc(seat(false));
    await flushPendingCanvasSave();
    expect(writeCanvas.mock.calls.at(-1)?.[1].nodes[0]?.ether?.overseer).toBe(true);

    loadDoc({ nodes: [], edges: [] }, "alpha-r-empty", "alpha");
    commitDoc(seat(true));
    await flushPendingCanvasSave();
    expect(writeCanvas.mock.calls.at(-1)?.[1].nodes[0]?.ether?.overseer).toBeUndefined();
  });

  it("keeps authored task name and contract in an ordinary protected save", async () => {
    const task = (name: string, instructions: string): CanvasDoc => ({
      nodes: [{
        id: "tasks",
        type: "text",
        text: "Tasks",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        ether: {
          entity: { kind: "task" },
          tasks: { items: [], name, contract: { instructions } },
        },
      }],
      edges: [],
    });
    loadDoc(task("Backlog", "Old instructions"), "alpha-r-task", "alpha");
    commitDoc(task("Intake", "Triage before claim"));

    await flushPendingCanvasSave();

    expect(writeCanvas.mock.calls.at(-1)?.[1].nodes[0]?.ether?.tasks).toMatchObject({
      name: "Intake",
      contract: { instructions: "Triage before claim" },
    });
  });

  it("clears stale undo history when external authority reloads", async () => {
    const granted: CanvasDoc = {
      nodes: [{ ...doc("alpha-base").nodes[0]!, ether: { overseer: true } }],
      edges: [],
    };
    commitDoc({
      nodes: [{ ...doc("alpha-base").nodes[0]!, x: 25 }],
      edges: [],
    });
    await flushPendingCanvasSave();
    expect(state$.canUndo.peek()).toBe(true);

    loadDoc(granted, "alpha-r-granted", "alpha", { preserveValidInteraction: true });
    undo();

    expect(state$.canUndo.peek()).toBe(false);
    expect(state$.doc.peek().nodes[0]?.ether?.overseer).toBe(true);
  });

  it("does not create a recovery canvas for an ordinary write failure", async () => {
    writeCanvas.mockRejectedValueOnce(new Error("disk full"));
    commitDoc(doc("still-local"));

    await expect(flushPendingCanvasSave()).rejects.toThrow("disk full");

    expect(createCanvas).not.toHaveBeenCalled();
    expect(state$.canvasName.peek()).toBe("alpha");
    expect(state$.doc.peek()).toEqual(doc("still-local"));
    expect(state$.saveState.peek()).toBe("error");
  });
});
