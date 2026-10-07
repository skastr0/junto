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

/**
 * A seat to add. It cannot be drafted an overseer: that is the operator's
 * grant, with its own command. Its session binding may be left out for main
 * to mint.
 */
export const SeatDraft = Seat.mapFields((fields) => ({
  ...Struct.omit(fields, ["id", "z", "overseer", "bindingId"]),
  id: Schema.optionalKey(fields.id),
  bindingId: Schema.optionalKey(fields.bindingId),
}));
export type SeatDraft = typeof SeatDraft.Type;

/** Any node to add, told by its kind. */
export const NodeDraft = Schema.Union([
  SeatDraft,
  draft(Terminal),
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
