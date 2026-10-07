import type { Edge } from "@xyflow/react";
import type { WirePhase } from "@shared/model";
import type { Node, Wire } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import { VERB_COLOR_TOKEN, type Verb } from "@shared/physics";
import { physicsKind } from "./model-kind";
import { renderedNodeSize } from "./node-geometry";
import { wireSides, type WireSideRect } from "./wire-sides";

// A canvas's wires as React Flow draws them, worked out from the model. A
// wire says one thing, its verb, and paints one way: the verb picks a colour
// token and nothing else varies.

/** Above every region band, below every card (flow-nodes.ts). */
const WIRE_Z = 16;

export type ModelEdgeData = {
  readonly rippling: boolean;
  readonly phase: WirePhase;
  readonly detail: string;
  /** Focus selection member (stoppage cone or direct connection neighborhood). */
  impact?: "in";
  /** The relationship this wire is. */
  readonly verb: Verb;
  /** CSS custom-property name carrying that verb's hue. The whole of the paint. */
  readonly colorToken: string;
  /** The kinds at the two ends, as the verb table names them. */
  readonly fromKind?: string | undefined;
  readonly toKind?: string | undefined;
};

export type ModelFlowEdge = Edge<ModelEdgeData>;

/** Reuses a flow edge while the wire and everything else it shows are unchanged. */
export type ModelFlowEdgeCache = Map<string, { readonly wire: Wire; readonly flow: ModelFlowEdge }>;

/** What the execution graph says of each wire, however it was worked out. */
export type WirePhases = {
  readonly phaseOf: (wireId: string) => WirePhase;
  readonly detailOf: (wireId: string) => string;
  readonly rippling: (wireId: string) => boolean;
};

/** A card's rectangle at the size it is drawn at, which is where its sockets are. */
const rectOf = (node: Node | undefined): WireSideRect | undefined =>
  node === undefined ? undefined : { x: node.x, y: node.y, ...renderedNodeSize(node.kind, node) };

/**
 * The React Flow edges for a canvas. A wire's sockets follow where its two
 * cards sit; the sides the wire holds only stand in when an end is missing.
 */
export const flowEdgesFromModel = (
  canvas: Canvas,
  phases: WirePhases,
  cache?: ModelFlowEdgeCache,
): ModelFlowEdge[] => {
  const seen = new Set<string>();
  const built = [...canvas.wires.values()].map((wire) => {
    seen.add(wire.id);
    const from = canvas.nodes.get(wire.from);
    const to = canvas.nodes.get(wire.to);
    const fromRect = rectOf(from);
    const toRect = rectOf(to);
    const sides = fromRect && toRect ? wireSides(fromRect, toRect) : undefined;
    const sourceHandle = `s-${sides?.source ?? wire.fromSide ?? "right"}`;
    const targetHandle = `t-${sides?.target ?? wire.toSide ?? "left"}`;
    const phase = phases.phaseOf(wire.id);
    const detail = phases.detailOf(wire.id);
    const rippling = phases.rippling(wire.id);
    const fromKind = from === undefined ? undefined : physicsKind(from.kind);
    const toKind = to === undefined ? undefined : physicsKind(to.kind);
    const cached = cache?.get(wire.id);
    // The wire object is the whole of what it says; the rest moves when a card
    // does or the kernel says something new about it.
    if (
      cached !== undefined &&
      cached.wire === wire &&
      cached.flow.sourceHandle === sourceHandle &&
      cached.flow.targetHandle === targetHandle &&
      cached.flow.data?.phase === phase &&
      cached.flow.data?.detail === detail &&
      cached.flow.data?.rippling === rippling &&
      cached.flow.data?.fromKind === fromKind &&
      cached.flow.data?.toKind === toKind
    ) {
      return cached.flow;
    }
    const flow: ModelFlowEdge = {
      id: wire.id,
      source: wire.from,
      target: wire.to,
      sourceHandle,
      targetHandle,
      type: "wire",
      data: { rippling, phase, detail, verb: wire.verb, colorToken: VERB_COLOR_TOKEN[wire.verb], fromKind, toKind },
      zIndex: WIRE_Z,
    };
    cache?.set(wire.id, { wire, flow });
    return flow;
  });
  if (cache) for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  return built;
};
