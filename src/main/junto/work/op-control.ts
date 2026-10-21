/**
 * `op.show` and `op.list` on the work plane: a seat reads what became of its
 * own resource writes, by opId (plan 02). Seat-local, like signal list: no
 * target, no edge, and never another seat's writes.
 */
import { Effect, Option, Result, Schema } from "effect";
import {
  OP_LIST_MAX,
  OpListArgs,
  OpShowArgs,
  pendingMarks,
  unknownOpError,
  type OpListResult,
  type OpOverlay,
  type OpView,
  type PendingMark,
} from "@shared/op-control";
import type { QueuedCommand } from "@shared/command-row";
import type { Canvas } from "@shared/model";
import type { ItemId, PendingEntry } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import type { NodeId } from "@shared/physics/schema";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";
import { ArtifactRepository } from "./artifact-repository";
import { OpRepository } from "./op-repository";
import { queuedArtifactCommands, queuedTaskCommands } from "./queued-commands";
import { taskCanvasEnv } from "./task-control";
import { TaskRepository } from "./task-repository";

export const OP_OPS = ["op.show", "op.list"] as const;
export type OpOp = (typeof OP_OPS)[number];
export const isOpOp = (op: string): op is OpOp => (OP_OPS as ReadonlyArray<string>).includes(op);

/** What `op list` shows when no limit is asked for. */
export const OP_LIST_DEFAULT = 50;

const decode = <S extends Schema.Top>(schema: S, args: unknown): Effect.Effect<S["Type"], WorkErrorBody> => {
  const decoded = Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(args ?? {});
  return Result.isFailure(decoded)
    ? Effect.fail({
        type: "InputError",
        message: String((decoded.failure as { readonly message?: unknown }).message ?? decoded.failure),
        details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
      })
    : Effect.succeed(decoded.success as S["Type"]);
};

const unreadable = (message: string): WorkErrorBody => ({
  type: "InternalError",
  message: `this seat's writes could not be read: ${message}`,
  details: { retryable: true },
});

/** This machine's unruled queue, in queue order, with the overlay of each write that has one. */
export type QueuedOverlays = {
  readonly commands: ReadonlyArray<QueuedCommand>;
  readonly overlays: ReadonlyMap<OpId, OpOverlay>;
};

/**
 * What this machine reads of each queued write over its ruled state
 * (read-your-writes, 02), for the domains with an overlay reader: tasks and
 * artifacts.
 * The whole queue of this machine is replayed, every seat's, in queue order,
 * since an earlier command changes what a later one meets. `op show`, `op
 * list` and the window's pending writes (resource-ipc.ts) all read this one
 * computation. Undefined when this machine holds no queue for the canvas.
 */
export const queuedOverlays = (
  canvasName: string,
  canvas: Canvas,
): Effect.Effect<QueuedOverlays | undefined, WorkErrorBody, OpRepository> =>
  Effect.gen(function* () {
    const queue = yield* (yield* OpRepository).unruled(canvasName).pipe(Effect.mapError((error) => unreadable(error.message)));
    if (queue === undefined) return undefined;
    // Reach as the ruler judges it: a command out of its actor's reach is
    // refused in the replay, so it changes nothing the caller reads.
    const context = rulingContextOf(canvas, () => undefined);
    const entries: Array<PendingEntry> = [];
    const artifacts = yield* Effect.serviceOption(ArtifactRepository);
    if (Option.isSome(artifacts)) {
      entries.push(...yield* artifacts.value.overlay(canvasName, queue.writer, queuedArtifactCommands(queue.commands), context)
        .pipe(Effect.mapError((error) => unreadable(error.message))));
    }
    const tasks = yield* Effect.serviceOption(TaskRepository);
    if (Option.isSome(tasks)) {
      // Narrowed and ruled as the editing machine's ruler does, on this machine's canvas.
      const commands = queuedTaskCommands(queue.commands, (id) => canvas.nodes.get(id)?.kind);
      entries.push(...yield* tasks.value.overlay(canvasName, queue.writer, commands, context, taskCanvasEnv(canvas))
        .pipe(Effect.mapError((error) => unreadable(error.message))));
    }
    return { commands: queue.commands, overlays: new Map(entries.map(({ opId, ...overlay }) => [opId, overlay as OpOverlay])) };
  });

/**
 * The mark of each item of `kind` this machine's queued writes touch, for
 * `task list|show` and `artifact list|show`. None in a build without the
 * record of resource writes, or on the machine that edits the canvas, which
 * queues nothing.
 */
export const pendingMarksOf = (kind: "task" | "artifact") =>
  (canvasName: string, canvas: Canvas): Effect.Effect<ReadonlyMap<ItemId, PendingMark>, WorkErrorBody> =>
    Effect.flatMap(Effect.serviceOption(OpRepository), (repository) =>
      Option.isNone(repository)
        ? Effect.succeed(new Map())
        : queuedOverlays(canvasName, canvas).pipe(
          Effect.provideService(OpRepository, repository.value),
          Effect.map((queued) => (queued === undefined ? new Map() : pendingMarks(queued.commands, queued.overlays, kind))),
        ));

/** Each queued view with its overlay, from `queuedOverlays`. */
const withOverlay = (
  canvasName: string,
  canvas: Canvas,
  views: ReadonlyArray<OpView>,
): Effect.Effect<ReadonlyArray<OpView>, WorkErrorBody, OpRepository> =>
  Effect.gen(function* () {
    if (!views.some((view) => view.state === "queued")) return views;
    const queued = yield* queuedOverlays(canvasName, canvas);
    if (queued === undefined) return views;
    return views.map((view) => {
      const overlay = view.state === "queued" ? queued.overlays.get(view.opId) : undefined;
      return overlay === undefined ? view : { ...view, overlay };
    });
  });

export const handleOpOp = (
  op: OpOp,
  args: unknown,
  caller: { readonly canvasName: string; readonly nodeId: NodeId; readonly canvas: Canvas },
): Effect.Effect<{ readonly op: OpView } | OpListResult, WorkErrorBody> =>
  Effect.gen(function* () {
    const repository = yield* Effect.serviceOption(OpRepository);
    if (Option.isNone(repository)) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: "the record of resource writes is not built in this Junto build yet",
        details: { reason: "not_available", retryable: false },
      });
    }
    const scope = { canvasName: caller.canvasName, seat: caller.nodeId };
    switch (op) {
      case "op.show": {
        const { opId } = yield* decode(OpShowArgs, args);
        const view = yield* repository.value.show(scope, opId).pipe(Effect.mapError((error) => unreadable(error.message)));
        if (view === undefined) return yield* Effect.fail(unknownOpError(opId));
        const [shown] = yield* withOverlay(caller.canvasName, caller.canvas, [view]).pipe(Effect.provideService(OpRepository, repository.value));
        return { op: shown ?? view };
      }
      case "op.list": {
        const input = yield* decode(OpListArgs, args);
        const listed = yield* repository.value
          .list(scope, {
            ...(input.state === undefined ? {} : { state: input.state }),
            ...(input.before === undefined ? {} : { before: input.before }),
            limit: Math.min(input.limit ?? OP_LIST_DEFAULT, OP_LIST_MAX),
          })
          .pipe(Effect.mapError((error) => unreadable(error.message)));
        const ops = yield* withOverlay(caller.canvasName, caller.canvas, listed.ops).pipe(Effect.provideService(OpRepository, repository.value));
        return { ...listed, ops };
      }
    }
  });
