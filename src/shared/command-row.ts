/**
 * Resource commands and rulings as rows on the exchange
 * (docs/plans/0.10/02-universal-resources.md, "Editing machine away").
 *
 * A seat's machine writes each command as its own `command.queued` row; the
 * machine that edits the canvas rules it and writes `ruling.applied` or
 * `ruling.refused`, with the ruled facts, in one transaction. The rows travel
 * on `rows` like mail, so a command written while the editing machine is away
 * waits as mail waits. This module is the wire shape of those rows and the
 * pure rules about who may write and receive them; the envelope, the ruler
 * and the overlay are `resource-command.ts`.
 */
import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import {
  COMMAND_ROW_MAX_BYTES,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_ROWS,
  ResourceActor,
  type CommandKey,
  type ResourceCommand,
  commandKey,
  resourceCommandSchema,
} from "./resource-command";
import { WorkErrorBody } from "./work-control";
import { OpId } from "./work-ids";

const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * A domain's op as the row carries it. The transport does not know the
 * domains: the editing machine decodes it with the target kind's closed op
 * schema when it rules, and refuses `invalid_input` when that fails.
 */
export const QueuedOp = Schema.Json;

export const QueuedCommand = resourceCommandSchema(QueuedOp);
export type QueuedCommand = typeof QueuedCommand.Type;

/** One command row, at most 64 KiB encoded; text over that travels as a content ref. */
export const CommandQueuedResult = Schema.Struct({
  operation: Schema.Literal("command.queued"),
  command: QueuedCommand,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (body) => encodedBytes(body) <= COMMAND_ROW_MAX_BYTES || `a command row is at most ${COMMAND_ROW_MAX_BYTES} bytes`,
    ),
  ),
);
export type CommandQueuedResult = typeof CommandQueuedResult.Type;

/** The ids of the facts a ruling applied, all the editing machine's own, written in the ruling's transaction. */
const RuledFactSeqs = Schema.Array(Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9][0-9]*$/)), Schema.check(Schema.isMaxLength(32))))
  .pipe(Schema.check(Schema.isMinLength(1)));

const rulingKeyFields = {
  /** The machine whose `command.queued` row this rules. */
  writer: InstallationId,
  opId: OpId,
  /** The command's actor, so the seat's machine can tell its seat without the command row. */
  actor: ResourceActor,
};

export const RulingAppliedResult = Schema.Struct({
  operation: Schema.Literal("ruling.applied"),
  ...rulingKeyFields,
  facts: RuledFactSeqs,
});
export type RulingAppliedResult = typeof RulingAppliedResult.Type;

export const RulingRefusedResult = Schema.Struct({
  operation: Schema.Literal("ruling.refused"),
  ...rulingKeyFields,
  error: WorkErrorBody,
  /** The command this refusal goes back to: itself, or the refused command its `after` reaches. */
  root: OpId,
});
export type RulingRefusedResult = typeof RulingRefusedResult.Type;

export type RulingResult = RulingAppliedResult | RulingRefusedResult;

/** The row a command becomes, from the envelope a domain built. */
export const commandQueuedBody = <Op extends typeof QueuedOp.Type>(command: ResourceCommand<Op>): CommandQueuedResult => ({
  operation: "command.queued",
  command,
});

/** Which ruling a ruling row is, by (writer installation, opId). */
export const rulingKeyOf = (ruling: RulingResult): CommandKey => commandKey(ruling.writer, ruling.opId);

/** Who may write a row of this kind for a canvas: a command row its actor's machine, a ruling only the editing machine. */
export type CommandRowWriter =
  | { readonly kind: "actor-machine" }
  | { readonly kind: "editing-machine" };

export const commandRowWriter = (
  body: CommandQueuedResult | RulingResult,
): CommandRowWriter => {
  switch (body.operation) {
    case "command.queued":
      return body.command.actor.kind === "seat" ? { kind: "actor-machine" } : { kind: "editing-machine" };
    case "ruling.applied":
    case "ruling.refused":
      return { kind: "editing-machine" };
  }
};

/**
 * Who receives a row of this kind. A command goes to the editing machine and
 * nowhere else, so pending commands are seen only where they were written
 * even when the editing machine passes every writer's rows on. A ruling goes
 * to every machine linked for the canvas.
 */
export const commandRowEntitled = (
  machine: InstallationId,
  editor: InstallationId,
  body: CommandQueuedResult | RulingResult,
): boolean => body.operation !== "command.queued" || machine === editor;

/** Unruled command rows one machine holds for one canvas. */
export type QueueLoad = { readonly rows: number; readonly bytes: number };

/**
 * May one more command row of `rowBytes` join a queue at `load`? The bound is
 * the only write refusal that has to do with the editing machine being away.
 */
export const queueAdmits = (load: QueueLoad, rowBytes: number): boolean =>
  load.rows + 1 <= QUEUE_MAX_ROWS && load.bytes + rowBytes <= QUEUE_MAX_BYTES;
