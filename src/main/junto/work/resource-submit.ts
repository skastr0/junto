/**
 * Where a seat's resource write goes (docs/plans/0.10/02-universal-resources.md,
 * "The CLI says which happened"). On the machine that edits the canvas the
 * domain rules it at once. On any other the command is queued as this
 * machine's own `command.queued` row; while a link to the editing machine is
 * open the write waits up to RULING_WAIT_MS for the ruling to come back, and
 * with none open it does not wait. It then answers applied, refused, or
 * queued with the opId; queued is a success, and `junto op show` reads it later.
 */
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CommandQueueFull, CommandTargetUnknown, type QueuedCommand, type RulingAppliedResult } from "@shared/command-row";
import type { InstallationId } from "@shared/installation-id";
import { RULING_WAIT_MS, refusalError } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";
import { WorkRepository } from "./repository";

/** Whether a canvas's commands are ruled here, or queued for the machine that edits it. */
export type SubmitRoute = { readonly kind: "here" } | { readonly kind: "editor"; readonly editor: InstallationId };

/** What became of a queued command by the time the write answers. */
export type QueuedOutcome =
  | { readonly kind: "queued" }
  | { readonly kind: "applied"; readonly ruling: RulingAppliedResult }
  | { readonly kind: "refused"; readonly error: WorkErrorBody; readonly root: OpId };

export class ResourceSubmit extends Context.Service<
  ResourceSubmit,
  {
    readonly route: (canvasName: string) => Effect.Effect<SubmitRoute, WorkErrorBody>;
    /** Queue a command for the editing machine, then wait for its ruling while linked to it. */
    readonly queue: (command: QueuedCommand, editor: InstallationId) => Effect.Effect<QueuedOutcome, WorkErrorBody>;
  }
>()("@junto/ResourceSubmit") {}

/** How often a waiting write looks for its ruling. */
const RULING_POLL_MS = 25;

const storeFailed = (message: string): WorkErrorBody => ({ type: "InternalError", message, details: { retryable: true } });

/** A queue that cannot take the command answers at once, in the ruler's words. */
const queueRefusal = (error: CommandQueueFull | CommandTargetUnknown | { readonly message: string }): WorkErrorBody => {
  if (error instanceof CommandQueueFull) {
    return refusalError({
      reason: "queue_full",
      message: `This machine holds ${error.rows} unruled commands for the canvas; wait for the editing machine to rule them`,
    });
  }
  if (error instanceof CommandTargetUnknown) {
    return refusalError({ reason: "unknown_target", message: `No ${error.kind} node ${error.nodeId} on this canvas` });
  }
  return storeFailed(error.message);
};

/** The submit path over the work store; `linked` says whether a link to a machine is open now. */
export const makeResourceSubmitLayer = (
  linked: (peer: InstallationId) => boolean,
): Layer.Layer<ResourceSubmit, never, SqlClient.SqlClient | WorkRepository> =>
  Layer.effect(
    ResourceSubmit,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const work = yield* WorkRepository;

      const canvasRow = (canvasName: string) =>
        sql<{ editor: string | null; seq: number; self: string | null }>`
          SELECT editor_installation_id AS editor, seq,
            (SELECT installation_id FROM installation WHERE singleton = 1) AS self
          FROM canvases WHERE canvas_name = ${canvasName}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError((error) => storeFailed(error.message)),
        );

      const route = (canvasName: string) =>
        Effect.flatMap(canvasRow(canvasName), (row): Effect.Effect<SubmitRoute, WorkErrorBody> => {
          if (row === undefined) {
            return Effect.fail({ type: "UnknownTarget", message: `no canvas ${canvasName} on this machine`, details: { retryable: false } });
          }
          // No editor named is this machine's own canvas, as the model reads it.
          return Effect.succeed(
            row.editor === null || row.editor === row.self ? { kind: "here" } : { kind: "editor", editor: row.editor as InstallationId },
          );
        });

      const queue = (command: QueuedCommand, editor: InstallationId) =>
        Effect.gen(function* () {
          // Only a seat's command is queued: the operator and automations write on the editing machine,
          // and that machine refuses their command rows from any other, so none is ever written here.
          if (command.actor.kind !== "seat") {
            return yield* Effect.fail(
              refusalError({ reason: "not_permitted", message: "The operator and automations write on the machine that edits the canvas" }),
            );
          }
          const row = yield* canvasRow(command.canvasName);
          if (row === undefined || row.self === null) return yield* Effect.fail(storeFailed("this machine has no installation id yet"));
          const self = row.self as InstallationId;
          yield* work
            .queueCommand({ command, basis: { kind: "canvas", canvasName: command.canvasName, seq: row.seq } as never })
            .pipe(Effect.mapError(queueRefusal));
          const deadline = Date.now() + RULING_WAIT_MS;
          while (linked(editor) && Date.now() < deadline) {
            const state = yield* work.commandState(command.canvasName, self, command.opId).pipe(Effect.mapError((error) => storeFailed(error.message)));
            if (state.kind === "applied") return { kind: "applied", ruling: state.ruling } as const;
            if (state.kind === "refused") return { kind: "refused", error: state.error, root: state.ruling.root } as const;
            yield* Effect.sleep(RULING_POLL_MS);
          }
          return { kind: "queued" } as const;
        });

      return ResourceSubmit.of({ route, queue });
    }),
  );
