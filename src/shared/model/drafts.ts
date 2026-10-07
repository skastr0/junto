import { Schema, Struct } from "effect";
import {
  Artifacts,
  Board,
  Cron,
  FileCard,
  GitCard,
  Label,
  LinkCard,
  Note,
  Pad,
  Page,
  Relay,
  Requests,
  Seat,
  Sheet,
  TaskBoard,
  Terminal,
  Watcher,
} from "./kinds";
import { Region } from "./region";
import { Wire } from "./wire";

// What a sender says to put a new thing on a canvas, before main has placed
// it. Each draft is its model schema with only the fields main decides taken
// out or made optional, so a draft and the node it becomes never drift apart.

/**
 * A node to add. Its id may be left out for main to mint, and it says nothing
 * of where it stacks: a new node goes on top.
 */
const draft = <Fields extends { readonly id: Schema.Top; readonly z: Schema.Top }>(
  member: Schema.Struct<Fields>,
) =>
  member.mapFields((fields) => ({
    ...Struct.omit(fields, ["id", "z"]),
    id: Schema.optionalKey(fields.id),
  }));

const Choice = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/**
 * A seat to add, by naming what it runs. This is not the model's seat with
 * fields left out: a sender says the harness and its dials, and main works out
 * the rest with the one set of seat launch rules (the agent key, the session
 * binding, the launch and a pinned session). So it has no `agentKey`,
 * `bindingId`, `launch` or `sessionId`, and no `overseer`, which is the
 * operator's grant with its own command. A plain terminal, by contrast, is
 * drafted with its launch: a command is what the sender means there.
 */
export const SeatDraft = Schema.Struct({
  kind: Seat.fields.kind,
  id: Schema.optionalKey(Seat.fields.id),
  x: Seat.fields.x,
  y: Seat.fields.y,
  width: Seat.fields.width,
  height: Seat.fields.height,
  color: Seat.fields.color,
  /** Defaults to the harness name and its dials. */
  label: Schema.optionalKey(Seat.fields.label),
  harness: Seat.fields.harness,
  /** The machine the seat runs on. Defaults to this one. */
  host: Schema.optionalKey(Seat.fields.host),
  profile: Schema.optionalKey(Choice),
  model: Schema.optionalKey(Choice),
  effort: Schema.optionalKey(Choice),
  mode: Schema.optionalKey(Choice),
  permissionMode: Schema.optionalKey(Choice),
  /** The directory the seat starts in. */
  cwd: Schema.optionalKey(Choice),
  /** Defaults to detach. */
  onRemove: Schema.optionalKey(Seat.fields.onRemove),
});
export type SeatDraft = typeof SeatDraft.Type;

/** A plain terminal to add. Its session binding may be left out for main to mint. */
export const TerminalDraft = Terminal.mapFields((fields) => ({
  ...Struct.omit(fields, ["id", "z", "bindingId"]),
  id: Schema.optionalKey(fields.id),
  bindingId: Schema.optionalKey(fields.bindingId),
}));
export type TerminalDraft = typeof TerminalDraft.Type;

/** The fields of the model's seat a draft may not carry: main works them out. */
export const SEAT_FIELDS_MAIN_WORKS_OUT = [
  "agentKey",
  "bindingId",
  "launch",
  "sessionId",
  "overseer",
] as const;

/** Any node to add, told by its kind. */
export const NodeDraft = Schema.Union([
  SeatDraft,
  TerminalDraft,
  draft(Page),
  draft(TaskBoard),
  draft(Requests),
  draft(Artifacts),
  draft(Board),
  draft(Pad),
  draft(Sheet),
  draft(Cron),
  draft(Relay),
  draft(Watcher),
  draft(Note),
  draft(Label),
  draft(FileCard),
  draft(LinkCard),
  draft(GitCard),
  draft(Region),
]);
export type NodeDraft = typeof NodeDraft.Type;

/**
 * A wire to add. Its id may be left out for main to mint, and its verb for
 * main to choose the default the two ends allow.
 */
export const WireDraft = Wire.mapFields((fields) => ({
  ...Struct.omit(fields, ["id", "verb"]),
  id: Schema.optionalKey(fields.id),
  verb: Schema.optionalKey(fields.verb),
})).pipe(
  Schema.check(
    Schema.makeFilter((wire) => wire.from !== wire.to || "a wire joins two different nodes"),
  ),
);
export type WireDraft = typeof WireDraft.Type;
