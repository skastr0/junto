/**
 * The whole first half of track F in one chain: the pure pointer machine, the
 * pick over the spatial index, and the shell's wiring, with the model store
 * as the witness. This is the done-test's shape before the real canvas runs:
 * a drag of three selected cards ends as exactly one Move naming three, and a
 * resize ends as one Move carrying the size. Undo and redo see one act each.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName, asNodeId, type Command, type Node, type Wire } from "../src/shared/model";
import { authoring } from "../src/window/lib/authoring";
import { modelStore } from "../src/window/lib/use-model";
import { redo, undo } from "../src/window/lib/mutations";
import { state$ } from "../src/window/lib/state";
import { pickAt, type PickWorld } from "../src/window/canvas/engine/pick";
import {
  POINTER_IDLE,
  stepPointer,
  type PointerState,
  type PointerWorld,
} from "../src/window/canvas/engine/pointer";
import { handleIntent } from "../src/window/canvas/shell/hands";
import type { CardFact, Intent, Modifiers, Point, SelectionFact, SpatialIndex } from "../src/window/canvas/contract";
import { note } from "./support/model-nodes";

const canvas = asCanvasName("drag");
const NO_MOD: Modifiers = { shift: false, alt: false, ctrl: false, meta: false };
let sent: Command[] = [];
let release: (() => void) | undefined;
let previousWindow: unknown;

const open = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): void => {
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
  state$.canvasName.set("drag");
  authoring.forget("drag");
  release = modelStore.adopt({ canvas, seq: 0, nodes, wires });
};

const settle = async (): Promise<void> => {
  await authoring.idle();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const card = (id: string): Node => {
  const node = modelStore.node$("drag", id).peek();
  if (node === undefined) throw new Error(`no card ${id}`);
  return node;
};

const drawnRect = (node: Node) => ({ x: node.x, y: node.y, width: node.width, height: node.height });

const selection = (): SelectionFact => {
  const multi = state$.selectedNodeIds.peek();
  const single = state$.selectedNodeId.peek();
  return { nodeIds: multi.length > 0 ? multi : single === "" ? [] : [single] };
};

const factOf = (node: Node): CardFact => ({ id: node.id, row: node, derived: { regionDepth: 0, blocked: false, z: node.z } });

/** A zero-offset camera at 1:1, so a screen point is its board point. */
const world = (): PointerWorld => {
  const nodes = (): ReadonlyArray<Node> => [...modelStore.canvasOf("drag").nodes.values()];
  const byId = (id: string): Node | undefined => modelStore.node$("drag", id).peek();
  const index: SpatialIndex = {
    cardsAt: (at) => nodes()
      .filter((node) => at.x >= node.x && at.x <= node.x + node.width && at.y >= node.y && at.y <= node.y + node.height)
      .map((node) => node.id),
    cardsNear: (at, slop) => nodes()
      .filter((node) => at.x >= node.x - slop && at.x <= node.x + node.width + slop && at.y >= node.y - slop && at.y <= node.y + node.height + slop)
      .map((node) => node.id),
    wiresAt: () => [],
  };
  const pick = (screen: Point) => {
    const pickWorld: PickWorld = {
      index,
      card: (id) => {
        const node = byId(id);
        return node === undefined ? undefined : factOf(node);
      },
      wire: () => undefined,
      selection: selection(),
      scale: 1,
      tier: "near",
      wireMode: "rest",
      rectOf: (id) => {
        const node = byId(id);
        return node === undefined ? undefined : drawnRect(node);
      },
    };
    return pickAt(pickWorld, screen);
  };
  return {
    pick,
    screenToBoard: (screen) => screen,
    viewport: () => ({ width: 1400, height: 900 }),
    rectOf: (id) => {
      const node = byId(id);
      return node === undefined ? undefined : drawnRect(node);
    },
    kindOf: (id) => byId(id)?.kind,
    query: (rect) => nodes()
      .filter((node) => rect.x < node.x + node.width && rect.x + rect.width > node.x && rect.y < node.y + node.height && rect.y + rect.height > node.y)
      .map((node) => node.id),
    selection: () => selection().nodeIds,
    canConnect: () => false,
    verbsFor: () => [],
    riders: () => [],
  };
};

type Step = { readonly phase: "down" | "move" | "up"; readonly at: Point; readonly button?: number };

/** Run a gesture through the machine, handing each intent to the shell as it is emitted. */
const gesture = (steps: ReadonlyArray<Step>): ReadonlyArray<Intent> => {
  const pointer = world();
  let state: PointerState = POINTER_IDLE;
  const seen: Intent[] = [];
  let pointerId = 1;
  for (const step of steps) {
    const result = stepPointer(
      state,
      {
        kind: "pointer",
        phase: step.phase,
        pointerId,
        at: step.at,
        button: step.button ?? 0,
        buttons: step.phase === "up" ? 0 : 1,
        modifiers: NO_MOD,
        clicks: 1,
      },
      pointer,
    );
    state = result.state;
    for (const intent of result.intents) {
      seen.push(intent);
      handleIntent(intent);
    }
  }
  pointerId += 1;
  return seen;
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
  authoring.forget("drag");
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
  else (globalThis as unknown as { window: unknown }).window = previousWindow;
});

describe("the machine, the pick and the writers, end to end", () => {
  it("drags three selected cards and writes one Move naming three", async () => {
    open([
      note("a", "a", { x: 0, y: 0, width: 200, height: 100 }),
      note("b", "b", { x: 300, y: 0, width: 200, height: 100 }),
      note("c", "c", { x: 600, y: 0, width: 200, height: 100 }),
    ]);
    state$.selectedNodeIds.set(["a", "b", "c"]);
    const intents = gesture([
      { phase: "down", at: { x: 100, y: 50 } },
      { phase: "move", at: { x: 130, y: 90 } },
      { phase: "up", at: { x: 130, y: 90 } },
    ]);
    await settle();
    const moves = intents.filter((intent) => intent.kind === "move");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      positions: [
        { id: "a", x: 30, y: 40 },
        { id: "b", x: 330, y: 40 },
        { id: "c", x: 630, y: 40 },
      ],
    });
    const commands = sent.filter((command) => command._tag === "Move");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      moves: [
        { id: asNodeId("a"), x: 30, y: 40 },
        { id: asNodeId("b"), x: 330, y: 40 },
        { id: asNodeId("c"), x: 630, y: 40 },
      ],
    });
    expect(card("a")).toMatchObject({ x: 30, y: 40 });
    expect(card("b")).toMatchObject({ x: 330, y: 40 });
    expect(card("c")).toMatchObject({ x: 630, y: 40 });
  });

  it("drags an unselected card: selects it, moves it, one Move", async () => {
    open([note("a", "a", { x: 0, y: 0 }), note("b", "b", { x: 400, y: 0 })]);
    const intents = gesture([
      { phase: "down", at: { x: 100, y: 50 } },
      { phase: "move", at: { x: 150, y: 70 } },
      { phase: "up", at: { x: 150, y: 70 } },
    ]);
    await settle();
    expect(intents[0]).toMatchObject({ kind: "select", nodeIds: ["a"] });
    expect(state$.selectedNodeId.peek()).toBe("a");
    expect(sent.filter((command) => command._tag === "Move")).toHaveLength(1);
    expect(card("a")).toMatchObject({ x: 50, y: 20 });
    expect(card("b")).toMatchObject({ x: 400, y: 0 });
  });

  it("resizes a selected card and writes one Move with size", async () => {
    open([note("a", "a", { x: 0, y: 0, width: 200, height: 100 })]);
    state$.selectedNodeIds.set(["a"]);
    const intents = gesture([
      { phase: "down", at: { x: 200, y: 100 } },
      { phase: "move", at: { x: 260, y: 140 } },
      { phase: "up", at: { x: 260, y: 140 } },
    ]);
    await settle();
    expect(intents.some((intent) => intent.kind === "resize")).toBe(true);
    const commands = sent.filter((command) => command._tag === "Move");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      moves: [{ id: asNodeId("a"), x: 0, y: 0, size: { width: 260, height: 140 } }],
    });
    expect(card("a")).toMatchObject({ width: 260, height: 140 });
  });

  it("undo and redo take the drag back and put it on again", async () => {
    open([note("a", "a", { x: 0, y: 0 }), note("b", "b", { x: 300, y: 0 })]);
    state$.selectedNodeIds.set(["a", "b"]);
    gesture([
      { phase: "down", at: { x: 100, y: 50 } },
      { phase: "move", at: { x: 140, y: 80 } },
      { phase: "up", at: { x: 140, y: 80 } },
    ]);
    await settle();
    expect(card("a")).toMatchObject({ x: 40, y: 30 });
    undo();
    await settle();
    expect(card("a")).toMatchObject({ x: 0, y: 0 });
    expect(card("b")).toMatchObject({ x: 300, y: 0 });
    redo();
    await settle();
    expect(card("a")).toMatchObject({ x: 40, y: 30 });
    expect(card("b")).toMatchObject({ x: 340, y: 30 });
  });

  it("a click on the pane clears the selection and its connection focus", () => {
    open([note("a")]);
    state$.selectedNodeId.set("a");
    state$.selectedNodeIds.set(["a"]);
    state$.connectionFocusNodeId.set("a");
    gesture([
      { phase: "down", at: { x: 900, y: 800 } },
      { phase: "up", at: { x: 900, y: 800 } },
    ]);
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedNodeIds.peek()).toEqual([]);
    expect(state$.connectionFocusNodeId.peek()).toBe("");
  });
});
