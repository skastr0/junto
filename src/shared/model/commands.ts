import { Schema, Struct } from "effect";
import { HarnessId } from "../managed-terminal-templates";
import { Port } from "../physics/schema";
import { Verb } from "../physics/verbs";
import { TasksContract } from "../work-model";
import { CanvasName, Color, Frame, HostId, NodeId, Side } from "./base";
import {
  FileCard,
  GitCard,
  Launch,
  Node,
  OneLine,
  Page,
  PageOnRemove,
  Seat,
  TerminalOnRemove,
  type NodeKind,
} from "./kinds";
import {
  RegionBackgroundStyle,
  RegionContract,
  RegionDefaults,
  RegionEnvironment,
} from "./region";
import { SheetGrid } from "./sheet";
import { Wire, WireId } from "./wire";

// How anything on a canvas is changed: by saying what should change. A command
// names the rows it touches and carries only the new values for them. Nobody
// sends a canvas back to be saved.

/** A field being set. */
const set = Schema.optionalKey;
/** A field that may be absent on the node: `null` clears it. */
const setOrClear = <S extends Schema.Top>(field: S) =>
  Schema.optionalKey(Schema.NullOr(field));

const label = setOrClear(OneLine);
const NonEmptyLine = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const edit = <const K extends NodeKind, Fields extends Schema.Struct.Fields>(
  kind: K,
  fields: Fields,
) => Schema.Struct({ kind: Schema.Literal(kind), ...fields });

/**
 * What may be changed on a node after it is made, per kind. Not here, because
 * they are not ordinary edits: a seat's `agentKey` and a session's `bindingId`
 * (who the thing is), a seat's `overseer` (a grant of authority, with its own
 * command) and its `sessionId` (recorded by the runtime, not typed).
 */
export const NodeEdit = Schema.Union([
  edit("agent", {
    label: set(OneLine),
    host: set(HostId),
    harness: set(HarnessId),
    launch: setOrClear(Launch),
    onRemove: set(TerminalOnRemove),
  }),
  edit("terminal", {
    label,
    host: set(HostId),
    launch: setOrClear(Launch),
    onRemove: set(TerminalOnRemove),
  }),
  edit("page", {
    url: set(Schema.String),
    profile: set(Page.fields.profile),
    host: set(HostId),
    onRemove: set(PageOnRemove),
  }),
  edit("task", {
    name: setOrClear(OneLine),
    contract: setOrClear(TasksContract),
  }),
  edit("requests", { name: setOrClear(OneLine) }),
  edit("artifacts", { label }),
  edit("board", { label }),
  edit("pad", { label }),
  edit("sheet", { label }),
  edit("cron", { label, host: set(HostId), expression: setOrClear(NonEmptyLine) }),
  edit("relay", { label, host: set(HostId) }),
  edit("watcher", {
    label,
    host: set(HostId),
    key: setOrClear(Schema.String),
    stat: setOrClear(Schema.String),
    op: setOrClear(Schema.Literals(["gt", "lt", "eq"])),
    value: setOrClear(Schema.Finite),
  }),
  edit("note", { text: set(Schema.String) }),
  edit("label", { text: set(Schema.String) }),
  edit("file", {
    path: set(FileCard.fields.path),
    subpath: setOrClear(Schema.String),
  }),
  edit("link", { url: set(Schema.String) }),
  edit("git", { label, cwd: set(GitCard.fields.cwd) }),
  edit("region", {
    label,
    hold: set(Schema.Boolean),
    instruction: setOrClear(Schema.String),
    defaults: setOrClear(RegionDefaults),
    contract: setOrClear(RegionContract),
    environment: setOrClear(RegionEnvironment),
    background: setOrClear(Schema.String),
    backgroundStyle: setOrClear(RegionBackgroundStyle),
  }),
]);
export type NodeEdit = typeof NodeEdit.Type;

/** A new position for one node, and a new size when it was resized too. */
export const NodeMove = Schema.Struct({
  id: NodeId,
  x: Schema.Finite,
  y: Schema.Finite,
  z: Schema.optionalKey(Schema.Int),
  size: Schema.optionalKey(Frame.mapFields(Struct.pick(["width", "height"]))),
});
export type NodeMove = typeof NodeMove.Type;

const canvasCommandFields = {
  /**
   * Put new nodes and wires on a canvas. Ids are minted by the sender. A seat
   * that was removed may be added back as it was, agent key and session binding
   * included: that is how a removal is undone.
   */
  Add: {
    canvas: CanvasName,
    nodes: Schema.Array(Node),
    wires: Schema.Array(Wire),
  },
  /** Take nodes off a canvas. Wires at either end go with them. */
  Remove: {
    canvas: CanvasName,
    nodes: Schema.Array(NodeId),
    wires: Schema.Array(WireId),
  },
  /** Move or resize. Many at once is one command: a drag of a selection. */
  Move: { canvas: CanvasName, moves: Schema.Array(NodeMove) },
  /**
   * Bring nodes to the front or send them to the back, keeping their order
   * among themselves.
   */
  Restack: {
    canvas: CanvasName,
    nodes: Schema.Array(NodeId),
    to: Schema.Literals(["front", "back"]),
  },
  Recolor: {
    canvas: CanvasName,
    nodes: Schema.Array(NodeId),
    color: Schema.NullOr(Color),
  },
  /** Change fields of one node. `change.kind` must be the node's kind. */
  Edit: { canvas: CanvasName, id: NodeId, change: NodeEdit },
  /** Replace what a sheet holds. */
  WriteSheet: { canvas: CanvasName, id: NodeId, grid: SheetGrid },
  /** Change what a wire grants or where it attaches. Its ends are fixed. */
  Rewire: {
    canvas: CanvasName,
    id: WireId,
    change: Schema.Struct({
      verb: set(Verb),
      mask: setOrClear(Schema.Array(Port)),
      fromSide: setOrClear(Side),
      toSide: setOrClear(Side),
    }),
  },
  /** Change the agent occupying the same node, keeping its wires and mailbox. */
  Reseat: {
    canvas: CanvasName,
    id: NodeId,
    agentKey: Seat.fields.agentKey,
    bindingId: Seat.fields.bindingId,
    harness: HarnessId,
    host: HostId,
    launch: Schema.optionalKey(Schema.NullOr(Launch)),
  },
} as const;

/** The operations allowed inside one atomic per-canvas edit. */
export const CanvasCommand = Schema.TaggedUnion(canvasCommandFields);
export type CanvasCommand = typeof CanvasCommand.Type;

export const Command = Schema.TaggedUnion({
  ...canvasCommandFields,
  /** Apply all steps or none, with one committed spatial change. */
  Batch: { canvas: CanvasName, steps: Schema.Array(CanvasCommand) },
  /**
   * Give or take away a seat's authority to administer the canvas. Its own
   * command because it is the operator's decision alone: main admits it only
   * from the operator, never from a seat and never as part of another edit.
   */
  GrantOverseer: { canvas: CanvasName, id: NodeId, overseer: Schema.Boolean },
  /** Record the harness session a seat is now running, or that it has none. */
  RecordSession: {
    canvas: CanvasName,
    id: NodeId,
    sessionId: Schema.NullOr(Schema.String),
  },
  CreateCanvas: { canvas: CanvasName },
  RemoveCanvas: { canvas: CanvasName },
});
export type Command = typeof Command.Type;

/** The edit a given kind accepts. */
export type NodeEditOf<K extends NodeKind> = Extract<
  NodeEdit,
  { readonly kind: K }
>;

const strict = { onExcessProperty: "error" } as const;

/**
 * Read a command from outside the process. An unknown field anywhere in it,
 * including on a node it carries, is an error.
 */
export const decodeCommand = (input: unknown) =>
  Schema.decodeUnknownEffect(Command)(input, strict);
