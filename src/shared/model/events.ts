import { Schema } from "effect";
import { CanvasName, NodeId } from "./base";
import { Node } from "./kinds";
import { Wire, WireId } from "./wire";

// What main tells every listener after a change is committed. It names the
// canvas and carries exactly the rows that changed, so a listener applies it
// and never reads the canvas again.

/** Counts committed changes to one canvas. A gap means: read it afresh. */
export const Seq = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
export type Seq = typeof Seq.Type;

export const Changed = Schema.Struct({
  canvas: CanvasName,
  /** The canvas's count after this change. Always the previous one plus one. */
  seq: Seq,
  /**
   * Nodes as they are now, whether new or changed. Every node whose `z` moved
   * is here, including ones another node's removal or restack only shifted.
   */
  nodes: Schema.Array(Node),
  wires: Schema.Array(Wire),
  removedNodes: Schema.Array(NodeId),
  removedWires: Schema.Array(WireId),
});
export type Changed = typeof Changed.Type;

/** A canvas was made, removed or renamed. */
export const CanvasesChanged = Schema.TaggedUnion({
  Created: { canvas: CanvasName },
  Removed: { canvas: CanvasName },
  Renamed: { from: CanvasName, to: CanvasName },
});
export type CanvasesChanged = typeof CanvasesChanged.Type;

/**
 * Everything on one canvas, read once when it is opened. After that the
 * listener follows `Changed` from `seq` onward.
 */
export const Opened = Schema.Struct({
  canvas: CanvasName,
  seq: Seq,
  nodes: Schema.Array(Node),
  wires: Schema.Array(Wire),
});
export type Opened = typeof Opened.Type;

const strict = { onExcessProperty: "error" } as const;

/** Read what main sent. An unknown field anywhere in it is an error. */
export const decodeChanged = (input: unknown) =>
  Schema.decodeUnknownEffect(Changed)(input, strict);
export const decodeOpened = (input: unknown) =>
  Schema.decodeUnknownEffect(Opened)(input, strict);
