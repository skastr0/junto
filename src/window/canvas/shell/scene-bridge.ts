/**
 * The GPU canvas's first scene feed (docs/canvas-gpu-architecture.md, section
 * 20). Until the feed's richer derivations land, the shell tells the canvas
 * what the model holds: cards, wires, and the selection. Changes are diffed by
 * row identity, so a change to one card sends one card.
 *
 * Plain Legend-State reads outside React. The feed (canvas/feed) owns seat
 * facts, urgency and the six derivations; this module owns nothing but the
 * model-to-scene path the shell cannot draw without.
 */

import { observe } from "@legendapp/state";
import type { Canvas } from "@shared/model/canvas";
import type { Node as ModelNode } from "@shared/model/kinds";
import type { Wire as ModelWire } from "@shared/model/wire";
import type { CardDerived, CardFact, SceneOp, WireFact } from "../contract";
import { state$ } from "../../lib/state";
import { modelStore } from "../../lib/use-model";

type Sink = {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
};

type DerivedInput = {
  readonly rows: ReadonlyMap<string, ModelNode>;
};

/** The innermost region holding a card and that region's depth (0: none). */
const regionOf = (row: ModelNode, rows: ReadonlyMap<string, ModelNode>): { regionId?: string; regionDepth: number } => {
  if (row.kind === "region") return { regionDepth: 0 };
  let innermost: ModelNode | undefined;
  for (const other of rows.values()) {
    if (other.kind !== "region" || other.id === row.id) continue;
    const inside =
      row.x >= other.x &&
      row.y >= other.y &&
      row.x + row.width <= other.x + other.width &&
      row.y + row.height <= other.y + other.height;
    if (!inside) continue;
    if (innermost === undefined || other.width * other.height < innermost.width * innermost.height) innermost = other;
  }
  if (innermost === undefined) return { regionDepth: 0 };
  let depth = 1;
  let parent: ModelNode | undefined = innermost;
  while (parent !== undefined) {
    const child: ModelNode = parent;
    parent = undefined;
    for (const other of rows.values()) {
      if (other.kind !== "region" || other.id === child.id) continue;
      const contains =
        child.x >= other.x &&
        child.y >= other.y &&
        child.x + child.width <= other.x + other.width &&
        child.y + child.height <= other.y + other.height;
      if (!contains) continue;
      if (parent === undefined || other.width * other.height < parent.width * parent.height) parent = other;
    }
    if (parent !== undefined) depth += 1;
  }
  return { regionId: innermost.id, regionDepth: depth };
};

const derivedOf = (row: ModelNode, input: DerivedInput): CardDerived => ({
  ...regionOf(row, input.rows),
  blocked: false,
  z: row.z,
});

const cardFact = (row: ModelNode, input: DerivedInput): CardFact => ({
  id: row.id,
  row,
  derived: derivedOf(row, input),
});

const wireFact = (row: ModelWire): WireFact => ({ id: row.id, row });

/** Everything the canvas scene starts from. */
const loadOps = (canvas: Canvas): ReadonlyArray<SceneOp> => {
  const rows = new Map<string, ModelNode>();
  for (const row of canvas.nodes.values()) rows.set(row.id, row);
  const input: DerivedInput = { rows };
  return [
    {
      kind: "load",
      canvas: canvas.name,
      cards: [...rows.values()].map((row) => cardFact(row, input)),
      wires: [...canvas.wires.values()].map(wireFact),
    },
  ];
};

/**
 * Follow the open canvas and hand the scene to `sink`. Returns the release.
 * The sink is called synchronously with whatever the model holds, then once
 * per changed row.
 */
export const startSceneBridge = (sink: Sink): (() => void) => {
  let closed = false;
  let releaseCanvas: (() => void) | undefined;
  let offScene: (() => void) | undefined;
  let offSelection: (() => void) | undefined;
  let loadedFor: string | undefined;
  let loaded = false;
  let rows = new Map<string, ModelNode>();
  let wires = new Map<string, ModelWire>();

  const close = (): void => {
    offScene?.();
    offSelection?.();
    releaseCanvas?.();
    offScene = undefined;
    offSelection = undefined;
    releaseCanvas = undefined;
    loadedFor = undefined;
    loaded = false;
    rows = new Map();
    wires = new Map();
  };

  const attach = (canvasName: string): void => {
    close();
    if (canvasName === "" || closed) return;
    loadedFor = canvasName;
    releaseCanvas = modelStore.open(canvasName);
    const model = modelStore.canvas$(canvasName);

    offScene = observe(() => {
      const canvas = modelStore.canvasOf(canvasName);
      if (canvas.name !== canvasName) return;
      if (!loaded) {
        const ops = loadOps(canvas);
        for (const op of ops) {
          if (op.kind === "load") {
            rows = new Map(op.cards.map((card) => [card.id, card.row]));
            wires = new Map(op.wires.map((wire) => [wire.id, wire.row]));
          }
        }
        loaded = true;
        sink.apply(ops);
        return;
      }
      const nextRows = new Map<string, ModelNode>();
      const ops: SceneOp[] = [];
      // Read every row once: a changed row sends that card alone.
      for (const id of model.nodeIds.get()) {
        const row = model.nodes[id]?.get();
        if (row !== undefined) nextRows.set(id, row);
      }
      const input: DerivedInput = { rows: nextRows };
      for (const [id, row] of nextRows) {
        if (rows.get(id) === row) continue;
        ops.push({ kind: "card", fact: cardFact(row, input) });
      }
      for (const id of rows.keys()) {
        if (!nextRows.has(id)) ops.push({ kind: "removeCard", id });
      }
      const nextWires = new Map<string, ModelWire>();
      for (const id of model.wireIds.get()) {
        const row = model.wires[id]?.get();
        if (row !== undefined) nextWires.set(id, row);
      }
      for (const [id, row] of nextWires) {
        if (wires.get(id) === row) continue;
        ops.push({ kind: "wire", fact: wireFact(row) });
      }
      for (const id of wires.keys()) {
        if (!nextWires.has(id)) ops.push({ kind: "removeWire", id });
      }
      rows = nextRows;
      wires = nextWires;
      if (ops.length > 0) sink.apply(ops);
    });

    offSelection = observe(() => {
      const nodeIds = state$.selectedNodeIds.get();
      const focus = state$.connectionFocusNodeId.get();
      sink.apply([
        {
          kind: "selection",
          fact: {
            nodeIds,
            ...(focus === "" ? {} : { connectionFocusNodeId: focus }),
          },
        },
      ]);
    });
  };

  const offName = observe(() => {
    const name = state$.canvasName.get();
    if (name !== loadedFor) attach(name);
  });
  attach(state$.canvasName.peek());

  return () => {
    if (closed) return;
    closed = true;
    offName();
    close();
  };
};

/** The open canvas's cards, read now (the magnifier's card list). */
export const canvasCardsNow = (canvasName: string): ReadonlyArray<ModelNode> => {
  const canvas = modelStore.canvasOf(canvasName);
  return canvas.name === canvasName ? [...canvas.nodes.values()] : [];
};
