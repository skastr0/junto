/**
 * The main-index group: what Electron main's own boot (`src/app/index.ts`)
 * asks the core on a request. A node ref an opened link names, the canvases
 * and play state the browser's edge grants and work socket read, the canvas
 * changes they follow, a content read for the content protocol, and a seat's
 * page box comment either side of the shot main takes. The core answers it
 * (`src/core/ops/main-index.ts`); main reaches it through the client service
 * below (`src/app/core-process/main-index-ipc.ts`).
 *
 * A refusal a caller reads (a page box the seat may not comment on) is an
 * answer; a read the core could not make fails with this group's errors, or
 * with `RpcClientError` when the core left before it answered.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { ContentOpenForRead, ContentRef } from "../../shared/content";
import { CanvasName, Node, NodeId, Seq, Wire, WireId } from "../../shared/model";
import { ItemId } from "../../shared/wire/ids";
import { coreClient } from "./link";

/** A node, or an item inside it, as main's ingress parsed its link (`shared/wire/node-ref.ts`). */
export const NodeRefPayload = Schema.Struct({
  canvasName: Schema.String,
  nodeId: Schema.String,
  itemId: Schema.optionalKey(ItemId),
});

/** One canvas held in memory, as `shared/model/canvas.ts` names it: its nodes and wires by id. */
export const CanvasDocument = Schema.Struct({
  name: CanvasName,
  seq: Seq,
  nodes: Schema.ReadonlyMap(NodeId, Node),
  wires: Schema.ReadonlyMap(WireId, Wire),
});

export const NamedCanvas = Schema.Struct({ name: Schema.String, doc: CanvasDocument });

/** A box on a page, in page coordinates (`shared/page-box.ts`). */
const PageRect = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, w: Schema.Finite, h: Schema.Finite });

/** A seat's box comment as its lease names it: the owner, the seat and the page. */
export const SeatPageBoxTarget = Schema.Struct({
  owner: Schema.String,
  sessionId: Schema.String,
  seatNodeId: Schema.String,
  pageRef: Schema.String,
  rect: PageRect,
  text: Schema.String,
});
export type SeatPageBoxTarget = typeof SeatPageBoxTarget.Type;

/** The shot main took of the box: its pixels, the page it was on, and where that page was scrolled. */
export const SeatPageShot = Schema.Struct({
  png: Schema.Uint8Array,
  url: Schema.String,
  scroll: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  rect: PageRect,
});
export type SeatPageShot = typeof SeatPageShot.Type;

const PageBoxRefusal = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.Literals(["invalid", "forbidden", "failed"]),
  message: Schema.String,
});

/** The core's check before main takes a seat's shot: go, or why not. */
export const PageBoxChecked = Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), PageBoxRefusal]);

/** A browser result's failure codes (`app/browser/sessions.ts`, BrowserErrorCode). */
const BrowserErrorCode = Schema.Literals([
  "invalid",
  "not_found",
  "forbidden",
  "failed",
  "timeout",
  "cancelled",
  "resource_exhausted",
  "unsupported_capability",
  "unsupported_result",
  "result_too_large",
  "operator_holds",
]);

/** The posted comment's message and thread, or why it was not posted. */
export const PageBoxPosted = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Struct({ messageId: Schema.String, threadId: Schema.String }) }),
  Schema.Struct({ ok: Schema.Literal(false), code: BrowserErrorCode, message: Schema.String }),
]);

/** The ref named nothing this core holds; the link that carried it opens nothing. */
export class MainIndexNodeRefUnresolved extends Schema.TaggedError<MainIndexNodeRefUnresolved>()("MainIndexNodeRefUnresolved", {
  reason: Schema.Literals(["InvalidNodeRef", "CanvasNotFound", "CanvasReadError", "NodeNotFound", "NodeKindMismatch"]),
  message: Schema.String,
}) {}

/** The canvases could not be read; an edge grant refuses until they can. */
export class MainIndexModelUnavailable extends Schema.TaggedError<MainIndexModelUnavailable>()("MainIndexModelUnavailable", {
  message: Schema.String,
}) {}

/** The content store could not open the object; the protocol answers it as unavailable. */
export class MainIndexContentUnreadable extends Schema.TaggedError<MainIndexContentUnreadable>()("MainIndexContentUnreadable", {
  message: Schema.String,
}) {}

export const MainIndexRpcs = RpcGroup.make(
  /** The canonical key of the node a link names, once the core found it. */
  Rpc.make("MainIndexResolveNodeRef", {
    payload: { ref: NodeRefPayload },
    success: Schema.Struct({ key: Schema.String }),
    error: MainIndexNodeRefUnresolved,
  }),
  Rpc.make("MainIndexCanvases", { success: Schema.Array(NamedCanvas), error: MainIndexModelUnavailable }),
  /** Whether this machine edits the canvas. */
  Rpc.make("MainIndexEditsCanvas", { payload: { canvasName: Schema.String }, success: Schema.Boolean, error: MainIndexModelUnavailable }),
  /**
   * Publish every canvas change and removal on `CANVAS_CHANGED` with the
   * document as it is now. The core subscribes once however often it is asked.
   */
  Rpc.make("MainIndexWatchCanvases"),
  /** A canvas's play state as the pause plane holds it now. */
  Rpc.make("MainIndexCanvasPlaying", { payload: { canvas: Schema.String }, success: Schema.Boolean }),
  Rpc.make("MainIndexOpenForRead", { payload: { ref: ContentRef }, success: ContentOpenForRead, error: MainIndexContentUnreadable }),
  Rpc.make("MainIndexPageBoxCheck", { payload: SeatPageBoxTarget, success: PageBoxChecked }),
  /** Checked again, since the canvas may have moved while main captured, then staged and posted as the seat. */
  Rpc.make("MainIndexPageBoxPost", { payload: { request: SeatPageBoxTarget, shot: SeatPageShot }, success: PageBoxPosted }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the main-index group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class MainIndexCore extends Context.Service<MainIndexCore, RpcClient.FromGroup<typeof MainIndexRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/MainIndexCore",
) {
  static readonly layer = Layer.effect(MainIndexCore, coreClient(MainIndexRpcs));
}
