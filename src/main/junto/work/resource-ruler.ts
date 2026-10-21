/**
 * The editing machine's ruler (docs/plans/0.10/02-universal-resources.md,
 * "Model"). Every command a seat's machine queued for a canvas this machine
 * edits is ruled here, once, by the domain its target names, and the ruling
 * goes back to every machine through RulingRecorder.
 *
 * The held rows are the source of truth, not their arrival: a sweep reads
 * every held command no ruling answers yet, each writer's in its seq order.
 * Arrival only wakes a sweep; boot sweeps every canvas this machine edits,
 * and a machine that comes to edit a canvas sweeps it, so a crash between a
 * commit and its wake-up, or a change of editor, loses no command.
 *
 * A ruling is final, so only what can never apply is refused here: a target
 * that names no node of its kind, an op its domain cannot decode, or a
 * command built on a refused one. A command whose domain has no ruler in this
 * build, or whose `after` names a command not ruled yet, stays queued.
 */
import { Context, Effect, Layer, Option, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ArtifactOp } from "@shared/artifact";
import { TARGET_NODE_KINDS, type OpState, type QueuedCommand } from "@shared/command-row";
import type { InstallationId } from "@shared/installation-id";
import type { Canvas } from "@shared/model";
import { refusalError, type Refusal, type ResourceKind } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import { taskRefusalMessage } from "@shared/task-machine";
import { TaskCommandWire, checkTaskCommand } from "@shared/task-model";
import type { OpId } from "@shared/work-ids";
import { ModelService } from "../model/service";
import { ArtifactRepository } from "./artifact-repository";
import { WorkRepository, type RecordRulingInput, type UnruledCommand } from "./repository";
import { RulingRecorder } from "./ruling-recorder";
import { taskCanvasEnv } from "./task-control";
import { noteResourceChanged } from "./resource-changes";
import { deliverTaskEffects } from "./task-delivery";
import { TaskRepository } from "./task-repository";

export class ResourceRulerError extends Schema.TaggedError<ResourceRulerError>()("ResourceRulerError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

/** What a domain made of one command: ruled (and recorded by the domain), or refused before it could rule. */
export type DomainVerdict = { readonly kind: "ruled" } | { readonly kind: "refuse"; readonly refusal: Refusal };

/** One domain's ruler: decode the op, rule it on the canvas, record the ruling. */
export type DomainRuler = (
  writer: InstallationId,
  command: QueuedCommand,
  canvas: Canvas,
) => Effect.Effect<DomainVerdict, ResourceRulerError>;

/** What the ruler needs from the rest of main. */
export type RulerPorts = {
  /** Canvases this machine holds. */
  readonly canvases: Effect.Effect<ReadonlyArray<string>, ResourceRulerError>;
  /** The canvas as this machine holds it, or undefined when this machine does not edit it. */
  readonly editedCanvas: (canvasName: string) => Effect.Effect<Canvas | undefined, ResourceRulerError>;
  readonly unruled: (canvasName: string) => Effect.Effect<ReadonlyArray<UnruledCommand>, ResourceRulerError>;
  readonly state: (canvasName: string, writer: InstallationId, opId: OpId) => Effect.Effect<OpState, ResourceRulerError>;
  /** Record a refusal made before any domain ruled. */
  readonly record: (input: RecordRulingInput) => Effect.Effect<void, ResourceRulerError>;
  /** The domains this build rules. A kind left out stays queued. */
  readonly domains: { readonly [K in ResourceKind]?: DomainRuler };
};

export class ResourceRuler extends Context.Service<
  ResourceRuler,
  {
    /** Rule every held, unruled command of one canvas this machine edits. */
    readonly sweep: (canvasName: string) => Effect.Effect<void, ResourceRulerError>;
    /** Sweep every canvas this machine edits: at boot. */
    readonly sweepAll: Effect.Effect<void, ResourceRulerError>;
  }
>()("@junto/ResourceRuler") {}

const refused = (
  canvasName: string,
  writer: InstallationId,
  command: QueuedCommand,
  refusal: Refusal,
  root: OpId,
): RecordRulingInput => {
  const error = refusalError(refusal, root === command.opId ? undefined : root);
  return {
    canvasName,
    writer,
    command,
    kind: command.target.kind,
    record: { kind: "refused", error, root },
    ruling: { kind: "refused", opId: command.opId, error, root },
  };
};

/** What blocks a command's `after`: a refused root refuses it, an unruled one makes it wait. */
const afterOf = (
  ports: RulerPorts,
  canvasName: string,
  writer: InstallationId,
  command: QueuedCommand,
): Effect.Effect<{ readonly kind: "clear" } | { readonly kind: "wait" } | { readonly kind: "refused"; readonly earlier: OpId; readonly root: OpId }, ResourceRulerError> =>
  Effect.gen(function* () {
    for (const earlier of command.after) {
      const state = yield* ports.state(canvasName, writer, earlier);
      if (state.kind === "refused") return { kind: "refused", earlier, root: state.ruling.root } as const;
      if (state.kind !== "applied") return { kind: "wait" } as const;
    }
    return { kind: "clear" } as const;
  });

export const makeResourceRuler = (ports: RulerPorts) =>
  Effect.gen(function* () {
    // One ruling at a time on this machine: the order commands are ruled in is the order (first ruled wins).
    const turn = yield* Semaphore.make(1);

    const sweepOnce = (canvasName: string) =>
      Effect.gen(function* () {
        const canvas = yield* ports.editedCanvas(canvasName);
        if (canvas === undefined) return;
        for (const { writer, command } of yield* ports.unruled(canvasName)) {
          const node = canvas.nodes.get(command.target.nodeId as never);
          if (node === undefined || !TARGET_NODE_KINDS[command.target.kind].includes(node.kind)) {
            yield* ports.record(
              refused(canvasName, writer, command, {
                reason: "unknown_target",
                message: `No ${command.target.kind} node ${command.target.nodeId} on this canvas`,
              }, command.opId),
            );
            continue;
          }
          const after = yield* afterOf(ports, canvasName, writer, command);
          if (after.kind === "wait") continue;
          if (after.kind === "refused") {
            yield* ports.record(
              refused(canvasName, writer, command, {
                reason: "depends_on_refused",
                message: `This builds on ${after.earlier}, which was refused`,
                next_step: `Read the refusal of ${after.root} with junto op show ${after.root}`,
              }, after.root),
            );
            continue;
          }
          const domain = ports.domains[command.target.kind];
          if (domain === undefined) continue;
          const verdict = yield* domain(writer, command, canvas);
          if (verdict.kind === "refuse") yield* ports.record(refused(canvasName, writer, command, verdict.refusal, command.opId));
        }
      });

    const sweep = (canvasName: string) => turn.withPermits(1)(sweepOnce(canvasName));

    return ResourceRuler.of({
      sweep,
      sweepAll: Effect.flatMap(ports.canvases, (names) => Effect.forEach(names, sweep, { discard: true })),
    });
  });

// ---------------------------------------------------------------------------
// The domains this build rules

const failed = (message: string) => (cause: unknown) => new ResourceRulerError({ message, cause });

/** No automation writes through the exchange: an arriving command from another machine has no author here. */
const noAutomationAuthor = () => undefined;

const decodeTaskOp = Schema.decodeUnknownResult(TaskCommandWire, { onExcessProperty: "error" });
const decodeArtifactOp = Schema.decodeUnknownResult(ArtifactOp, { onExcessProperty: "error" });

const undecodable = (kind: ResourceKind): DomainVerdict => ({
  kind: "refuse",
  refusal: { reason: "invalid_input", message: `The ${kind} op does not decode` },
});

export const taskRuler = (repo: TaskRepository["Service"]): DomainRuler => (writer, command, canvas) =>
  Effect.gen(function* () {
    const wire = decodeTaskOp(command.op);
    if (Result.isFailure(wire)) return undecodable("task");
    const checked = checkTaskCommand(wire.success, (id) => canvas.nodes.get(id)?.kind);
    if (!checked.ok) {
      return { kind: "refuse", refusal: { reason: checked.refusal.reason, message: taskRefusalMessage(checked.refusal.detail) } } as const;
    }
    const outcome = yield* repo
      .submit(writer, { ...command, op: checked.command }, rulingContextOf(canvas, noAutomationAuthor), taskCanvasEnv(canvas))
      .pipe(Effect.mapError(failed("the task ruler could not rule")));
    if (outcome.kind === "applied" && !outcome.replay) {
      // Committed: the panes on this machine read the task again.
      noteResourceChanged("task", command.canvasName);
      yield* deliverTaskEffects({
        canvas,
        canvasName: command.canvasName,
        actor: command.actor,
        opId: command.opId,
        task: outcome.task,
        effects: outcome.effects,
      }).pipe(
        // The ruling is committed: a lost notice never turns it into a retry.
        Effect.catch((error) => Effect.logWarning("task notices were not delivered", { opId: command.opId, error })),
      );
    }
    return { kind: "ruled" } as const;
  });

export const artifactRuler = (repo: ArtifactRepository["Service"]): DomainRuler => (writer, command, canvas) =>
  Effect.gen(function* () {
    const op = decodeArtifactOp(command.op);
    if (Result.isFailure(op)) return undecodable("artifact");
    const outcome = yield* repo
      .submit(writer, { ...command, op: op.success }, rulingContextOf(canvas, noAutomationAuthor))
      .pipe(Effect.mapError(failed("the artifact ruler could not rule")));
    // Committed: the panes on this machine read the artifacts again.
    if (outcome.kind === "applied" && outcome.facts.length > 0) noteResourceChanged("artifact", command.canvasName);
    return { kind: "ruled" } as const;
  });

/** The ruler over the running core: tasks once their store runs here, artifacts now. */
export const ResourceRulerLive: Layer.Layer<
  ResourceRuler,
  never,
  SqlClient.SqlClient | WorkRepository | RulingRecorder | ModelService | ArtifactRepository
> = Layer.effect(
  ResourceRuler,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const work = yield* WorkRepository;
    const recorder = yield* RulingRecorder;
    const model = yield* ModelService;
    const artifacts = yield* ArtifactRepository;
    const tasks = yield* Effect.serviceOption(TaskRepository);
    const edits = (canvasName: string) =>
      Effect.map(
        sql<{ edits: number }>`
          SELECT editor_installation_id IS NULL
            OR editor_installation_id = (SELECT installation_id FROM installation WHERE singleton = 1) AS edits
          FROM canvases WHERE canvas_name = ${canvasName}`,
        (rows) => rows[0]?.edits === 1,
      );
    return yield* makeResourceRuler({
      canvases: model.listCanvases().pipe(Effect.mapError(failed("the canvases could not be listed"))),
      editedCanvas: (canvasName) =>
        Effect.gen(function* () {
          if (!(yield* edits(canvasName))) return undefined;
          return yield* model.canvas(canvasName);
        }).pipe(Effect.mapError(failed(`canvas ${canvasName} could not be read`))),
      unruled: (canvasName) => work.unruledCommands(canvasName).pipe(Effect.mapError(failed("held commands could not be read"))),
      state: (canvasName, writer, opId) =>
        work.commandState(canvasName, writer, opId).pipe(Effect.mapError(failed("a command's state could not be read"))),
      record: (input) => recorder.record(input).pipe(Effect.mapError(failed("a refusal could not be recorded"))),
      domains: {
        artifact: artifactRuler(artifacts),
        ...(Option.isSome(tasks) ? { task: taskRuler(tasks.value) } : {}),
      },
    });
  }),
);
