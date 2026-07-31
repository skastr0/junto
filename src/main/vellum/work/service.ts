// WorkService — one repository-native orchestration seam for the SQLite work
// plane. Canvas documents are read-only topology plus runtime projections;
// every durable mutation goes through a specific WorkRepository verb.

import { Context, Effect, Either, Layer, Match, Schema } from "effect";
import type {
  Artifact,
  CanvasDoc,
  CanvasNode,
  Message,
  Part,
  Task,
  TaskState,
  WorkMetadata,
} from "@shared/canvas";
import type {
  CompletionEvidence,
  FinishCriteria,
  TaskProposal,
} from "@shared/work-model";
import type {
  CanvasReadResult,
  WorkOpResult,
} from "@shared/ipc";
import type {
  InstallationId as InstallationIdValue,
} from "@shared/installation-id";
import type {
  StationConfiguration as StationConfigurationValue,
} from "@shared/station-api";
import { resolveNodeHostId } from "@shared/station";
import { resolveSpec } from "@shared/physics";
import {
  WorkError,
  workArtifactPublish,
  workMessageAppend,
  workRequestCreate,
  workRequestResolve,
  workTaskCreate,
  workTaskApproveProposal,
  workTaskDescribe,
  workTaskPropose,
  workTaskRespond,
  workTaskTransition,
  type WorkIds,
} from "@shared/work";
import { taskIndexById, taskIsClaimReady } from "@shared/task-deps";
import type {
  ActorRef,
  IntentFactBasis as IntentFactBasisValue,
  WorkAction as WorkActionValue,
  WorkItemRef,
} from "@shared/work-protocol";
import { IntentFactBasis } from "@shared/work-protocol";
import { ulid } from "ulid";
import {
  CanvasesService,
  CanvasError,
} from "../canvases";
import {
  StationFleetTargetRepository,
} from "../station/fleet-target-repository";
import { StationRepository } from "../station/repository";
import {
  StationLivePeerRegistry,
} from "../station/session-registry";
import { admitWorkTarget } from "./authz";
import { clearSeatBlockedByRequest } from "./blocked-seat";
import { mailboxMessageReadId } from "./mailbox-receipts";
import { messageDelivery } from "./message-delivery";
import {
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryError,
  type PendingCommand,
} from "./repository";

export class WorkServiceError extends Schema.TaggedError<WorkServiceError>()(
  "WorkServiceError",
  {
    code: Schema.Literal(
      "canvas_not_found",
      "node_not_found",
      "task_not_found",
      "illegal_kind",
      "illegal_transition",
      "claim_contention",
      "invalid",
    ),
    message: Schema.String,
  },
) {}

export type { WorkOpResult };

export type WorkCommandStatus = {
  readonly counts: {
    readonly pending: number;
    readonly applied: number;
    readonly rejected: number;
  };
  readonly pending: ReadonlyArray<PendingCommand>;
  readonly rejections: ReadonlyArray<PendingCommand>;
  readonly truncated: {
    readonly pending: boolean;
    readonly rejections: boolean;
  };
};

const COMMAND_STATUS_DETAIL_LIMIT = 100;

const defaultIds = (): WorkIds => ({
  id: () => ulid(),
  messageId: () => ulid(),
});

const toWorkServiceError = (error: unknown): WorkServiceError => {
  if (error instanceof WorkServiceError) return error;
  if (error instanceof WorkError) {
    return new WorkServiceError({
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof WorkAuthorityError) {
    const code = (() => {
      switch (error.reason) {
        case "missing-entity":
          return "task_not_found" as const;
        case "invalid-transition":
          return "illegal_transition" as const;
        case "claim-contention":
          return "claim_contention" as const;
        case "authority-mismatch":
        case "causal-conflict":
        case "identity-conflict":
        case "target-mismatch":
          return "invalid" as const;
      }
    })();
    return new WorkServiceError({ code, message: error.message });
  }
  if (error instanceof WorkRepositoryError) {
    return new WorkServiceError({
      code: "invalid",
      message: error.message,
    });
  }
  if (error instanceof CanvasError) {
    const message = error.message;
    return new WorkServiceError({
      code:
        message.includes("ENOENT") ||
        message.includes("no such file") ||
        message.includes("does not exist")
          ? "canvas_not_found"
          : "invalid",
      message,
    });
  }
  return new WorkServiceError({
    code: "invalid",
    message: error instanceof Error ? error.message : String(error),
  });
};

type WorkMutationOutcome<T> = {
  readonly value: T;
  readonly disposition: "applied" | "queued";
};

type WorkApplyOk<T> = WorkMutationOutcome<T> & {
  readonly doc: CanvasDoc;
  readonly revision: string;
};

const asResult = <T>(
  effect: Effect.Effect<WorkApplyOk<T>, WorkServiceError>,
): Effect.Effect<WorkOpResult<T>> =>
  effect.pipe(
    Effect.map(
      ({ value, doc, revision, disposition }): WorkOpResult<T> => ({
        ok: true,
        data: value,
        doc,
        revision,
        disposition,
      }),
    ),
    Effect.catchAll((error) =>
      Effect.succeed({
        ok: false as const,
        code: error.code,
        message: error.message,
      }),
    ),
  );

type StationContext = {
  readonly localInstallationId: InstallationIdValue;
  readonly configuration: StationConfigurationValue;
};

const sinkRef = (
  canvasName: string,
  nodeId: string,
): WorkItemRef["sink"] => ({ canvasName, nodeId });

const workItem = (
  kind: WorkItemRef["kind"],
  itemId: string,
  canvasName: string,
  nodeId: string,
): WorkItemRef => ({
  kind,
  itemId,
  sink: sinkRef(canvasName, nodeId),
});

const sameActor = (left: ActorRef, right: ActorRef): boolean =>
  left.seatId === right.seatId &&
  left.canvasName === right.canvasName &&
  left.nodeId === right.nodeId;

const nodeById = (
  doc: CanvasDoc,
  nodeId: string,
): CanvasNode | undefined =>
  doc.nodes.find((node) => node.id === nodeId);

export class WorkService extends Context.Tag("@vellum/WorkService")<
  WorkService,
  {
    /** Read the canonical single home of one task through the app-owned seam. */
    readonly workTaskHome: (
      canvas: string,
      nodeId: string,
      taskId: string,
    ) => Effect.Effect<InstallationIdValue, WorkServiceError>;
    readonly workTaskCreate: (
      canvas: string,
      nodeId: string,
      brief: string,
      metadata?: WorkMetadata,
      reason?: string,
      media?: ReadonlyArray<Part>,
      dependsOn?: ReadonlyArray<string>,
      finishCriteria?: FinishCriteria,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskPropose: (
      canvas: string,
      nodeId: string,
      brief: string,
      metadata: WorkMetadata | undefined,
      proposedBy: ActorRef,
      reason?: string,
    ) => Effect.Effect<WorkOpResult<TaskProposal>>;
    readonly workTaskApproveProposal: (
      canvas: string,
      nodeId: string,
      taskId: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskDescribe: (
      canvas: string,
      nodeId: string,
      taskId: string,
      brief: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskTransition: (
      canvas: string,
      nodeId: string,
      taskId: string,
      state: TaskState,
      note?: string,
      completionEvidence?: CompletionEvidence,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskRespond: (
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "working" | "rejected",
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskClaim: (
      canvas: string,
      nodeId: string,
      taskId: string,
      actor: ActorRef,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workMessageAppend: (
      canvas: string,
      nodeId: string,
      taskId: string | null,
      message: Message,
      sentBy: ActorRef,
    ) => Effect.Effect<WorkOpResult<Message>>;
    /**
     * Durable read-ack for one mailbox message (delivery.accepted with
     * mailbox-message-read identity). Idempotent.
     */
    readonly workMessageMarkRead: (
      canvas: string,
      nodeId: string,
      messageId: string,
      reader: ActorRef,
    ) => Effect.Effect<WorkOpResult<{ readonly messageId: string; readonly readAt: string }>>;
    readonly workRequestCreate: (
      canvas: string,
      nodeId: string,
      brief: string,
      metadata: WorkMetadata | undefined,
      raisedBy: ActorRef,
      reason?: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workRequestResolve: (
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "completed" | "rejected",
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workArtifactPublish: (
      canvas: string,
      nodeId: string,
      artifact: Artifact,
      publishedBy: ActorRef,
    ) => Effect.Effect<WorkOpResult<Artifact>>;
    readonly commandStatus: Effect.Effect<
      WorkCommandStatus,
      WorkServiceError
    >;
  }
>() {}

export const WorkLive = Layer.effect(
  WorkService,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const repository = yield* WorkRepository;
    const stations = yield* StationRepository;
    const fleetTargets = yield* StationFleetTargetRepository;
    const livePeers = yield* StationLivePeerRegistry;
    const ids = defaultIds();

    const stationContext: Effect.Effect<
      StationContext,
      WorkServiceError
    > = Effect.all({
      localInstallationId: stations.installationId,
      configured: stations.configuration,
    }).pipe(
      Effect.mapError(toWorkServiceError),
      Effect.flatMap(({ localInstallationId, configured }) =>
        configured === undefined
          ? Effect.fail(
            new WorkServiceError({
              code: "invalid",
              message:
                "station role is not configured; choose Command Center or Remote before mutating work",
            }),
          )
          : Effect.succeed({
            localInstallationId,
            configuration: configured.configuration,
          })
      ),
    );

    const readCanvas = (canvasName: string) =>
      canvases.readWithIntentWitness(canvasName).pipe(
        Effect.mapError(toWorkServiceError),
        Effect.map(({ read, intentWitness }) => ({
          ...read,
          intentWitness,
        })),
      );

    const intentBasis = (
      context: StationContext,
      witness: {
        readonly generation: string;
        readonly contentSha256: string;
      },
    ): IntentFactBasisValue =>
      Schema.decodeUnknownSync(IntentFactBasis, {
        onExcessProperty: "error",
      })({
        kind:
          context.configuration.role === "command-center"
            ? "authorial-intent"
            : "projected-intent",
        generation: witness.generation,
        contentSha256: witness.contentSha256,
      });

    const runPolicy = <A>(thunk: () => A): Effect.Effect<A, WorkServiceError> =>
      Effect.try({
        try: thunk,
        catch: toWorkServiceError,
      });

    const complete = <T>(
      canvasName: string,
      outcome: WorkMutationOutcome<T>,
    ): Effect.Effect<WorkApplyOk<T>, WorkServiceError> =>
      readCanvas(canvasName).pipe(
        Effect.map((read) => ({
          ...outcome,
          doc: read.doc,
          revision: read.revision,
        })),
      );

    const requireNode = (
      doc: CanvasDoc,
      nodeId: string,
    ): Effect.Effect<CanvasNode, WorkServiceError> => {
      const node = nodeById(doc, nodeId);
      return node === undefined
        ? Effect.fail(
          new WorkServiceError({
            code: "node_not_found",
            message: `node "${nodeId}" not found`,
          }),
        )
        : Effect.succeed(node);
    };

    const requireActor = (
      read: CanvasReadResult,
      actor: ActorRef,
      targetNodeId: string,
      op:
        | "tasks.create"
        | "tasks.claim"
        | "msg.send"
        | "msg.read"
        | "msg.reply"
        | "request.escalate"
        | "artifact.publish",
    ): Effect.Effect<CanvasNode, WorkServiceError> => {
      const exact = read.actorRefs.filter((candidate) =>
        sameActor(candidate, actor)
      );
      if (exact.length !== 1) {
        return Effect.fail(
          new WorkServiceError({
            code: "invalid",
            message:
              `actor ${JSON.stringify(actor.nodeId)} does not identify exactly one ` +
              "compiled actor seat in the current projection",
          }),
        );
      }
      // Own-mailbox read is process-bind + seat ownership, not edge OptIn.
      // Actor↔actor grant law is OptIn; requiring msg.list on a self-loop would
      // make mark-read impossible without authoring a nonsense self-edge.
      if (op === "msg.read" && actor.nodeId === targetNodeId) {
        const actorNode = nodeById(read.doc, actor.nodeId);
        return actorNode === undefined
          ? Effect.fail(
            new WorkServiceError({
              code: "node_not_found",
              message: `node "${actor.nodeId}" not found`,
            }),
          )
          : Effect.succeed(actorNode);
      }
      const admitted = admitWorkTarget(
        read.doc,
        actor.nodeId,
        targetNodeId,
        op,
      );
      if (Either.isLeft(admitted)) {
        return Effect.fail(
          new WorkServiceError({
            code:
              admitted.left.type === "UnknownTarget"
                ? "node_not_found"
                : "invalid",
            message: admitted.left.message,
          }),
        );
      }
      const actorNode = nodeById(read.doc, actor.nodeId);
      return actorNode === undefined
        ? Effect.fail(
          new WorkServiceError({
            code: "node_not_found",
            message: `actor node "${actor.nodeId}" not found`,
          }),
        )
        : Effect.succeed(actorNode);
    };

    const homeForNode = (
      node: CanvasNode,
      context: StationContext,
    ): Effect.Effect<InstallationIdValue, WorkServiceError> => {
      const hostId = resolveNodeHostId(node);
      if (hostId === context.configuration.hostId) {
        return Effect.succeed(context.localInstallationId);
      }
      if (context.configuration.role === "remote") {
        return Effect.succeed(
          context.configuration.commandCenterInstallationId,
        );
      }
      return fleetTargets.get(hostId).pipe(
        Effect.mapError(toWorkServiceError),
        Effect.flatMap((target) =>
          target === undefined
            ? Effect.fail(
              new WorkServiceError({
                code: "invalid",
                message:
                  `host ${JSON.stringify(hostId)} has no enrolled Station installation`,
              }),
            )
            : Effect.succeed(target.stationInstallationId)
        ),
      );
    };

    const requireLocalActor = (
      read: CanvasReadResult,
      actor: ActorRef,
      targetNodeId: string,
      op:
        | "tasks.create"
        | "msg.send"
        | "msg.read"
        | "msg.reply"
        | "request.escalate"
        | "artifact.publish",
      context: StationContext,
    ): Effect.Effect<CanvasNode, WorkServiceError> =>
      requireActor(read, actor, targetNodeId, op).pipe(
        Effect.flatMap((actorNode) =>
          homeForNode(actorNode, context).pipe(
            Effect.flatMap((actorHome) =>
              actorHome === context.localInstallationId
                ? Effect.succeed(actorNode)
                : Effect.fail(
                  new WorkServiceError({
                    code: "invalid",
                    message:
                      `${op} must originate on the installation that owns ` +
                      `actor ${JSON.stringify(actor.nodeId)}`,
                  }),
                )
            ),
          )
        ),
      );

    const requireRoutableRemote = (
      targetInstallationId: InstallationIdValue,
      context: StationContext,
    ): Effect.Effect<void, WorkServiceError> => {
      if (targetInstallationId === context.localInstallationId) {
        return Effect.fail(
          new WorkServiceError({
            code: "invalid",
            message: "remote command target must differ from this installation",
          }),
        );
      }
      if (context.configuration.role === "remote") {
        return targetInstallationId ===
            context.configuration.commandCenterInstallationId
          ? Effect.void
          : Effect.fail(
            new WorkServiceError({
              code: "invalid",
              message: "a Remote may enqueue work only to its Command Center",
            }),
          );
      }
      return fleetTargets.list.pipe(
        Effect.mapError(toWorkServiceError),
        Effect.flatMap((targets) =>
          targets.some(
            (target) =>
              target.stationInstallationId === targetInstallationId,
          )
            ? Effect.void
            : Effect.fail(
              new WorkServiceError({
                code: "invalid",
                message:
                  `Station installation ${JSON.stringify(targetInstallationId)} is not an active fleet target`,
              }),
            )
        ),
      );
    };

    const enqueue = <T>(
      context: StationContext,
      targetInstallationId: InstallationIdValue,
      item: WorkItemRef,
      action: Exclude<
        WorkActionValue,
        { readonly operation: "task.claim" }
      >,
      value: T,
    ): Effect.Effect<WorkMutationOutcome<T>, WorkServiceError> =>
      requireRoutableRemote(targetInstallationId, context).pipe(
        Effect.flatMap(() =>
          repository.enqueueRemoteCommand({
            sink: item.sink,
            targetInstallationId,
            item,
            action,
          })
        ),
        Effect.mapError(toWorkServiceError),
        Effect.as({
          value,
          disposition: "queued" as const,
        }),
      );

    const local = <T>(
      effect: Effect.Effect<
        { readonly value: T },
        unknown
      >,
    ): Effect.Effect<WorkMutationOutcome<T>, WorkServiceError> =>
      effect.pipe(
        Effect.mapError(toWorkServiceError),
        Effect.map(({ value }) => ({
          value,
          disposition: "applied" as const,
        })),
      );

    const itemHome = (
      lane: "task" | "proposal" | "request",
      canvasName: string,
      nodeId: string,
      itemId: string,
    ): Effect.Effect<InstallationIdValue, WorkServiceError> =>
      repository.itemHome(lane, canvasName, nodeId, itemId).pipe(
        Effect.mapError(toWorkServiceError),
        Effect.flatMap((home) =>
          home === undefined
            ? Effect.fail(
              new WorkServiceError({
                code: "task_not_found",
                message: `${lane} "${itemId}" not found`,
              }),
            )
              : Effect.succeed(home)
        ),
      );

    const commandStatus = repository.pendingCommands.pipe(
      Effect.mapError(toWorkServiceError),
      Effect.map((commands): WorkCommandStatus => {
        const pending = commands.filter(
          (entry) => entry.resolution === undefined,
        );
        const applied = commands.filter(
          (entry) => entry.resolution?.status === "applied",
        );
        const rejected = commands.filter(
          (entry) => entry.resolution?.status === "rejected",
        );
        return {
          counts: {
            pending: pending.length,
            applied: applied.length,
            rejected: rejected.length,
          },
          pending: pending.slice(0, COMMAND_STATUS_DETAIL_LIMIT),
          rejections: rejected.slice(0, COMMAND_STATUS_DETAIL_LIMIT),
          truncated: {
            pending: pending.length > COMMAND_STATUS_DETAIL_LIMIT,
            rejections: rejected.length > COMMAND_STATUS_DETAIL_LIMIT,
          },
        };
      }),
    );

    return WorkService.of({
      workTaskHome: (canvas, nodeId, taskId) =>
        itemHome("task", canvas, nodeId, taskId),
      workTaskCreate: (canvas, nodeId, brief, metadata, reason, media, dependsOn, finishCriteria) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            const node = yield* requireNode(read.doc, nodeId);
            const policy = yield* runPolicy(() =>
              workTaskCreate(
                read.doc,
                canvas,
                nodeId,
                brief,
                metadata,
                ids,
                reason,
                media,
                dependsOn,
                finishCriteria,
              )
            );
            const home = yield* homeForNode(node, context);
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.createTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  task: policy.task,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("task", policy.task.id, canvas, nodeId),
                { operation: "task.create", task: policy.task },
                policy.task,
              );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskPropose: (canvas, nodeId, brief, metadata, proposedBy, reason) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            yield* requireLocalActor(
              read,
              proposedBy,
              nodeId,
              "tasks.create",
              context,
            );
            const node = yield* requireNode(read.doc, nodeId);
            const policy = yield* runPolicy(() =>
              workTaskPropose(
                read.doc,
                canvas,
                nodeId,
                brief,
                metadata,
                ids,
                proposedBy,
                reason,
              )
            );
            const home = yield* homeForNode(node, context);
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.createProposal({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  proposal: policy.proposal,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("proposal", policy.proposal.id, canvas, nodeId),
                { operation: "proposal.create", proposal: policy.proposal },
                policy.proposal,
              );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskApproveProposal: (canvas, nodeId, taskId) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("proposal", canvas, nodeId, taskId),
            ]);
            const policy = yield* runPolicy(() =>
              workTaskApproveProposal(
                read.doc,
                canvas,
                nodeId,
                taskId,
                ids,
              )
            );
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.approveProposal({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  proposalId: taskId,
                  task: policy.task,
                }),
              ).pipe(Effect.map((entry) => ({
                ...entry,
                value: entry.value.task,
              })))
              : yield* requireRoutableRemote(home, context).pipe(
                  Effect.flatMap(() =>
                    repository.enqueueRemoteProposalApproval({
                      sink: sinkRef(canvas, nodeId),
                      targetInstallationId: home,
                      item: {
                        ...workItem(
                          "proposal",
                          taskId,
                          canvas,
                          nodeId,
                        ),
                        kind: "proposal" as const,
                      },
                      action: {
                        operation: "proposal.approve",
                        proposalId: taskId,
                        task: policy.task,
                      },
                    })
                  ),
                  Effect.mapError(toWorkServiceError),
                  Effect.as({
                    value: policy.task,
                    disposition: "queued" as const,
                  }),
                );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskDescribe: (canvas, nodeId, taskId, brief) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const policy = yield* runPolicy(() =>
              workTaskDescribe(
                read.doc,
                canvas,
                nodeId,
                taskId,
                brief,
                ids,
              )
            );
            const message = policy.task.history[0]!;
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.describeTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  taskId,
                  message,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("task", taskId, canvas, nodeId),
                { operation: "task.describe", taskId, message },
                policy.task,
              );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskTransition: (canvas, nodeId, taskId, state, note, completionEvidence) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const before = nodeById(read.doc, nodeId)?.ether?.tasks?.items
              .find((task) => task.id === taskId);
            const policy = yield* runPolicy(() =>
              workTaskTransition(
                read.doc,
                canvas,
                nodeId,
                taskId,
                state,
                note,
                ids,
                completionEvidence,
              )
            );
            const message =
              before !== undefined &&
                policy.task.history.length > before.history.length
                ? policy.task.history.at(-1)
                : undefined;
            const action = {
              operation: "task.transition" as const,
              taskId,
              state,
              ...(message === undefined ? {} : { message }),
              ...(completionEvidence !== undefined
                ? { completionEvidence }
                : {}),
            };
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.transitionTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  taskId,
                  state,
                  ...(message === undefined ? {} : { message }),
                  ...(completionEvidence !== undefined
                    ? { completionEvidence }
                    : {}),
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("task", taskId, canvas, nodeId),
                action,
                policy.task,
              );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskRespond: (canvas, nodeId, taskId, responseText, disposition) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            if (context.configuration.role !== "command-center") {
              return yield* new WorkServiceError({
                code: "invalid",
                message: "only the configured Command Center operator may respond to a task",
              });
            }
            const policy = yield* runPolicy(() =>
              workTaskRespond(
                read.doc,
                canvas,
                nodeId,
                taskId,
                responseText,
                disposition,
                ids,
              )
            );
            const message = policy.task.history.at(-1)!;
            const action = {
              operation: "task.transition" as const,
              taskId,
              state: disposition,
              message,
            };
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.transitionTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  taskId,
                  state: disposition,
                  message,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("task", taskId, canvas, nodeId),
                action,
                policy.task,
              );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskClaim: (canvas, nodeId, taskId, actor) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, sourceHome] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const actorNode = yield* requireActor(
              read,
              actor,
              nodeId,
              "tasks.claim",
            );
            const actorHome = yield* homeForNode(actorNode, context);
            if (sourceHome !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  "first claim must execute on the installation that owns the submitted queue",
              });
            }
            const sourceItems =
              nodeById(read.doc, nodeId)?.ether?.tasks?.items ?? [];
            const sourceTask = sourceItems.find((task) => task.id === taskId);
            if (sourceTask === undefined) {
              return yield* new WorkServiceError({
                code: "task_not_found",
                message: `task "${taskId}" not found`,
              });
            }
            // Claim-ready gate for every first-claim arm (local + remote reserve).
            if (
              sourceTask.state === "submitted" &&
              !taskIsClaimReady(sourceTask, taskIndexById(sourceItems))
            ) {
              return yield* new WorkServiceError({
                code: "invalid",
                message: `task "${taskId}" is not claim-ready (unsatisfied dependsOn)`,
              });
            }
            let outcome: WorkMutationOutcome<Task>;
            if (actorHome === context.localInstallationId) {
              outcome = yield* local(
                repository.claimLocalTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  taskId,
                  actor,
                }),
              );
            } else {
              if (context.configuration.role !== "command-center") {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message:
                    "a Remote cannot relay a task claim to another installation",
                });
              }
              const hostId = resolveNodeHostId(actorNode);
              const target = yield* fleetTargets.get(hostId).pipe(
                Effect.mapError(toWorkServiceError),
              );
              if (
                target === undefined ||
                target.stationInstallationId !== actorHome
              ) {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message:
                    `actor host ${JSON.stringify(hostId)} has no exact enrolled Station target`,
                });
              }
              const witness = yield* livePeers
                .require(hostId, actorHome)
                .pipe(Effect.mapError(toWorkServiceError));
              yield* livePeers.withSession(
                witness,
                repository.reserveRemoteTaskClaim({
                  sink: sinkRef(canvas, nodeId),
                  taskId,
                  actor,
                  targetInstallationId: actorHome,
                }),
              ).pipe(Effect.mapError(toWorkServiceError));
              outcome = {
                value: sourceTask,
                disposition: "queued",
              };
            }
            return yield* complete(canvas, outcome);
          }),
        ),

      workMessageAppend: (
        canvas,
        nodeId,
        taskId,
        message,
        sentBy,
      ) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            yield* requireLocalActor(
              read,
              sentBy,
              nodeId,
              "msg.send",
              context,
            );
            const targetNode = yield* requireNode(read.doc, nodeId);
            const policy = yield* runPolicy(() =>
              workMessageAppend(
                read.doc,
                canvas,
                nodeId,
                taskId,
                message,
              )
            );
            const targetSpec = resolveSpec({
              isGroup: false,
              kind: targetNode.ether?.entity?.kind,
            });
            const isRequestSink = Match.value(targetSpec).pipe(
              Match.when({ _tag: "Sink", kind: "requests" }, () => true),
              Match.orElse(() => false),
            );
            const destination = taskId === null
              ? { kind: "mailbox" as const }
              : isRequestSink
                ? {
                    kind: "request" as const,
                    itemId: taskId,
                  }
                : {
                    kind: "task" as const,
                    itemId: taskId,
                  };
            const home = taskId === null
              ? context.configuration.role === "command-center"
                ? context.localInstallationId
                : context.configuration.commandCenterInstallationId
              : isRequestSink
                ? yield* itemHome(
                  "request",
                  canvas,
                  nodeId,
                  taskId,
                )
                : yield* itemHome("task", canvas, nodeId, taskId);
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.appendMessage({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  message: policy.message,
                  sentBy,
                  destination,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem(
                  "message",
                  policy.message.messageId,
                  canvas,
                  nodeId,
                ),
                {
                  operation: "message.append",
                  message: policy.message,
                  sentBy,
                  destination,
                },
                policy.message,
              );
            if (outcome.disposition === "applied" && taskId === null) {
              messageDelivery.notifyAppended(
                canvas,
                nodeId,
                outcome.value,
              );
            }
            return yield* complete(canvas, outcome);
          }),
        ),

      workMessageMarkRead: (canvas, nodeId, messageId, reader) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            yield* requireLocalActor(
              read,
              reader,
              nodeId,
              "msg.read",
              context,
            );
            if (reader.nodeId !== nodeId || reader.canvasName !== canvas) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "only the mailbox owner may mark a message read",
                }),
              );
            }
            const trimmed = messageId.trim();
            if (!trimmed) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "messageId must be non-empty",
                }),
              );
            }
            const exists = (read.doc.nodes.find((n) => n.id === nodeId)?.ether
              ?.messages?.items ?? []).some((m) => m.messageId === trimmed);
            if (!exists) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "node_not_found",
                  message: `message "${trimmed}" not found in mailbox`,
                }),
              );
            }
            const sink = sinkRef(canvas, nodeId);
            const deliveryId = mailboxMessageReadId(canvas, nodeId, trimmed);
            const existingAt = yield* repository
              .acceptedDeliveryAt(sink, deliveryId)
              .pipe(Effect.mapError(toWorkServiceError));
            if (existingAt !== undefined) {
              return yield* complete(canvas, {
                disposition: "applied" as const,
                value: { messageId: trimmed, readAt: existingAt },
              });
            }
            const acceptedAt = new Date().toISOString();
            // Race-safe: concurrent markRead may win the insert between the
            // lookup above and acceptDelivery; identity-conflict is applied.
            const outcome = yield* repository
              .acceptDelivery({
                sink,
                basis: intentBasis(context, read.intentWitness),
                receipt: {
                  deliveryId,
                  deliveredItem: {
                    kind: "message",
                    itemId: trimmed,
                    sink,
                  },
                  actor: reader,
                  acceptedAt,
                },
              })
              .pipe(
                Effect.map((result) => ({
                  value: {
                    messageId: trimmed,
                    readAt: result.value.acceptedAt,
                  },
                })),
                Effect.catchIf(
                  (error): error is WorkAuthorityError =>
                    error instanceof WorkAuthorityError &&
                    error.reason === "identity-conflict",
                  () =>
                    repository.acceptedDeliveryAt(sink, deliveryId).pipe(
                      Effect.mapError(toWorkServiceError),
                      Effect.flatMap((at) =>
                        at === undefined
                          ? Effect.fail(
                            new WorkServiceError({
                              code: "invalid",
                              message:
                                `read receipt "${deliveryId}" conflicted but is missing`,
                            }),
                          )
                          : Effect.succeed({
                            value: { messageId: trimmed, readAt: at },
                          }),
                      ),
                    ),
                ),
                Effect.mapError(toWorkServiceError),
                Effect.map(({ value }) => ({
                  value,
                  disposition: "applied" as const,
                })),
              );
            return yield* complete(canvas, outcome);
          }),
        ),

      workRequestCreate: (
        canvas,
        nodeId,
        brief,
        metadata,
        raisedBy,
        reason,
      ) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            yield* requireLocalActor(
              read,
              raisedBy,
              nodeId,
              "request.escalate",
              context,
            );
            const policy = yield* runPolicy(() =>
              workRequestCreate(
                read.doc,
                canvas,
                nodeId,
                brief,
                metadata,
                ids,
                raisedBy,
                reason,
              )
            );
            const outcome = yield* local(
              repository.createRequest({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                request: policy.task,
                raisedBy,
              }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workRequestResolve: (
        canvas,
        nodeId,
        taskId,
        responseText,
        disposition,
      ) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("request", canvas, nodeId, taskId),
            ]);
            const before = nodeById(read.doc, nodeId)?.ether?.requests?.items
              .find((task) => task.id === taskId);
            const policy = yield* runPolicy(() =>
              workRequestResolve(
                read.doc,
                canvas,
                nodeId,
                taskId,
                responseText,
                disposition,
                ids,
              )
            );
            const message =
              before !== undefined &&
                policy.task.history.length > before.history.length
                ? policy.task.history.at(-1)
                : undefined;
            const action = {
              operation: "request.resolve" as const,
              requestId: taskId,
              response: policy.task.response!,
              disposition,
              ...(message === undefined ? {} : { message }),
            };
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.resolveRequest({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  requestId: taskId,
                  response: policy.task.response!,
                  disposition,
                  ...(message === undefined ? {} : { message }),
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("request", taskId, canvas, nodeId),
                action,
                policy.task,
              );
            if (outcome.disposition === "applied") {
              clearSeatBlockedByRequest(canvas, taskId);
            }
            const completed = yield* complete(canvas, outcome);
            if (
              outcome.disposition === "applied" &&
              before?.claimedBy !== undefined
            ) {
              const raisers = read.actorRefs.filter(
                (actor) =>
                  actor.canvasName === canvas &&
                  actor.seatId === before.claimedBy,
              );
              if (raisers.length === 1) {
                messageDelivery.notifyRequestResolved({
                  canvas,
                  actorNodeId: raisers[0]!.nodeId,
                  requestId: taskId,
                  response: policy.task.response!,
                });
              }
            }
            return completed;
          }),
        ),

      workArtifactPublish: (
        canvas,
        nodeId,
        artifact,
        publishedBy,
      ) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            yield* requireLocalActor(
              read,
              publishedBy,
              nodeId,
              "artifact.publish",
              context,
            );
            const policy = yield* runPolicy(() =>
              workArtifactPublish(
                read.doc,
                canvas,
                nodeId,
                artifact,
              )
            );
            const outcome = yield* local(
              repository.publishArtifact({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                artifact: policy.artifact,
                publishedBy,
              }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      commandStatus,
    });
  }),
);
