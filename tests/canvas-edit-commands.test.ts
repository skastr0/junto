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
  clearAbandonedCanvas,
  commitCommands,
  editText,
  flushPendingCanvasSave,
  hasPendingCanvasChanges,
  followStore,
  prepareCanvasRemoval,
  redo,
  undo,
} from "../src/renderer/lib/mutations";
import { docNow, loadDoc } from "./support/open-document";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";

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
  const shown = docNow().nodes.find((node) => node.id === "note");
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
    stopFollowing = followStore();
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
  });

  /** Open a document as the app does: the store holds the canvas, the window its document. */
  const open = (opened: CanvasDoc, revision: string, name = "alpha"): void => {
    loadDoc(opened, revision, name);
  };

  it("shows the new document at once and sends only what differs", async () => {
    editText("note", "edited");
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

  it("sends nothing when the edit says what the canvas already holds", async () => {
    editText("note", "base");
    await flushPendingCanvasSave();
    expect(sent()).toEqual([]);
    expect(state$.saveState.peek()).toBe("saved");
  });

  it("is pending until main has taken what was sent, and the flush waits for it", async () => {
    const taken = deferred<{ seq: number }>();
    modelCommand.mockImplementationOnce(async () => taken.promise);
    editText("note", "edited");
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
    const off = registerCanvasDraftCommit(() => editText("note", "draft"));
    await flushCanvasEdits("navigation");
    off();
    expect(sent()).toEqual([
      { _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "draft" } },
    ]);
  });

  it("sends an edit to the canvas it was made on, wherever the operator goes next", async () => {
    const taken = deferred<{ seq: number }>();
    modelCommand.mockImplementationOnce(async () => taken.promise);
    editText("note", "for alpha");
    state$.canvasName.set("beta");
    loadDoc(doc(note("other", "beta")), "beta-r1", "beta");
    taken.resolve({ seq: 1 });
    await flushPendingCanvasSave();
    expect(sent().map((command) => command.canvas)).toEqual(["alpha"]);
    expect(docNow().nodes[0]?.id).toBe("other");
  });

  it("says so when main refuses an edit, and asks for the canvas to be read again", async () => {
    modelCommand.mockImplementationOnce(async () => {
      throw new Error("object does not exist");
    });
    editText("note", "edited");
    await flushPendingCanvasSave();
    expect(state$.saveState.peek()).toBe("error");
    expect(state$.error.peek()).toContain("object does not exist");
    expect(refused).toHaveBeenCalledWith({ canvas: "alpha" });
    expect(state$.canUndo.peek()).toBe(false);
  });

  it("steps back and forward by the commands that reverse an act, and the document follows", async () => {
    editText("note", "edited");
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
    editText("note", "edited");
    await flushPendingCanvasSave();
    loadDoc(doc(note("note", "edited")), "alpha-r2", "alpha");
    expect(state$.canUndo.peek()).toBe(true);
    undo();
    await flushPendingCanvasSave();
    expect(sent().at(-1)).toEqual({ _tag: "Edit", canvas: "alpha", id: "note", change: { kind: "note", text: "base" } });
    expect(shownText()).toBe("base");
    expect(refused).not.toHaveBeenCalled();
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
    expect(docNow().nodes.find((node) => node.id === "note")).toMatchObject({ x: 80 });
    await flushPendingCanvasSave();
    expect(sent().map((command) => command._tag)).toEqual(["Batch"]);
    expect(state$.canUndo.peek()).toBe(true);
    undo();
    await flushPendingCanvasSave();
    expect(shownText()).toBe("base");
    expect(docNow().nodes.find((node) => node.id === "note")).toMatchObject({ x: 0 });
  });

  it("does not remember an act that is not the operator's to take back", async () => {
    commitCommands((held) => [{ _tag: "Edit", canvas: held.name, id: "note" as never, change: { kind: "note", text: "scripted" } }], { remember: false });
    await flushPendingCanvasSave();
    expect(sent()).toHaveLength(1);
    expect(state$.canUndo.peek()).toBe(false);
  });

  it("sends nothing more for a canvas that is being removed, and waits for what is on its way", async () => {
    const taken = deferred<{ seq: number }>();
    modelCommand.mockImplementationOnce(async () => taken.promise);
    editText("note", "one");
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

    editText("note", "two");
    await flushPendingCanvasSave();
    expect(sent()).toHaveLength(1);
    expect(state$.canUndo.peek()).toBe(false);

    clearAbandonedCanvas("alpha");
    editText("note", "three");
    await flushPendingCanvasSave();
    expect(sent()).toHaveLength(2);
  });
});
