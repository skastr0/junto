/**
 * The wiring half of track F (docs/canvas-gpu-plan.md): the intents the engine
 * emits become today's writer calls. A drag is one `Move` naming every card
 * that landed somewhere new, a resize is one `Move` with `size`, a connect is
 * `addEdge` with the verb it landed with, a delete is the existing confirm and
 * one `Remove`, and the selection lives in `state$`. Undo and redo are the
 * same acts they were before.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName, asNodeId, type Command, type Node } from "../src/shared/model";
import { authoring } from "../src/window/lib/authoring";
import { modelStore } from "../src/window/lib/use-model";
import { redo, undo } from "../src/window/lib/mutations";
import { state$ } from "../src/window/lib/state";
import {
  cursorFor,
  handleIntent,
  installHands,
  selectionFact,
  type HandsEngine,
  type HandsMemory,
} from "../src/window/canvas/shell/hands";
import type { Intent, SelectionFact } from "../src/window/canvas/contract";
import { canvasMenu$, closeCanvasMenu } from "../src/window/canvas/shell/canvas-menu";
import { openCanvasMenu } from "../src/window/canvas/shell/canvas-menu";
import { note, seat, taskBoard } from "./support/model-nodes";

const canvas = asCanvasName("hands");
let sent: Command[] = [];
let release: (() => void) | undefined;
let previousWindow: unknown;

const nodeAt = (id: string): Node | undefined => modelStore.node$("hands", id).peek();

const open = (nodes: ReadonlyArray<Node>): void => {
  previousWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    confirm: () => true,
    junto: {
      modelCommand: async (command: Command) => {
        sent.push(command);
        return { seq: sent.length };
      },
    },
  };
  state$.canvasName.set("hands");
  authoring.forget("hands");
  release = modelStore.adopt({ canvas, seq: 0, nodes, wires: [] });
};

const settle = async (): Promise<void> => {
  await authoring.idle();
  // A delete is an authoring operation over page and terminal leases; give
  // its promises their turns before reading the command.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  sent = [];
  state$.canvasName.set("");
  state$.selectedNodeId.set("");
  state$.selectedNodeIds.set([]);
  state$.selectedEdgeId.set("");
  state$.error.set("");
});

afterEach(async () => {
  await settle();
  release?.();
  release = undefined;
  authoring.forget("hands");
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
  else (globalThis as unknown as { window: unknown }).window = previousWindow;
});

describe("a drag writes one Move", () => {
  it("names exactly the three cards that landed somewhere new, once", async () => {
    open([
      note("a", "a", { x: 0, y: 0 }),
      note("b", "b", { x: 300, y: 0 }),
      note("c", "c", { x: 600, y: 0 }),
    ]);
    handleIntent({
      kind: "move",
      positions: [
        { id: "a", x: 10, y: 20 },
        { id: "b", x: 310, y: 20 },
        { id: "c", x: 610, y: 20 },
      ],
    });
    await settle();
    expect(sent).toEqual([
      { _tag: "Move", canvas: "hands", moves: [
        { id: asNodeId("a"), x: 10, y: 20 },
        { id: asNodeId("b"), x: 310, y: 20 },
        { id: asNodeId("c"), x: 610, y: 20 },
      ] },
    ]);
    expect(nodeAt("a")).toMatchObject({ x: 10, y: 20 });
    expect(nodeAt("b")).toMatchObject({ x: 310, y: 20 });
    expect(nodeAt("c")).toMatchObject({ x: 610, y: 20 });
  });

  it("rounds to whole board units, as the drop always did", async () => {
    open([note("a", "a", { x: 0, y: 0 })]);
    handleIntent({ kind: "move", positions: [{ id: "a", x: 10.6, y: -3.4 }] });
    await settle();
    expect(sent[0]).toMatchObject({ moves: [{ id: asNodeId("a"), x: 11, y: -3 }] });
  });

  it("sends nothing when every card landed where it was", async () => {
    open([note("a", "a", { x: 0, y: 0 })]);
    handleIntent({ kind: "move", positions: [{ id: "a", x: 0, y: 0 }] });
    await settle();
    expect(sent).toEqual([]);
  });

  it("is one step back and one forward", async () => {
    open([note("a", "a", { x: 0, y: 0 }), note("b", "b", { x: 300, y: 0 })]);
    handleIntent({ kind: "move", positions: [{ id: "a", x: 50, y: 60 }, { id: "b", x: 350, y: 60 }] });
    await settle();
    undo();
    await settle();
    expect(nodeAt("a")).toMatchObject({ x: 0, y: 0 });
    expect(nodeAt("b")).toMatchObject({ x: 300, y: 0 });
    redo();
    await settle();
    expect(nodeAt("a")).toMatchObject({ x: 50, y: 60 });
  });
});

describe("a resize writes one Move with size", () => {
  it("carries the released rectangle, rounded", async () => {
    open([note("a", "a", { x: 40, y: 40, width: 200, height: 100 })]);
    handleIntent({ kind: "resize", id: "a", rect: { x: 40, y: 40, width: 260.4, height: 144.6 } });
    await settle();
    expect(sent).toEqual([
      { _tag: "Move", canvas: "hands", moves: [
        { id: asNodeId("a"), x: 40, y: 40, size: { width: 260, height: 145 } },
      ] },
    ]);
    expect(nodeAt("a")).toMatchObject({ width: 260, height: 145 });
  });

  it("sends nothing for a resize that changes nothing", async () => {
    open([note("a", "a", { x: 40, y: 40, width: 200, height: 100 })]);
    handleIntent({ kind: "resize", id: "a", rect: { x: 40, y: 40, width: 200, height: 100 } });
    await settle();
    expect(sent).toEqual([]);
  });
});

describe("selection lives in state$", () => {
  it("replaces, toggles and adds", () => {
    open([note("a"), note("b"), note("c")]);
    handleIntent({ kind: "select", nodeIds: ["a"], mode: "replace" });
    expect(state$.selectedNodeId.peek()).toBe("a");
    handleIntent({ kind: "select", nodeIds: ["b"], mode: "add" });
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedNodeIds.peek()).toEqual(["a", "b"]);
    handleIntent({ kind: "select", nodeIds: ["a"], mode: "toggle" });
    expect(state$.selectedNodeIds.peek()).toEqual(["b"]);
    handleIntent({ kind: "select", nodeIds: ["b"], mode: "toggle" });
    expect(state$.selectedNodeIds.peek()).toEqual([]);
    expect(state$.selectedNodeId.peek()).toBe("");
  });

  it("is told to the engine as one fact, and stays in step", () => {
    open([note("a")]);
    const facts: SelectionFact[] = [];
    let listener: ((intent: Intent) => void) | undefined;
    const engine: HandsEngine = {
      apply: (ops) => {
        for (const op of ops) facts.push(op.fact);
      },
      input: () => undefined,
      onIntent: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const stop = installHands(engine);
    expect(facts.at(-1)).toEqual({ nodeIds: [] });
    listener?.({ kind: "select", nodeIds: ["a"], mode: "replace" });
    expect(facts.at(-1)).toEqual({ nodeIds: ["a"] });
    state$.selectedEdgeId.set("w");
    expect(facts.at(-1)).toMatchObject({ wireId: "w" });
    stop();
    const heard = facts.length;
    state$.selectedNodeId.set("");
    expect(facts).toHaveLength(heard);
  });

  it("reads the single selection and the multi set as one fact", () => {
    state$.selectedNodeId.set("a");
    expect(selectionFact()).toEqual({ nodeIds: ["a"] });
    state$.selectedNodeIds.set(["a", "b"]);
    state$.selectedNodeId.set("a");
    expect(selectionFact()).toEqual({ nodeIds: ["a", "b"] });
    state$.connectionFocusNodeId.set("a");
    expect(selectionFact()).toMatchObject({ connectionFocusNodeId: "a" });
  });
});

describe("a click on a selected note enters text edit", () => {
  it("opens the editor only on a click, never on the click that selected it", () => {
    open([note("a", "a")]);
    state$.editNodeId.set("");
    handleIntent({ kind: "select", nodeIds: ["a"], mode: "replace" });
    expect(state$.editNodeId.peek()).toBe("");
    handleIntent({ kind: "select", nodeIds: ["a"], mode: "replace" });
    expect(state$.editNodeId.peek()).toBe("a");
  });

  it("opens a note or label on a double click", () => {
    open([note("a", "a")]);
    state$.editNodeId.set("");
    handleIntent({ kind: "open", nodeId: "a", part: { kind: "body" } });
    expect(state$.editNodeId.peek()).toBe("a");
  });

  it("lets go of the focus cone when the selection moves to another card", () => {
    open([note("a"), note("b")]);
    state$.selectedNodeIds.set(["a"]);
    state$.selectedNodeId.set("a");
    state$.connectionFocusNodeId.set("a");
    handleIntent({ kind: "select", nodeIds: ["b"], mode: "replace" });
    expect(state$.connectionFocusNodeId.peek()).toBe("");
  });

  it("leaves a card of another kind alone", () => {
    open([taskBoard("t")]);
    state$.editNodeId.set("");
    handleIntent({ kind: "select", nodeIds: ["t"], mode: "replace" });
    handleIntent({ kind: "select", nodeIds: ["t"], mode: "replace" });
    expect(state$.editNodeId.peek()).toBe("");
  });

  it("does not edit while a marquee or a drag is running", () => {
    open([note("a", "a")]);
    const memory: HandsMemory = { gesturing: false };
    handleIntent({ kind: "select", nodeIds: ["a"], mode: "replace" }, {}, memory);
    state$.editNodeId.set("");
    handleIntent({ kind: "gesture", gesture: "marquee", nodeIds: [] }, {}, memory);
    handleIntent({ kind: "select", nodeIds: ["a"], mode: "replace" }, {}, memory);
    expect(state$.editNodeId.peek()).toBe("");
    handleIntent({ kind: "gesture", gesture: null, nodeIds: [] }, {}, memory);
  });
});

describe("a connect writes the wire the verb makes", () => {
  it("adds one wire and selects it", async () => {
    open([seat("a"), seat("b", { x: 400 })]);
    handleIntent({ kind: "connect", source: "a", target: "b", sourceHandle: "s-right" });
    await settle();
    expect(sent).toHaveLength(1);
    const command = sent[0];
    expect(command?._tag).toBe("Add");
    if (command?._tag !== "Add") return;
    expect(command.wires).toHaveLength(1);
    expect(command.wires[0]).toMatchObject({
      from: asNodeId("a"),
      to: asNodeId("b"),
      verb: "messages",
      fromSide: "right",
    });
    expect(state$.selectedEdgeId.peek()).toBe(command.wires[0]?.id);
  });

  it("lands with the verb the drop named", async () => {
    open([taskBoard("a"), taskBoard("b", { x: 400 })]);
    handleIntent({ kind: "connect", source: "a", target: "b", sourceHandle: "s-right", verb: "derives" });
    await settle();
    const command = sent[0];
    if (command?._tag !== "Add") throw new Error("no wire was added");
    expect(command.wires[0]?.verb).toBe("derives");
  });

  it("refuses a pair with no verb and writes nothing", async () => {
    open([note("a"), seat("b", { x: 400 })]);
    handleIntent({ kind: "connect", source: "a", target: "b" });
    await settle();
    expect(sent).toEqual([]);
    expect(state$.error.peek()).not.toBe("");
  });
});

describe("a delete asks first, then writes one Remove", () => {
  it("removes the selected card and its wires in one command", async () => {
    open([note("a", "a", { x: 0, y: 0 }), note("b", "b", { x: 300, y: 0 })]);
    handleIntent({ kind: "delete", nodeIds: ["a"], wireIds: [] });
    await settle();
    const removes = sent.filter((command) => command._tag === "Remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]).toMatchObject({ nodes: [asNodeId("a")], wires: [] });
    expect(nodeAt("a")).toBeUndefined();
    expect(nodeAt("b")).toBeDefined();
  });

  it("leaves everything when the operator says no", async () => {
    open([note("a")]);
    (globalThis as unknown as { window: { confirm: () => boolean } }).window.confirm = () => false;
    handleIntent({ kind: "delete", nodeIds: ["a"], wireIds: [] });
    await settle();
    expect(sent.filter((command) => command._tag === "Remove")).toEqual([]);
    expect(nodeAt("a")).toBeDefined();
  });
});

describe("a double click opens what the card opens", () => {
  it("opens a task board's work surface", () => {
    open([taskBoard("t")]);
    handleIntent({ kind: "open", nodeId: "t", part: { kind: "body" } });
    // The writer is synchronous about the model it opens; the surface itself
    // is another component's. What matters here is that the open reached it.
    expect(state$.error.peek()).toBe("");
  });
});

describe("a menu intent opens the shell's menu", () => {
  it("carries the connect menu and the marquee menu through installHands", () => {
    open([note("a"), note("b")]);
    let listener: ((intent: Intent) => void) | undefined;
    const engine: HandsEngine = {
      apply: () => undefined,
      input: () => undefined,
      onIntent: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const stop = installHands(engine, { menu: openCanvasMenu });
    listener?.({ kind: "connectMenu", targetId: "b", sourceIds: ["a"], at: { x: 10, y: 20 }, screen: { x: 100, y: 120 } });
    expect(canvasMenu$.peek()).toMatchObject({ kind: "target", targetId: "b", sourceIds: ["a"] });
    closeCanvasMenu();
    listener?.({ kind: "marqueeMenu", nodeIds: ["a", "b"], bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(canvasMenu$.peek()).toMatchObject({ kind: "selection", nodeIds: ["a", "b"] });
    closeCanvasMenu();
    stop();
  });
});

describe("the cursor says what a part does", () => {
  it("maps every gesture part", () => {
    expect(cursorFor(null)).toBe("default");
    expect(cursorFor({ part: { kind: "pane" }, at: { x: 0, y: 0 } })).toBe("default");
    expect(cursorFor({ nodeId: "a", part: { kind: "handle", side: "top", role: "source", id: "s-top" }, at: { x: 0, y: 0 } })).toBe("crosshair");
    expect(cursorFor({ nodeId: "a", part: { kind: "resize", corner: "se" }, at: { x: 0, y: 0 } })).toBe("nwse-resize");
    expect(cursorFor({ nodeId: "r", part: { kind: "regionTitle" }, at: { x: 0, y: 0 } })).toBe("grab");
    expect(cursorFor({ wireId: "w", part: { kind: "wire" }, at: { x: 0, y: 0 } })).toBe("pointer");
  });
});
