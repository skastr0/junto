/**
 * How the window changes a canvas: a writer says what the document should
 * become, the difference goes to main as commands, and no document is saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { Command } from "../src/shared/model";
import { authoring } from "../src/renderer/lib/authoring";
import { flushCanvasEdits, registerCanvasDraftCommit } from "../src/renderer/lib/canvas-editor-flush";
import {
  applyManagedAgentReseat,
  clearAbandonedCanvas,
  commitCommands,
  commitDoc,
  flushPendingCanvasSave,
  hasPendingCanvasChanges,
  loadDoc,
  followStoreDocument,
  prepareCanvasRemoval,
  redo,
  undo,
} from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { holdCanvas } from "./support/hold-canvas";

const modelCommand = vi.fn(async (_command: Command) => ({ seq: 1 }));
// Main, asked for a canvas again, answers with what the store holds: these
// cases look at whether it was asked, not at what came back.
const modelOpen = vi.fn(async (input: { readonly canvas: string }) => {
  const held = modelStore.canvasOf(input.canvas);
  return { canvas: held.name, seq: held.seq, nodes: [...held.nodes.values()], wires: [...held.wires.values()] };
});
const runtimeWindow = {
  junto: { modelCommand, modelOpen, onModelChanged: () => () => undefined },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: () => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const note = (id: string, text: string, x = 0): CanvasNode =>
  ({ id, type: "text", text, x, y: 0, width: 120, height: 60 }) as CanvasNode;
const seat = (id: string, overseer: boolean): CanvasNode =>
  ({
    id, type: "text", text: id, x: 0, y: 0, width: 216, height: 56,
    ether: {
      entity: { kind: "agent", name: "local:claude" }, host: "local",
      terminal: { bindingId: `binding-${id}`, harness: "claude" },
      ...(overseer ? { overseer: true } : {}),
    },
  }) as CanvasNode;
const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** The text the document shows for the note. */
const shownText = (): string | undefined => {
  const shown = state$.doc.peek().nodes.find((node) => node.id === "note");
  return shown?.type === "text" ? shown.text : undefined;
};

const sent = (): Command[] => modelCommand.mock.calls.map(([command]) => command);

describe("the window changes a canvas by sending commands", () => {
  // Reading the canvas again from main, which is what a refusal leads to.
  const refused = modelOpen;
  let stopFollowing: (() => void) | undefined;

  beforeEach(async () => {
    modelCommand.mockReset();
    modelCommand.mockImplementation(async () => ({ seq: 1 }));
    refused.mockReset();
    stopFollowing = followStoreDocument();
    for (const name of ["alpha", "beta"]) {
      clearAbandonedCanvas(name);
      authoring.forget(name);
    }
    state$.canvasName.set("alpha");
    state$.error.set("");
    state$.saveState.set("saved");
    open(doc(note("note", "base")), "alpha-r1");
  });

  afterEach(async () => {
    await flushPendingCanvasSave().catch(() => undefined);
    stopFollowing?.();
    release?.();
    release = undefined;
  });

  /** Open a document as the app does: the store holds the canvas, the window its document. */
  let release: (() => void) | undefined;
  const open = (opened: CanvasDoc, revision: string, name = "alpha"): void => {
    release?.();
    release = holdCanvas(name, opened.nodes);
    loadDoc(opened, revision, name);
  };

  it("shows the new document at once and sends only what differs", async () => {
    const next = doc(note("note", "edited"));
    commitDoc(next);
    // The document shows it by following the store, in the same turn.
    expect(shownText()).toBe("edited");
    expect(state$.saveState.peek()).toBe("saving");
    await flushPendingCanvasSave();
    expect(sent()).toEqual([
      { _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "edited" } },
    ]);
    expect(state$.saveState.peek()).toBe("saved");
    expect(state$.error.peek()).toBe("");
  });

  it("sends several changes of one commit as one batch", async () => {
    commitDoc(doc(note("note", "edited", 40), note("extra", "new")));
    await flushPendingCanvasSave();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ _tag: "Batch", canvas: "alpha" });
  });

  it("sends nothing when the document says the same, or only its work changed", async () => {
    commitDoc(doc(...state$.doc.peek().nodes));
    const board = (items: unknown[]): CanvasNode =>
      ({ id: "tasks", type: "text", text: "tasks", x: 0, y: 0, width: 240, height: 120, ether: { entity: { kind: "task" }, tasks: { items } } }) as CanvasNode;
    open(doc(board([])), "alpha-r2");
    commitDoc(doc(board([{ id: "t1", state: "submitted", history: [] }])));
    await flushPendingCanvasSave();
    expect(sent()).toEqual([]);
    expect(state$.saveState.peek()).toBe("saved");
  });

  it("is pending until main has taken what was sent, and the flush waits for it", async () => {
    const taken = deferred<{ seq: number }>();
    modelCommand.mockImplementationOnce(async () => taken.promise);
    commitDoc(doc(note("note", "edited")));
    expect(hasPendingCanvasChanges("alpha")).toBe(true);
    let flushed = false;
    const flush = flushPendingCanvasSave().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);
    taken.resolve({ seq: 1 });
    await flush;
    expect(flushed).toBe(true);
    expect(hasPendingCanvasChanges("alpha")).toBe(false);
  });

  it("commits an editor's draft, then waits for it, at the quit boundary", async () => {
    const off = registerCanvasDraftCommit(() => commitDoc(doc(note("note", "draft"))));
    await flushCanvasEdits("navigation");
    off();
    expect(sent()).toEqual([
      { _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "draft" } },
    ]);
  });

  it("sends an edit to the canvas it was made on, wherever the operator goes next", async () => {
    const taken = deferred<{ seq: number }>();
    modelCommand.mockImplementationOnce(async () => taken.promise);
    commitDoc(doc(note("note", "for alpha")));
    state$.canvasName.set("beta");
    loadDoc(doc(note("other", "beta")), "beta-r1", "beta");
    taken.resolve({ seq: 1 });
    await flushPendingCanvasSave();
    expect(sent().map((command) => command.canvas)).toEqual(["alpha"]);
    expect(state$.doc.peek().nodes[0]?.id).toBe("other");
  });

  it("never gives or takes overseer authority, whatever the document says", async () => {
    open(doc(seat("lead", false)), "alpha-r2");
    commitDoc(doc(seat("lead", true)));
    open(doc(seat("lead", true)), "alpha-r3");
    commitDoc(doc(seat("lead", false)));
    await flushPendingCanvasSave();
    expect(sent()).toEqual([]);
  });

  it("says so when main refuses an edit, and asks for the canvas to be read again", async () => {
    modelCommand.mockImplementationOnce(async () => {
      throw new Error("object does not exist");
    });
    commitDoc(doc(note("note", "edited")));
    await flushPendingCanvasSave();
    expect(state$.saveState.peek()).toBe("error");
    expect(state$.error.peek()).toContain("object does not exist");
    expect(refused).toHaveBeenCalledWith({ canvas: "alpha" });
    expect(state$.canUndo.peek()).toBe(false);
  });

  it("steps back and forward by the commands that reverse an act, and the document follows", async () => {
    const base = state$.doc.peek();
    const edited = doc(note("note", "edited"));
    commitDoc(edited);
    await flushPendingCanvasSave();
    expect(state$.canUndo.peek()).toBe(true);

    // A step back is worked out against the canvas as it stands once the acts
    // before it are in, so it shows in its turn, not in the same line.
    undo();
    await flushPendingCanvasSave();
    expect(shownText()).toBe("base");
    expect(sent().at(-1)).toEqual({ _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "base" } });
    expect(state$.canRedo.peek()).toBe(true);

    redo();
    await flushPendingCanvasSave();
    expect(shownText()).toBe("edited");
    expect(sent().at(-1)).toEqual({ _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "edited" } });
    expect(refused).not.toHaveBeenCalled();
  });

  it("keeps undo when main sends the canvas again", async () => {
    commitDoc(doc(note("note", "edited")));
    await flushPendingCanvasSave();
    loadDoc(doc(note("note", "edited")), "alpha-r2", "alpha");
    expect(state$.canUndo.peek()).toBe(true);
    undo();
    await flushPendingCanvasSave();
    expect(sent().at(-1)).toEqual({ _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "base" } });
    expect(shownText()).toBe("base");
    expect(refused).not.toHaveBeenCalled();
  });

  it("re-seats from a view of the seat that carries no placement, and the seat stays a seat where it was", async () => {
    open(doc(seat("s", false), note("note", "base")), "alpha-r1");
    const held = state$.doc.peek().nodes.find((node) => node.id === "s")!;
    // The bottom bar's view of a seat: everything but where it is.
    const view = { ...held, x: 0, y: 0, width: 0, height: 0 } as CanvasNode;
    const reseated = {
      ...view,
      ether: {
        ...view.ether,
        entity: { kind: "agent", name: "local:codex" },
        terminal: { bindingId: "binding-new", harness: "codex" },
      },
    } as CanvasNode;
    applyManagedAgentReseat(reseated as never);
    await flushPendingCanvasSave();
    expect(sent().map((command) => command._tag)).toEqual(["Reseat"]);
    expect(sent()[0]).toMatchObject({ _tag: "Reseat", id: "s", agentKey: "local:codex", bindingId: "binding-new", harness: "codex" });
    const row = modelStore.canvasOf("alpha").nodes.get("s" as never);
    expect(row).toMatchObject({ kind: "agent", harness: "codex", x: held.x, y: held.y, width: held.width, height: held.height });
    expect(state$.error.peek()).toBe("");
  });

  it("sends nothing and says so when a writer asks for a seat the canvas cannot hold", async () => {
    open(doc(seat("s", false), note("note", "base")), "alpha-r1");
    const whole = state$.doc.peek().nodes.find((node) => node.id === "s")!;
    // A writer that loses the seat's session binding: not something the model holds.
    const broken = { ...whole, ether: { ...whole.ether, terminal: { harness: "claude" } } } as CanvasNode;
    commitDoc({ ...state$.doc.peek(), nodes: state$.doc.peek().nodes.map((node) => (node.id === "s" ? broken : node)) });
    await flushPendingCanvasSave();
    // No Remove, no command at all; the seat is still on the canvas.
    expect(sent()).toEqual([]);
    expect(state$.doc.peek().nodes.map((node) => node.id).sort()).toEqual(["note", "s"]);
    expect(modelStore.canvasOf("alpha").nodes.has("s" as never)).toBe(true);
    expect(state$.saveState.peek()).toBe("error");
    expect(state$.error.peek()).toContain("did not take that change");
    expect(state$.error.peek()).toContain('"s"');
    expect(state$.canUndo.peek()).toBe(false);
  });

  it("sends a writer's commands as one act, shows them through the store, and takes them back together", async () => {
    commitCommands((held) => {
      expect(held.nodes.has("note" as never)).toBe(true);
      return [
        { _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "by command" } },
        { _tag: "Move", canvas: "alpha", moves: [{ id: "note", x: 80, y: 0 }] },
      ] as never;
    });
    // Shown in the same turn, through the store and the document that follows it.
    expect(shownText()).toBe("by command");
    expect(state$.doc.peek().nodes.find((node) => node.id === "note")).toMatchObject({ x: 80 });
    await flushPendingCanvasSave();
    expect(sent().map((command) => command._tag)).toEqual(["Batch"]);
    expect(state$.canUndo.peek()).toBe(true);
    undo();
    await flushPendingCanvasSave();
    expect(shownText()).toBe("base");
    expect(state$.doc.peek().nodes.find((node) => node.id === "note")).toMatchObject({ x: 0 });
  });

  it("does not remember an act that is not the operator's to take back", async () => {
    commitDoc(doc(note("note", "scripted")), true, false);
    await flushPendingCanvasSave();
    expect(sent()).toHaveLength(1);
    expect(state$.canUndo.peek()).toBe(false);
  });

  it("sends nothing more for a canvas that is being removed, and waits for what is on its way", async () => {
    const taken = deferred<{ seq: number }>();
    modelCommand.mockImplementationOnce(async () => taken.promise);
    commitDoc(doc(note("note", "one")));
    let removed = false;
    const removal = prepareCanvasRemoval("alpha").then(() => {
      removed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(removed).toBe(false);
    taken.resolve({ seq: 1 });
    await removal;
    expect(removed).toBe(true);

    commitDoc(doc(note("note", "two")));
    await flushPendingCanvasSave();
    expect(sent()).toHaveLength(1);
    expect(state$.canUndo.peek()).toBe(false);

    clearAbandonedCanvas("alpha");
    commitDoc(doc(note("note", "three")));
    await flushPendingCanvasSave();
    expect(sent()).toHaveLength(2);
  });
});
