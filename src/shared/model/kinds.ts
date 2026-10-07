import { Schema } from "effect";
import { HarnessId } from "../managed-terminal-templates";
import { TasksContract } from "../work-model";
import { HostId, placement } from "./base";
import { Region } from "./region";

// Every kind of thing that can sit on a canvas, each with exactly the fields
// it has. The `kind` word is the one the rest of the app already uses for it.
//
// Nothing here is live work. Mail, tasks, requests, artifacts, board posts and
// pad shapes are rows of their own, read by the id of the thing they belong
// to, and never ride along on it.

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** A variable name a process environment accepts. */
const EnvName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
);

// ── Seats and terminals ─────────────────────────────────────────────────────

export const LaunchKind = Schema.Literals(["shell", "command", "harness"]);
export type LaunchKind = typeof LaunchKind.Type;

/** How a seat or terminal is started. Inert until a deliberate start. */
export const Launch = Schema.Struct({
  kind: LaunchKind,
  argv: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(EnvName, Schema.String)),
  /**
   * Operator-authored harness arguments beyond the picker dials. Already part
   * of `argv`; kept as well so every replanned spawn and resume appends the
   * same tokens.
   */
  extraArgs: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type Launch = typeof Launch.Type;

/** What happens to the running session when the thing is removed. */
export const TerminalOnRemove = Schema.Literals(["detach", "kill-session"]);
export type TerminalOnRemove = typeof TerminalOnRemove.Type;

/** Stable identity of a terminal session across restarts. Not a process id. */
export const BindingId = NonEmpty.pipe(Schema.brand("BindingId"));
export type BindingId = typeof BindingId.Type;

/**
 * A seat: an agent with a harness, a terminal session and a mailbox. The one
 * kind that acts.
 */
export const Seat = Schema.Struct({
  kind: Schema.Literal("agent"),
  ...placement,
  /** Fixed at creation and never edited: the key other records join on. */
  name: NonEmpty,
  /** What the operator sees and may rename. */
  label: Schema.String,
  host: HostId,
  /** Operator-granted administrative authority over the canvas. */
  overseer: Schema.Boolean,
  bindingId: BindingId,
  harness: HarnessId,
  launch: Schema.optionalKey(Launch),
  /** The harness's own session or thread id, for resuming it cold. */
  sessionId: Schema.optionalKey(Schema.String),
  onRemove: TerminalOnRemove,
});
export type Seat = typeof Seat.Type;

/** A plain terminal the operator opened. It has no harness and no mailbox. */
export const Terminal = Schema.Struct({
  kind: Schema.Literal("terminal"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
  host: HostId,
  bindingId: BindingId,
  launch: Schema.optionalKey(Launch),
  onRemove: TerminalOnRemove,
});
export type Terminal = typeof Terminal.Type;

// ── Surfaces agents work against ────────────────────────────────────────────

export const PageOnRemove = Schema.Literals(["detach", "kill-session"]);
export type PageOnRemove = typeof PageOnRemove.Type;

/** An in-app browser page. Cookies live with the profile, never here. */
export const Page = Schema.Struct({
  kind: Schema.Literal("page"),
  ...placement,
  url: Schema.String,
  profile: NonEmpty,
  host: HostId,
  onRemove: PageOnRemove,
});
export type Page = typeof Page.Type;

/** A task board. The tasks themselves are work rows keyed by this id. */
export const TaskBoard = Schema.Struct({
  kind: Schema.Literal("task"),
  ...placement,
  name: Schema.optionalKey(Schema.String),
  /** What agents read and must satisfy when they take a task here. */
  contract: Schema.optionalKey(TasksContract),
});
export type TaskBoard = typeof TaskBoard.Type;

export const Requests = Schema.Struct({
  kind: Schema.Literal("requests"),
  ...placement,
  name: Schema.optionalKey(Schema.String),
});
export type Requests = typeof Requests.Type;

export const Artifacts = Schema.Struct({
  kind: Schema.Literal("artifacts"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
});
export type Artifacts = typeof Artifacts.Type;

/** A bulletin board. Topics and posts are work rows keyed by this id. */
export const Board = Schema.Struct({
  kind: Schema.Literal("board"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
});
export type Board = typeof Board.Type;

/** A drawing pad. Its shapes are work rows keyed by this id. */
export const Pad = Schema.Struct({
  kind: Schema.Literal("pad"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
});
export type Pad = typeof Pad.Type;

/**
 * A small grid the operator types and agents read. The grid itself is content
 * of its own, read by this id (see sheet.ts), so moving or renaming the sheet
 * never carries its rows.
 */
export const Sheet = Schema.Struct({
  kind: Schema.Literal("sheet"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
});
export type Sheet = typeof Sheet.Type;

// ── Things that fire on their own ───────────────────────────────────────────

export const Cron = Schema.Struct({
  kind: Schema.Literal("cron"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
  /** Five fields: minute, hour, day of month, month, day of week. */
  expression: NonEmpty,
});
export type Cron = typeof Cron.Type;

export const Relay = Schema.Struct({
  kind: Schema.Literal("relay"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
});
export type Relay = typeof Relay.Type;

/** Fires when a numeric stat of a Hermes agent crosses a threshold. */
export const Watcher = Schema.Struct({
  kind: Schema.Literal("watcher"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
  stat: Schema.optionalKey(Schema.String),
  op: Schema.optionalKey(Schema.Literals(["gt", "lt", "eq"])),
  value: Schema.optionalKey(Schema.Finite),
});
export type Watcher = typeof Watcher.Type;

// ── Things that only sit there ──────────────────────────────────────────────

export const Note = Schema.Struct({
  kind: Schema.Literal("note"),
  ...placement,
  text: Schema.String,
});
export type Note = typeof Note.Type;

/** Bare text on the map, with no card around it. */
export const Label = Schema.Struct({
  kind: Schema.Literal("label"),
  ...placement,
  text: Schema.String,
});
export type Label = typeof Label.Type;

/** A file shown on the canvas, by path. */
export const FileCard = Schema.Struct({
  kind: Schema.Literal("file"),
  ...placement,
  path: NonEmpty,
  subpath: Schema.optionalKey(Schema.String),
});
export type FileCard = typeof FileCard.Type;

/** A plain web link. An in-app browser is a `Page`, not this. */
export const LinkCard = Schema.Struct({
  kind: Schema.Literal("link"),
  ...placement,
  url: Schema.String,
});
export type LinkCard = typeof LinkCard.Type;

/** A commit browser over one repository. Branch and diff are read live. */
export const GitCard = Schema.Struct({
  kind: Schema.Literal("git"),
  ...placement,
  label: Schema.optionalKey(Schema.String),
  cwd: NonEmpty,
});
export type GitCard = typeof GitCard.Type;

// ── The closed set ──────────────────────────────────────────────────────────

/**
 * Everything that can be on a canvas. Closed on purpose: a new kind is a new
 * member here with its own fields and its own table, never a string and a bag.
 */
export const Node = Schema.Union([
  Seat,
  Terminal,
  Page,
  TaskBoard,
  Requests,
  Artifacts,
  Board,
  Pad,
  Sheet,
  Cron,
  Relay,
  Watcher,
  Note,
  Label,
  FileCard,
  LinkCard,
  GitCard,
  Region,
]);
export type Node = typeof Node.Type;

export type NodeKind = Node["kind"];

export const NODE_KINDS = [
  "agent",
  "terminal",
  "page",
  "task",
  "requests",
  "artifacts",
  "board",
  "pad",
  "sheet",
  "cron",
  "relay",
  "watcher",
  "note",
  "label",
  "file",
  "link",
  "git",
  "region",
] as const satisfies ReadonlyArray<NodeKind>;

/** The member of `Node` with a given kind word. */
export type NodeOf<K extends NodeKind> = Extract<Node, { readonly kind: K }>;

export const isKind =
  <K extends NodeKind>(kind: K) =>
  (node: Node): node is NodeOf<K> =>
    node.kind === kind;

export const isSeat = isKind("agent");
export const isRegion = isKind("region");

/**
 * Read a node from outside the process. An unknown field is an error, not
 * something to carry: that is what keeps a kind from growing a bag.
 */
export const decodeNode = (input: unknown) =>
  Schema.decodeUnknownEffect(Node)(input, { onExcessProperty: "error" });
