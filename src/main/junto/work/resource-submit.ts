/**
 * Where a seat's resource write goes (docs/plans/0.10/02-universal-resources.md,
 * "The CLI says which happened"). On the machine that edits the canvas the
 * domain rules it at once. On any other the command is queued as this
 * machine's own `command.queued` row; while a link to the editing machine is
 * open the write waits up to RULING_WAIT_MS for the ruling to come back, and
 * with none open it does not wait. It then answers applied, refused, or
 * queued with the opId; queued is a success, and `junto op show` reads it later.
 */
import { Context, Effect, Layer, Option, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CommandQueueFull, CommandTargetUnknown, type QueuedCommand, type RulingAppliedResult } from "@shared/command-row";
import type { InstallationId } from "@shared/installation-id";
import { RULING_WAIT_MS, afterOf, refusalError } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";
import { AutomationRepository } from "../automation/repository";
import { MachineRepository } from "../machines/repository";
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
      // Reading the queue and adding to it is one step: two writes from this machine never both see an empty chain.
      const enqueue = yield* Semaphore.make(1);

      const canvasRow = (canvasName: string) =>
        sql<{ editor: string | null; seq: number; self: string | null }>`
          SELECT editor_installation_id AS editor, seq,
            (SELECT installation_id FROM installation WHERE singleton = 1) AS self
          FROM canvases WHERE canvas_name = ${canvasName}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError((error) => storeFailed(error.message)),
        );

      // Where an automation runs, as this machine folded its rulings: the machine it names, by real short name.
      const automations = yield* Effect.serviceOption(AutomationRepository);
      const machines = yield* Effect.serviceOption(MachineRepository);
      const runsHere = (canvasName: string, actor: { readonly nodeId: string; readonly automationId: string }) =>
        Effect.gen(function* () {
          if (Option.isNone(automations) || Option.isNone(machines)) return false;
          const entry = (yield* automations.value.loadState(canvasName)).get(actor.automationId as never);
          if (entry === undefined || entry.archived || entry.automation.nodeId !== actor.nodeId) return false;
          // One that names no machine runs on the editing machine, which rules its writes and queues none.
          const machine = entry.automation.machine;
          return machine !== undefined && machine === (yield* machines.value.machineName);
        }).pipe(Effect.orElseSucceed(() => false));

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
          // A seat's command, and an automation's that runs here, is queued. The operator writes on
          // the machine that rules the canvas, which refuses its command rows from any other, and so
          // would it an automation's from a machine the automation is not on: none is written here.
          if (command.actor.kind === "operator" || (command.actor.kind === "automation" && !(yield* runsHere(command.canvasName, command.actor)))) {
            return yield* Effect.fail(
              refusalError({
                reason: "not_permitted",
                message: command.actor.kind === "operator"
                  ? "The operator writes on the machine that edits the canvas"
                  : "An automation writes on the machine it runs on",
              }),
            );
          }
          const row = yield* canvasRow(command.canvasName);
          if (row === undefined || row.self === null) return yield* Effect.fail(storeFailed("this machine has no installation id yet"));
          const self = row.self as InstallationId;
          yield* Effect.gen(function* () {
            // A command builds on this machine's unruled commands on the same item, so a refused
            // one refuses it too (depends_on_refused) instead of it applying on another's write.
            const unruled = yield* work.unruledCommands(command.canvasName).pipe(Effect.mapError((error) => storeFailed(error.message)));
            const pending = unruled.filter((held) => held.writer === self).map((held) => held.command);
            const after = [...new Set([...command.after, ...afterOf(pending, command.target)])];
            yield* work
              .queueCommand({ command: { ...command, after }, basis: { kind: "canvas", canvasName: command.canvasName, seq: row.seq } as never })
              .pipe(Effect.mapError(queueRefusal));
          }).pipe(enqueue.withPermits(1));
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
