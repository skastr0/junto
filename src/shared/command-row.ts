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
  RefusalReason,
  ResourceActor,
  ResourceKind,
  type CommandKey,
  type ResourceCommand,
  commandKey,
  refusalError,
  resourceCommandSchema,
} from "./resource-command";
import type { WorkErrorBody } from "./work-control";
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

/**
 * The facts a ruling applied, as its domain wrote them. Like the op, the
 * transport does not know the domains: every machine folds them through the
 * projection of the domain `kind` names, which decodes them with its closed
 * fact schema. They travel in the ruling's own row, so every fact carries its
 * opId and is written in the ruling's transaction.
 */
const RuledFacts = Schema.Array(Schema.Json).pipe(Schema.check(Schema.isMinLength(1)));

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
  kind: ResourceKind,
  facts: RuledFacts,
});
export type RulingAppliedResult = typeof RulingAppliedResult.Type;

/**
 * A refusal as every machine receives it: the closed reason and, when the
 * reason has one, the head it lost to. Never the command's op, its text or a
 * content ref: those stay with the writer, which holds the command row
 * (security doctrine draft D3).
 */
export const RulingRefusedResult = Schema.Struct({
  operation: Schema.Literal("ruling.refused"),
  ...rulingKeyFields,
  reason: RefusalReason,
  /** The version, epoch or head the command lost to: a token, never words. */
  expected: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)))),
  /** The command this refusal goes back to: itself, or the refused command its `after` reaches. */
  root: OpId,
});
export type RulingRefusedResult = typeof RulingRefusedResult.Type;

export type RulingResult = RulingAppliedResult | RulingRefusedResult;

/** Fixed words per reason, so a refusal row carries no text a seat or a domain wrote. */
const REFUSAL_WORDS: { readonly [R in RefusalReason]: string } = {
  not_in_reach: "The resource is not in this actor's reach",
  unknown_target: "The resource does not exist",
  invalid_input: "The command is not one this resource takes",
  invalid_transition: "The resource is not in a state that allows this",
  already_held: "Another command was ruled first",
  reviewer_is_author: "The author cannot review its own work",
  stale: "Written against an old version",
  rebase_conflict: "The change does not apply to the current version",
  depends_on_refused: "This builds on a command that was refused",
  not_available: "This is not available yet",
  queue_full: "This machine holds too many unruled commands",
};

/** The error a refusal row stands for, rebuilt from its closed fields. */
export const refusalErrorOf = (ruling: RulingRefusedResult): WorkErrorBody => {
  const body = refusalError(
    {
      reason: ruling.reason,
      message: REFUSAL_WORDS[ruling.reason],
      ...(ruling.expected === undefined ? {} : { expected: ruling.expected }),
      ...(ruling.root === ruling.opId ? {} : { next_step: `junto op show ${ruling.root}` }),
    },
    ruling.root === ruling.opId ? undefined : ruling.root,
  );
  return { ...body, details: { ...body.details, opId: ruling.opId } };
};

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

export type CommandRowBody = CommandQueuedResult | RulingResult;

export const isCommandRowBody = (body: { readonly operation: string }): body is CommandRowBody =>
  body.operation === "command.queued" || body.operation === "ruling.applied" || body.operation === "ruling.refused";

/**
 * Was this row written by a machine that may write it? A ruling, and a
 * command of the operator or an automation, only by the machine that edits
 * the canvas (02 condition 4, Rule 4). A seat's command is judged on where
 * its seat was, as mail is, by the author check. A row that fails closes the
 * link.
 */
export const commandRowWrittenBy = (
  writer: InstallationId,
  editor: InstallationId,
  body: CommandRowBody,
): boolean => commandRowWriter(body).kind === "actor-machine" || writer === editor;

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
