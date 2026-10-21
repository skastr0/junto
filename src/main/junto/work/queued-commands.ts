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
import type { ResourceCommand } from "@shared/resource-command";
import { checkTaskCommand, TaskCommandWire, type TaskCommand } from "@shared/task-model";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { OpRepository } from "./op-repository";

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
