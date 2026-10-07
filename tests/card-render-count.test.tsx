// @vitest-environment jsdom
/**
 * A card renders when its own node changed and at no other time.
 *
 * Mounts React Flow with a handful of cards, lets React Flow measure them (it
 * then holds its own copy of each node, with the measurement on it), moves one
 * card the way a canvas rebuild does, and holds the render count of every
 * untouched card at zero. Without the rule in flow-identity.ts each rebuild
 * hands React Flow fresh objects and every card on the canvas renders again.
 */
import { vi } from "vitest";

// jsdom has no ResizeObserver, and it must exist before the cards are imported.
vi.hoisted(() => {
  class QuietResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= QuietResizeObserver;
});

import { act, memo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReactFlow, ReactFlowProvider, useNodesState, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { keepHeldNodes, sameCard } from "../src/renderer/lib/flow-identity";
import { nodeTypes } from "../src/renderer/components/nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


type Card = Node<{ readonly canvas: string; readonly id: string; readonly kind: string; readonly blocked: boolean }>;

const renders = new Map<string, number>();
function ProbeCard({ id }: NodeProps<Card>): ReactNode {
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return <div data-probe={id}>{id}</div>;
}

const STYLE = { width: 240, height: 120 };
const dataOf = new Map<string, Card["data"]>();
/** The node as a rebuild of the canvas makes it: the same data and style objects each time, never a measurement. */
const rebuilt = (id: string, x: number): Card => {
  let data = dataOf.get(id);
  if (data === undefined) {
    data = { canvas: "factory", id, kind: "note", blocked: false };
    dataOf.set(id, data);
  }
  return { id, type: "probe", position: { x, y: 0 }, data, style: STYLE };
};

type Rig = {
  rebuild: (next: ReadonlyArray<Card>) => void;
  change: (changes: NodeChange<Card>[]) => void;
  held: () => ReadonlyArray<Card>;
};

function Canvas({ rule, rig, first }: { rule: "keep" | "replace"; rig: Rig; first: Card[] }): ReactNode {
  const [nodes, setNodes, onNodesChange] = useNodesState<Card>(first);
  rig.rebuild = (next) => setNodes((prev) => (rule === "keep" ? keepHeldNodes(prev, next) : [...next]));
  rig.change = onNodesChange;
  rig.held = () => nodes;
  return <ReactFlow nodes={nodes} onNodesChange={onNodesChange} nodeTypes={probeTypes[rule]} />;
}

const probeTypes = {
  keep: { probe: memo(ProbeCard, sameCard) },
  // What the canvas did before: a card that renders whenever its wrapper does.
  replace: { probe: ProbeCard },
};

describe("cards across a move of another card", () => {
  let host: HTMLDivElement;
  let root: Root;
  const rig: Rig = { rebuild: () => undefined, change: () => undefined, held: () => [] };

  const mount = (rule: "keep" | "replace"): void => {
    act(() => {
      root.render(
        <div style={{ width: 800, height: 600 }}>
          <ReactFlowProvider>
            <Canvas rule={rule} rig={rig} first={[rebuilt("a", 0), rebuilt("b", 300), rebuilt("c", 600)]} />
          </ReactFlowProvider>
        </div>,
      );
    });
    // React Flow measures each card and from then on holds a copy of the node
    // with the measurement on it.
    act(() => {
      rig.change(
        ["a", "b", "c"].map((id) => ({ id, type: "dimensions", dimensions: { width: 240, height: 120 } })),
      );
    });
    expect(rig.held().every((node) => node.measured !== undefined)).toBe(true);
    renders.clear();
  };

  beforeEach(() => {
    renders.clear();
    dataOf.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders no untouched card when one card moves", () => {
    mount("keep");
    act(() => rig.rebuild([rebuilt("a", 0), rebuilt("b", 340), rebuilt("c", 600)]));
    expect(renders.get("a") ?? 0).toBe(0);
    expect(renders.get("c") ?? 0).toBe(0);
    // The untouched cards kept what React Flow measured for them.
    const held = rig.held();
    expect(held.find((node) => node.id === "a")?.measured).toBeDefined();
    expect(held.find((node) => node.id === "c")?.measured).toBeDefined();
    expect(held.find((node) => node.id === "b")?.position.x).toBe(340);
  });

  it("renders no card at all when a rebuild changes nothing", () => {
    mount("keep");
    const before = rig.held();
    act(() => rig.rebuild([rebuilt("a", 0), rebuilt("b", 300), rebuilt("c", 600)]));
    expect([...renders.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
    expect(rig.held()).toBe(before);
  });

  it("does render every card without the rule, which is what this guards against", () => {
    mount("replace");
    act(() => rig.rebuild([rebuilt("a", 0), rebuilt("b", 340), rebuilt("c", 600)]));
    expect(renders.get("a") ?? 0).toBeGreaterThan(0);
    expect(renders.get("c") ?? 0).toBeGreaterThan(0);
  });

  it("is the rule the real cards are registered with", () => {
    for (const type of ["text", "file", "link", "group"] as const) {
      expect((nodeTypes[type] as unknown as { compare?: unknown }).compare).toBe(sameCard);
    }
  });
});
