import { Schema } from "effect";
import { HarnessId } from "../managed-terminal-templates";
import { Port } from "../physics/schema";
import { Verb } from "../physics/verbs";
import { TasksContract } from "../work-model";
import { CanvasName, Color, Frame, HostId, NodeId, Side } from "./base";
import {
  Cron,
  FileCard,
  GitCard,
  Launch,
  Node,
  Page,
  PageOnRemove,
  Sheet,
  TerminalOnRemove,
  type NodeKind,
} from "./kinds";
import {
  RegionBackgroundStyle,
  RegionContract,
  RegionDefaults,
  RegionEnvironment,
} from "./region";
import { Wire, WireId } from "./wire";

// How anything on a canvas is changed: by saying what should change. A command
// names the rows it touches and carries only the new values for them. Nobody
// sends a canvas back to be saved.

/** A field being set. */
const set = Schema.optionalKey;
/** A field that may be absent on the node: `null` clears it. */
const setOrClear = <S extends Schema.Top>(field: S) => Schema.optionalKey(Schema.NullOr(field));

const label = setOrClear(Schema.String);
const edit = <const K extends NodeKind, Fields extends Schema.Struct.Fields>(
  kind: K,
  fields: Fields,
) => Schema.Struct({ kind: Schema.Literal(kind), ...fields });

/**
 * What may be changed on a node after it is made, per kind. A seat's `name`
 * and a session's `bindingId` are not here: they are who the thing is.
 */
export const NodeEdit = Schema.Union([
  edit("agent", {
    label: set(Schema.String),
    host: set(HostId),
    overseer: set(Schema.Boolean),
    harness: set(HarnessId),
    launch: setOrClear(Launch),
    sessionId: setOrClear(Schema.String),
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
  edit("task", { name: setOrClear(Schema.String), contract: setOrClear(TasksContract) }),
  edit("requests", { name: setOrClear(Schema.String) }),
  edit("artifacts", { label }),
  edit("board", { label }),
  edit("pad", { label }),
  edit("sheet", {
    label,
    columns: set(Sheet.fields.columns),
    rows: set(Sheet.fields.rows),
  }),
  edit("cron", { label, expression: set(Cron.fields.expression) }),
  edit("relay", { label }),
  edit("watcher", {
    label,
    key: setOrClear(Schema.String),
    stat: setOrClear(Schema.String),
    op: setOrClear(Schema.Literals(["gt", "lt", "eq"])),
    value: setOrClear(Schema.Finite),
  }),
  edit("note", { text: set(Schema.String) }),
  edit("label", { text: set(Schema.String) }),
  edit("file", { path: set(FileCard.fields.path), subpath: setOrClear(Schema.String) }),
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

/** A new rectangle for one node. Width and height are absent for a pure move. */
export const NodeMove = Schema.Struct({
  id: NodeId,
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.optionalKey(Frame.fields.width),
  height: Schema.optionalKey(Frame.fields.height),
});
export type NodeMove = typeof NodeMove.Type;

export const Command = Schema.TaggedUnion({
  /** Put new nodes and wires on a canvas. Ids are minted by the sender. */
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
  /** Change the paint order. Lists the nodes that move, lowest first. */
  Restack: { canvas: CanvasName, order: Schema.Array(NodeId) },
  Recolor: {
    canvas: CanvasName,
    nodes: Schema.Array(NodeId),
    color: Schema.NullOr(Color),
  },
  /** Change fields of one node. */
  Edit: { canvas: CanvasName, id: NodeId, change: NodeEdit },
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
  CreateCanvas: { canvas: CanvasName },
  RemoveCanvas: { canvas: CanvasName },
  RenameCanvas: { canvas: CanvasName, to: CanvasName },
});
export type Command = typeof Command.Type;

/** The edit a given kind accepts. */
export type NodeEditOf<K extends NodeKind> = Extract<NodeEdit, { readonly kind: K }>;
