/**
 * This machine's unruled queue for a canvas, decoded per domain: what the
 * writer's check before it queues (`precheck`) and its overlay (`overlay`)
 * replay over the ruled state held here (02). A row that does not decode is
 * left out: the editing machine refuses it, and nothing here builds on it.
 */
import { Effect, Option, Result, Schema } from "effect";
import { ArtifactOp } from "@shared/artifact";
import type { QueuedCommand } from "@shared/command-row";
import type { InstallationId } from "@shared/installation-id";
import { afterOf, commandKey, type CommandKey, type RefusedRuling, type ResourceCommand } from "@shared/resource-command";
import { checkTaskCommand, TaskCommandWire, type TaskCommand } from "@shared/task-model";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import type { OpId } from "@shared/work-ids";
import { OpRepository } from "./op-repository";
import { WorkRepository } from "./repository";

export type LocalQueue = { readonly writer: InstallationId; readonly commands: ReadonlyArray<QueuedCommand> };

/**
 * The queue a check before queueing reads. A build without the record of
 * resource writes, or a queue that cannot be read now, reads as none: the
 * check then refuses nothing, and the write queues as it did before it.
 */
export const localQueue = (canvasName: string): Effect.Effect<LocalQueue | undefined> =>
  Effect.flatMap(Effect.serviceOption(OpRepository), (repository) =>
    Option.isNone(repository)
      ? Effect.succeed(undefined)
      : repository.value.unruled(canvasName).pipe(Effect.orElseSucceed(() => undefined)));

const decodeTaskOp = Schema.decodeUnknownResult(TaskCommandWire, { onExcessProperty: "error" });
const decodeArtifactOp = Schema.decodeUnknownResult(ArtifactOp);

/**
 * The queue's task commands, narrowed as the ruler narrows them. `kindOf`
 * absent, node kinds are left unchecked: a wrong kind is refused `wrong-node`,
 * which is never definite, so a check before queueing loses nothing by it.
 */
export const queuedTaskCommands = (
  commands: ReadonlyArray<QueuedCommand>,
  kindOf?: (id: NodeId) => NodeKind | undefined,
): ReadonlyArray<ResourceCommand<TaskCommand>> =>
  commands.flatMap((command): ReadonlyArray<ResourceCommand<TaskCommand>> => {
    if (command.target.kind !== "task") return [];
    const wire = decodeTaskOp(command.op);
    if (Result.isFailure(wire)) return [];
    if (kindOf === undefined) return [{ ...command, op: wire.success as TaskCommand }];
    const checked = checkTaskCommand(wire.success, kindOf);
    return checked.ok ? [{ ...command, op: checked.command }] : [];
  });

export const queuedArtifactCommands = (commands: ReadonlyArray<QueuedCommand>): ReadonlyArray<ResourceCommand<ArtifactOp>> =>
  commands.flatMap((command): ReadonlyArray<ResourceCommand<ArtifactOp>> => {
    if (command.target.kind !== "artifact") return [];
    const op = decodeArtifactOp(command.op);
    return Result.isSuccess(op) ? [{ ...command, op: op.success }] : [];
  });

/** What a check before queueing rules on, besides the ruled state its store holds. */
export type PrecheckInput<Op> = {
  readonly writer: InstallationId;
  /** This writer's unruled commands of the domain, in queue order. */
  readonly queued: ReadonlyArray<ResourceCommand<Op>>;
  /** The command with the `after` the queue will give it. */
  readonly command: ResourceCommand<Op>;
  /** The writer's refused rulings held here that any of their `after` names. */
  readonly refused: ReadonlyMap<CommandKey, RefusedRuling>;
};

/**
 * The input of a check before queueing, from the rows this machine holds.
 * A machine that does not edit the canvas holds its rulings as ruling rows
 * of the work store, not in `resource_rulings`, so each is read as the queue
 * reads it (`commandState`). Undefined, and nothing is checked, when the
 * command was written before (queued, or ruled: the queue answers the resend
 * from its ruling) or when those rows cannot be read now.
 */
export const precheckInput = <Op>(
  command: ResourceCommand<Op>,
  decode: (commands: ReadonlyArray<QueuedCommand>) => ReadonlyArray<ResourceCommand<Op>>,
): Effect.Effect<PrecheckInput<Op> | undefined> =>
  Effect.gen(function* () {
    const work = yield* Effect.serviceOption(WorkRepository);
    const queue = yield* localQueue(command.canvasName);
    if (Option.isNone(work) || queue === undefined) return undefined;
    const stateOf = (opId: OpId) => work.value.commandState(command.canvasName, queue.writer, opId);
    if ((yield* stateOf(command.opId)).kind !== "unknown") return undefined;
    const queued = decode(queue.commands);
    // As the queue builds it (resource-submit.ts): on this writer's unruled commands on the same item.
    const after = [...new Set([...command.after, ...afterOf(queued, command.target)])];
    const named = new Set([...after, ...queued.flatMap((earlier) => earlier.after)]);
    const refused = new Map<CommandKey, RefusedRuling>();
    for (const opId of named) {
      const state = yield* stateOf(opId);
      if (state.kind === "refused") {
        refused.set(commandKey(queue.writer, opId), { kind: "refused", opId, error: state.error, root: state.ruling.root as OpId });
      }
    }
    return { writer: queue.writer, queued, command: { ...command, after }, refused };
  }).pipe(Effect.orElseSucceed(() => undefined));
