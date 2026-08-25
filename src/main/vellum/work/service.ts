// WorkService — one repository-native orchestration seam for the SQLite work
// plane. Canvas documents are read-only topology plus runtime projections;
// every durable mutation goes through a specific WorkRepository verb.

import { Context, Effect, Option, Result, Layer, Match, Schema } from "effect";
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
import { type Pad, type PadPatch } from "@shared/pad";
import { padLookHere, padToDigest, padToSvg } from "@shared/pad-project";
import {
  resolvePadInboundActors,
  tagNotifyNodeIds,
} from "@shared/board-actors";
import { resolveBoardWakeSet } from "@shared/board-wake";
import {
  addedPadMentions,
  inboundActorNodeIds,
  padAuthorRuleError,
  stampPadPatchAuthors,
} from "./pad-rules";
import { softBoardTagNotify } from "./board-delivery";
import type {
  CompletionEvidence,
  FinishCriteria,
  TaskClaim,
  TaskPipelineArm,
} from "@shared/work-model";
import type { WorkSeatRecentOpsFeed } from "@shared/work-recent-ops";
import type { ContentPart } from "@shared/content";
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
  workTaskDescribe,
  workTaskRespond,
  workTaskTransition,
  type WorkIds,
  type WorkTaskCreateOptions,
  type WorkTaskTransitionResult,
} from "@shared/work";
import {
  collectContentRefsFromTask,
  taskContentPendingMessage,
  taskContentReadiness,
} from "@shared/content";
import { dependencyScopeIndex } from "@shared/task-dep-scope";
import { taskIsClaimReady } from "@shared/task-deps";
import {
  effectiveClaimsStack,
  requiredBoardingChecks,
  respondedAtStation,
  effectiveTaskAdmission,
  sinkContractOf,
  stationReceipts,
  taskAdmissionState,
  taskEpoch,
  taskPromoted,
  type EffectiveClaim,
} from "@shared/claims";
import { flowDestinations } from "@shared/flow-graph";
import { regionStack } from "@shared/graph";
import { stationIdentity, stationName } from "@shared/station-identity";
import { taskCommentRecipient } from "@shared/task-owner";
import { makeUserMessage } from "@shared/task";
import {
  TICKET_OUTPUT_TAIL_MAX_BYTES,
  type Ruling,
  type Ticket,
} from "@shared/work-model";
import { operatorPlanningActorRef } from "@shared/work-reference";
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
import { ContentService } from "../content/service";
import { InstallOpsService } from "../install-ops/service";
import { StateEngine } from "../state/engine";
import { runPendingProposalBackfill } from "./pending-proposal-backfill";
import type { ContentOwner } from "../content/manifest";
import { admitWorkTarget, regionStackFor } from "./authz";
import { clearSeatBlockedByRequest } from "./blocked-seat";
import {
  mailboxMessageReactId,
  mailboxMessageReadId,
} from "./mailbox-receipts";
import { messageDelivery } from "./message-delivery";
import {
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryError,
  type PendingCommand,
  type TaskPipelinePatch,
} from "./repository";

export class WorkServiceError extends Schema.TaggedErrorClass<WorkServiceError>()(
  "WorkServiceError",
  {
    code: Schema.Literals(["canvas_not_found", "node_not_found",
    "task_not_found",
    "illegal_kind",
    "illegal_transition",
    "claim_contention",
    "invalid",]),
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
  readonly message?: string;
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
      ({ value, doc, revision, disposition, message }): WorkOpResult<T> => ({
        ok: true,
        data: value,
        doc,
        revision,
        disposition,
        ...(message === undefined ? {} : { message }),
      }),
    ),
    Effect.catch((error) =>
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

/**
 * Pipeline arms of tasks.update: forward choice, defect-back, hold stamp.
 * The shape is shared with the renderer bridge, so it lives in work-model
 * beside the rest of the pipeline vocabulary.
 */
export type WorkTaskPipelineOptions = TaskPipelineArm;

/** One seat-run boarding check result (CLI-executed; service stamps tickets). */
export type WorkBoardCheckResult = {
  readonly checkId: string;
  readonly side: "outbound" | "inbound";
  readonly exitCode: number;
  readonly outputTail: string;
};

export type WorkTaskPassageView = {
  readonly nodeId: string;
  readonly station: string;
  readonly enteredAt: string;
  readonly epoch: number;
  readonly exitedAt?: string;
  readonly exit?: "forwarded" | "closed" | "rejected-back";
  readonly next?: string;
  readonly nextStation?: string;
  readonly emissionNote?: string;
  /** Refs cited by that station's claim responses (onion-visible). */
  readonly refs: ReadonlyArray<string>;
  /** Operator view only: the station row's full completion evidence. */
  readonly evidence?: CompletionEvidence;
};

export type WorkTaskShowView = {
  readonly task: Task;
  readonly station: {
    readonly nodeId: string;
    readonly name: string;
    readonly role?: string;
  };
  readonly journey: ReadonlyArray<WorkTaskPassageView>;
  /** Effective claims at this station (seat) — full task claims for operator. */
  readonly claims: ReadonlyArray<EffectiveClaim>;
  readonly ambient: {
    readonly regions: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly instruction?: string;
    }>;
    readonly sinkInstruction?: string;
    /** Arrival triage guidance from the sink contract (inbound.instruction). */
    readonly sinkTriage?: string;
    /** Forward emission guidance (outbound.emission) — only when this station forwards. */
    readonly sinkEmission?: string;
  };
};

export type WorkTaskClaimsView = {
  readonly stack: ReadonlyArray<EffectiveClaim>;
  readonly readiness?: {
    /** Claims still lacking a response (hard) or response/waiver (soft). */
    readonly unanswered: ReadonlyArray<{
      readonly claimId: string;
      readonly severity: "hard" | "soft";
      readonly text: string;
    }>;
    /** Ticket status per destination's applicable boarding checks. */
    readonly boarding: ReadonlyArray<{
      readonly destination: string;
      readonly checks: ReadonlyArray<{
        readonly checkId: string;
        readonly side: "outbound" | "inbound";
        readonly label: string;
        /** Authored command the seat runs locally to earn this ticket. */
        readonly command: string;
        /** "stale" — the check's command changed after this ticket was stamped; re-run tasks board. */
        readonly status: "green" | "red" | "missing" | "stale";
      }>;
    }>;
  };
};

export type WorkRulingsView = {
  readonly regions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly rulings: ReadonlyArray<Ruling>;
  }>;
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

/**
 * Work-plane service contract (effect v4).
 *
 * Identifier and shape stay separate so there is exactly one work-plane
 * service key — no dual definitions.
 */
export interface WorkServiceId {
  readonly _workService: unique symbol;
}

export interface WorkServiceShape {
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
      claims?: ReadonlyArray<TaskClaim>,
      options?: WorkTaskCreateOptions,
    ) => Effect.Effect<WorkOpResult<Task>>;
    /**
     * Operator planning: mint a submitted Task with operator-gated overlay
     * (not claimable until promote). Uses operatorPlanningActorRef.
     */
    readonly workTaskProposeOperator: (
      canvas: string,
      nodeId: string,
      brief: string,
      metadata?: WorkMetadata,
      reason?: string,
      media?: ReadonlyArray<Part>,
      dependsOn?: ReadonlyArray<string>,
      finishCriteria?: FinishCriteria,
      claims?: ReadonlyArray<TaskClaim>,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskApproveProposal: (
      canvas: string,
      nodeId: string,
      taskId: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskRejectProposal: (
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
      pipeline?: WorkTaskPipelineOptions,
    ) => Effect.Effect<WorkOpResult<Task>>;
    /** Operator promotion of an operator-gated arrival (epoch-scoped stamp). */
    readonly workTaskPromote: (
      canvas: string,
      nodeId: string,
      taskId: string,
      note?: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    /** Operator rejection of an unpromoted operator-gated arrival. */
    readonly workTaskRejectArrival: (
      canvas: string,
      nodeId: string,
      taskId: string,
      note?: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    /**
     * Task record with journey. Seat view is onion-scoped: prior passages
     * expose emission notes and cited refs, never their interiors; the
     * operator view exposes everything.
     */
    readonly workTaskShow: (
      canvas: string,
      nodeId: string,
      taskId: string,
      view: "seat" | "operator",
    ) => Effect.Effect<WorkTaskShowView, WorkServiceError>;
    /** Effective claims stack with provenance; readiness when a task is named. */
    readonly workTaskClaims: (
      canvas: string,
      nodeId: string,
      taskId?: string,
    ) => Effect.Effect<WorkTaskClaimsView, WorkServiceError>;
    /** Pinned rulings across the node's region stack, outer to inner. */
    readonly workRulingsList: (
      canvas: string,
      nodeId: string,
    ) => Effect.Effect<WorkRulingsView, WorkServiceError>;
    /**
     * Stamp boarding tickets from seat-submitted check runs. The CLI executes
     * the checklist commands in the seat's own environment; this service only
     * validates results against the applicable checklists and stamps
     * epoch-tagged tickets. Boarding is never accepted through any other op.
     */
    readonly workTaskBoard: (
      canvas: string,
      nodeId: string,
      taskId: string,
      results: ReadonlyArray<WorkBoardCheckResult>,
      next?: string,
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
    /** Command Center operator comment on the canonical task thread. */
    readonly workTaskComment: (
      canvas: string,
      nodeId: string,
      taskId: string,
      message: Message,
    ) => Effect.Effect<WorkOpResult<Message>>;
    readonly workMessageAppend: (
      canvas: string,
      nodeId: string,
      taskId: string | null,
      message: Message,
      sentBy: ActorRef,
    ) => Effect.Effect<WorkOpResult<Message>>;
    /**
     * Command Center system mailbox notify (no process-bound sender).
     * Used when factory topology newly enables actor↔actor msg.send.
     * Appends as foreign user mail so message-delivery can inject the PTY.
     */
    readonly workSystemMailboxNotify: (
      canvas: string,
      nodeId: string,
      message: Message,
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
    readonly workMessageReact: (
      canvas: string,
      nodeId: string,
      messageId: string,
      reaction: "ack",
      reactor: ActorRef,
    ) => Effect.Effect<
      WorkOpResult<{
        readonly messageId: string;
        readonly reaction: "ack";
        readonly reactedAt: string;
      }>
    >;
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
    /** Operator soft-archive / restore (metadata.archived). */
    readonly workArtifactArchive: (
      canvas: string,
      nodeId: string,
      artifactId: string,
      archived: boolean,
    ) => Effect.Effect<WorkOpResult<Artifact>>;
    /** Operator hard-delete from the artifacts sink. */
    readonly workArtifactDelete: (
      canvas: string,
      nodeId: string,
      artifactId: string,
    ) => Effect.Effect<WorkOpResult<{ readonly artifactId: string }>>;
    readonly workSeatRecentOps: (
      canvas: string,
      nodeId: string,
      limit?: number,
    ) => Effect.Effect<WorkOpResult<WorkSeatRecentOpsFeed>>;
    readonly workBoardList: (
      canvas: string,
      nodeId: string,
      topicId?: string,
    ) => Effect.Effect<WorkOpResult<import("@shared/work-model").WorkBoard>>;
    readonly workBoardCreateTopic: (
      canvas: string,
      nodeId: string,
      title: string,
      body: string | undefined,
      author: import("@shared/work-model").BoardAuthor,
      notify: boolean,
    ) => Effect.Effect<
      WorkOpResult<{
        readonly topic: import("@shared/work-model").BoardTopic;
        readonly notify: boolean;
      }>
    >;
    readonly workBoardPost: (
      canvas: string,
      nodeId: string,
      topicId: string,
      text: string,
      author: import("@shared/work-model").BoardAuthor,
      tags?: ReadonlyArray<string>,
    ) => Effect.Effect<
      WorkOpResult<{ readonly post: import("@shared/work-model").BoardPost }>
    >;
    readonly workBoardMarkRead: (
      canvas: string,
      nodeId: string,
      topicId: string,
      principalKey: string,
      upToPosition?: number,
    ) => Effect.Effect<WorkOpResult<{ readonly topicId: string }>>;
    readonly workPadRead: (
      canvas: string,
      nodeId: string,
      pinId?: string,
    ) => Effect.Effect<
      WorkOpResult<{
        readonly revision: number;
        readonly pad: Pad;
        readonly digest: string;
        readonly svg: string;
        readonly lookHere?: import("@shared/pad-project").PadLookHere;
      }>
    >;
    readonly workPadPatch: (
      canvas: string,
      nodeId: string,
      patches: ReadonlyArray<PadPatch>,
      author: import("@shared/work-model").BoardAuthor,
    ) => Effect.Effect<
      WorkOpResult<{
        readonly revision: number;
        readonly pad: Pad;
        readonly digest: string;
      }>
    >;
    readonly workPadMarkRead: (
      canvas: string,
      nodeId: string,
      pinId: string,
      principalKey: string,
    ) => Effect.Effect<WorkOpResult<{ readonly pinId: string }>>;
    readonly commandStatus: Effect.Effect<
      WorkCommandStatus,
      WorkServiceError
    >;
}

export type WorkService = WorkServiceId;

export const WorkService = Context.Service<WorkService, WorkServiceShape>("@vellum/WorkService");

export const WorkLive = Layer.effect(
  WorkService,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const repository = yield* WorkRepository;
    const stations = yield* StationRepository;
    const fleetTargets = yield* StationFleetTargetRepository;
    const livePeers = yield* StationLivePeerRegistry;
    // S2: ContentService is a hard WorkLive dependency (both CC + Remote graphs
    // compose it — runtime.ts / remote-runtime.ts). Hard yield*, never
    // serviceOption: a missing ContentService must fail layer build, not soft-
    // degrade claim/media as "unavailable". Closed over for media claim gate +
    // raw externalize (methods stay R=never). Kernel still runs via warm
    // Runtime.runPromise so other ambient lookups cannot reintroduce the
    // empty-Context class of bug.
    const contentService = yield* ContentService;
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
      canvases.readWithIntentWitness(canvasName, "work.service").pipe(
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

    const decodeRawBytes = (encoded: string): Buffer => {
      const normalized = encoded.replace(/\s+/g, "");
      if (
        normalized.length % 4 === 1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
      ) {
        throw new Error("raw media bytesBase64 is not valid Base64");
      }
      const bytes = Buffer.from(normalized, "base64");
      const withoutPadding = normalized.replace(/=+$/u, "");
      if (bytes.toString("base64").replace(/=+$/u, "") !== withoutPadding) {
        throw new Error("raw media bytesBase64 is not canonical Base64");
      }
      if (bytes.length === 0) {
        throw new Error("raw media part is empty");
      }
      return bytes;
    };

    const externalizeParts = (
      parts: ReadonlyArray<Part>,
      owner?: ContentOwner,
    ): Effect.Effect<ReadonlyArray<Part>, WorkServiceError> => {
      if (!parts.some((part) => part.kind === "raw")) {
        return Effect.succeed(parts);
      }
      return Effect.gen(function* () {
        return yield* Effect.forEach(parts, (part) => {
          if (part.kind !== "raw") return Effect.succeed(part);
          return Effect.try({
            try: () => decodeRawBytes(part.bytesBase64),
            catch: toWorkServiceError,
          }).pipe(
            Effect.flatMap((source) =>
              contentService.put({
                source,
                mediaType: part.mediaType ?? "application/octet-stream",
                ...(owner === undefined ? {} : { owner }),
              }),
            ),
            Effect.map((result): ContentPart => ({
              kind: "content",
              ref: result.ref,
            })),
            Effect.mapError(toWorkServiceError),
          );
        });
      });
    };

    const externalizePadPatches = (
      patches: ReadonlyArray<PadPatch>,
      canvas: string,
      nodeId: string,
    ): Effect.Effect<ReadonlyArray<PadPatch>, WorkServiceError> =>
      Effect.forEach(patches, (patch) => {
        if (patch.op !== "pin.reply") return Effect.succeed(patch);
        return externalizeParts(patch.post.parts, {
          kind: "other",
          canvasName: canvas,
          nodeId,
          recordId: patch.post.postId,
        }).pipe(
          Effect.map((parts): PadPatch => ({
            ...patch,
            post: { ...patch.post, parts },
          })),
        );
      });

    const externalizeMessage = (
      message: Message,
      owner?: ContentOwner,
    ): Effect.Effect<Message, WorkServiceError> =>
      externalizeParts(message.parts, owner).pipe(
        Effect.map((parts) => ({ ...message, parts })),
      );

    const externalizeTask = (
      task: Task,
      owner?: ContentOwner,
    ): Effect.Effect<Task, WorkServiceError> =>
      Effect.forEach(task.history, (message) =>
        externalizeMessage(message, owner),
      ).pipe(Effect.map((history) => ({ ...task, history })));

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
        | "msg.react"
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
      if (
        (op === "msg.read" || op === "msg.react") &&
        actor.nodeId === targetNodeId
      ) {
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
      if (Result.isFailure(admitted)) {
        return Effect.fail(
          new WorkServiceError({
            code:
              admitted.failure.type === "UnknownTarget"
                ? "node_not_found"
                : "invalid",
            message: admitted.failure.message,
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
        | "msg.react"
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

    const installOpsOption = yield* Effect.serviceOption(InstallOpsService);
    const stateOption = yield* Effect.serviceOption(StateEngine);
    if (Option.isSome(installOpsOption) && Option.isSome(stateOption)) {
      yield* runPendingProposalBackfill({
        state: stateOption.value,
        installOps: installOpsOption.value,
        persist: (input) =>
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(input.canvasName),
            ]);
            yield* repository.createTask({
              sink: {
                canvasName: input.canvasName,
                nodeId: input.nodeId,
              },
              basis: intentBasis(context, read.intentWitness),
              task: input.materialization.task,
            }).pipe(Effect.mapError(toWorkServiceError));
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                console.error(
                  "[work] pending-proposal persist deferred:",
                  error,
                );
              }),
            ),
          ),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error(
              "[work] pending-proposal backfill deferred to next boot:",
              error,
            );
          }),
        ),
      );
    }

    return WorkService.of({
      workTaskHome: (canvas, nodeId, taskId) =>
        itemHome("task", canvas, nodeId, taskId),
      workTaskCreate: (canvas, nodeId, brief, metadata, reason, media, dependsOn, finishCriteria, claims, options) =>
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
                claims,
                options,
              )
            );
            const task = yield* externalizeTask(policy.task, {
              kind: "task",
              canvasName: canvas,
              nodeId,
              recordId: policy.task.id,
            });
            const home = yield* homeForNode(node, context);
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.createTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  task,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("task", task.id, canvas, nodeId),
                { operation: "task.create", task },
                task,
              );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskProposeOperator: (
        canvas,
        nodeId,
        brief,
        metadata,
        reason,
        media,
        dependsOn,
        finishCriteria,
        claims,
      ) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            if (context.configuration.role !== "command-center") {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message:
                    "only the Command Center operator may author planning proposals",
                }),
              );
            }
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
                claims,
                {
                  admissionOmitted: "operator-gated",
                  raisedBy: operatorPlanningActorRef(canvas),
                },
              )
            );
            const task = yield* externalizeTask(policy.task, {
              kind: "task",
              canvasName: canvas,
              nodeId,
              recordId: policy.task.id,
            });
            const home = yield* homeForNode(node, context);
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.createTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  task,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("task", task.id, canvas, nodeId),
                { operation: "task.create", task },
                task,
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
              itemHome("task", canvas, nodeId, taskId),
            ]);
            if (context.configuration.role !== "command-center") {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  "only the Command Center operator may promote arrivals",
              });
            }
            // Local-only by design (same as workTaskPromote): Station protocol 1
            // has no promote action, so this cannot enqueue the way task.create
            // does. ProposeOperator may still queue a create onto a remote-homed
            // sink; those arrivals wait until the row lives on Command Center.
            if (home !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "invalid",
                message: "promotion executes on the task home installation",
              });
            }
            const node = yield* requireNode(read.doc, nodeId);
            const current = node.ether?.tasks?.items.find((item) => item.id === taskId);
            if (current === undefined) {
              return yield* new WorkServiceError({
                code: "task_not_found",
                message: `task "${taskId}" not found`,
              });
            }
            const admission = effectiveTaskAdmission(current, sinkContractOf(node));
            if (admission !== "operator-gated") {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  `task "${taskId}" effective admission is ${admission}; promotion applies to operator-gated arrivals`,
              });
            }
            const outcome = yield* local(
              repository.promoteTask({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                taskId,
              }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskRejectProposal: (canvas, nodeId, taskId) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const policy = yield* runPolicy(() =>
              workTaskTransition(
                read.doc,
                canvas,
                nodeId,
                taskId,
                "rejected",
                undefined,
                ids,
              )
            );
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.transitionTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  taskId,
                  state: "rejected",
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem("task", taskId, canvas, nodeId),
                {
                  operation: "task.transition",
                  taskId,
                  state: "rejected",
                },
                policy.task,
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

      workTaskTransition: (canvas, nodeId, taskId, state, note, completionEvidence, pipeline) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const before = nodeById(read.doc, nodeId)?.ether?.tasks?.items
              .find((task) => task.id === taskId);
            // Finish-criteria gate is home-local only. Off-home callers enqueue
            // a command; the executor re-runs the gate against its SQLite shelf.
            // Claims/boarding gates are doc-derived and run in policy always.
            const evaluateFinish =
              home === context.localInstallationId;
            const policy: WorkTaskTransitionResult = yield* runPolicy(() =>
              workTaskTransition(
                read.doc,
                canvas,
                nodeId,
                taskId,
                state,
                note,
                ids,
                completionEvidence,
                {
                  evaluateFinishCriteria: evaluateFinish,
                  ...(pipeline?.next !== undefined
                    ? { next: pipeline.next }
                    : {}),
                  ...(pipeline?.defect !== undefined
                    ? { defect: pipeline.defect }
                    : {}),
                  ...(pipeline?.holdForMs !== undefined
                    ? { holdForMs: pipeline.holdForMs }
                    : {}),
                },
              )
            );
            const message =
              before !== undefined &&
                policy.task.history.length > before.history.length
                ? policy.task.history.at(-1)
                : undefined;
            if (policy.forwarded !== undefined || policy.defectBack !== undefined) {
              // Re-homing writes two rows atomically; it executes only at the
              // task home installation (the pipeline is Command Center law).
              if (home !== context.localInstallationId) {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message:
                    "pipeline forward and defect-back execute on the task home installation",
                });
              }
            }
            if (policy.forwarded !== undefined) {
              const forwarded = policy.forwarded;
              const moved = yield* local(
                repository.forwardTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  taskId,
                  ...(message === undefined ? {} : { message }),
                  ...(completionEvidence !== undefined
                    ? { completionEvidence }
                    : {}),
                  journey: policy.task.journey ?? [],
                  destination: sinkRef(canvas, forwarded.nodeId),
                  destinationTask: forwarded.task,
                }),
              );
              return yield* complete(canvas, {
                ...moved,
                value: moved.value.source,
              });
            }
            if (policy.defectBack !== undefined) {
              const defectBack = policy.defectBack;
              const returned = yield* local(
                repository.defectBackTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  taskId,
                  ...(message === undefined ? {} : { message }),
                  journey: policy.task.journey ?? [],
                  ...(policy.task.defects !== undefined
                    ? { defects: policy.task.defects }
                    : {}),
                  previous: sinkRef(canvas, defectBack.nodeId),
                  returnedTask: defectBack.task,
                }),
              );
              return yield* complete(canvas, {
                ...returned,
                value: returned.value.rejected,
              });
            }
            // Terminal close of a pipeline task stamps the passage exit on
            // the same row; the durable write carries the journey patch.
            // Named apart from the `pipeline` option — a same-block const of
            // that name shadows the parameter and the policy thunk hits TDZ.
            const pipelinePatch: TaskPipelinePatch = {
              ...(policy.task.journey !== undefined
                ? { journey: policy.task.journey }
                : {}),
              ...(policy.task.defects !== undefined
                ? { defects: policy.task.defects }
                : {}),
            };
            const journeyPatch =
              Object.keys(pipelinePatch).length > 0
                ? { pipeline: pipelinePatch }
                : {};
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
                  ...journeyPatch,
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

      workTaskPromote: (canvas, nodeId, taskId, note) =>
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
                message:
                  "only the Command Center operator may promote arrivals",
              });
            }
            // Local-only: protocol 1 has no promote action to enqueue. See
            // workTaskApproveProposal.
            if (home !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "invalid",
                message: "promotion executes on the task home installation",
              });
            }
            const node = yield* requireNode(read.doc, nodeId);
            const task = node.ether?.tasks?.items.find((item) => item.id === taskId);
            if (task === undefined) {
              return yield* new WorkServiceError({
                code: "task_not_found",
                message: `task "${taskId}" not found`,
              });
            }
            const admission = effectiveTaskAdmission(task, sinkContractOf(node));
            if (admission !== "operator-gated") {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  `task "${taskId}" effective admission is ${admission}; promotion applies to operator-gated arrivals`,
              });
            }
            if (taskPromoted(task)) {
              return yield* complete(canvas, {
                value: task,
                disposition: "applied" as const,
              });
            }
            const noteText = note?.trim();
            let message: Message | undefined;
            if (noteText) {
              const policy = yield* runPolicy(() =>
                workMessageAppend(
                  read.doc,
                  canvas,
                  nodeId,
                  taskId,
                  makeUserMessage({
                    messageId: ulid(),
                    text: noteText,
                    contextId: canvas,
                    taskId,
                  }),
                )
              );
              message = yield* externalizeMessage(policy.message, {
                kind: "message",
                canvasName: canvas,
                nodeId,
                recordId: policy.message.messageId,
              });
            }
            const outcome = yield* local(
              repository.promoteTask({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                taskId,
                ...(message === undefined ? {} : { message }),
              }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskRejectArrival: (canvas, nodeId, taskId, note) =>
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
                message:
                  "only the Command Center operator may reject arrivals",
              });
            }
            if (home !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "invalid",
                message: "arrival rejection executes on the task home installation",
              });
            }
            const node = yield* requireNode(read.doc, nodeId);
            const task = node.ether?.tasks?.items.find((item) => item.id === taskId);
            if (task === undefined) {
              return yield* new WorkServiceError({
                code: "task_not_found",
                message: `task "${taskId}" not found`,
              });
            }
            const admission = effectiveTaskAdmission(task, sinkContractOf(node));
            if (admission !== "operator-gated" || taskPromoted(task)) {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  `task "${taskId}" is not an unpromoted operator-gated arrival`,
              });
            }
            const noteText = note?.trim();
            let message: Message | undefined;
            if (noteText) {
              const policy = yield* runPolicy(() =>
                workMessageAppend(
                  read.doc,
                  canvas,
                  nodeId,
                  taskId,
                  makeUserMessage({
                    messageId: ulid(),
                    text: noteText,
                    contextId: canvas,
                    taskId,
                  }),
                )
              );
              message = yield* externalizeMessage(policy.message, {
                kind: "message",
                canvasName: canvas,
                nodeId,
                recordId: policy.message.messageId,
              });
            }
            yield* runPolicy(() =>
              workTaskTransition(
                read.doc,
                canvas,
                nodeId,
                taskId,
                "rejected",
                undefined,
                ids,
              )
            );
            const outcome = yield* local(
              repository.transitionTask({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                taskId,
                state: "rejected",
                ...(message === undefined ? {} : { message }),
              }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workTaskShow: (canvas, nodeId, taskId, view) =>
        Effect.gen(function* () {
          const read = yield* readCanvas(canvas);
          const node = yield* requireNode(read.doc, nodeId);
          const task = node.ether?.tasks?.items.find(
            (candidate) => candidate.id === taskId,
          );
          if (task === undefined) {
            return yield* new WorkServiceError({
              code: "task_not_found",
              message: `task "${taskId}" not found`,
            });
          }
          // Onion visibility: prior passages surface their emission note and
          // the refs their responses cited; full interiors (responses,
          // waivers) travel only on the operator view. The current row is
          // onion-correct by construction — re-homing starts a fresh thread.
          const journey = (task.journey ?? []).map((passage) => {
            const row = nodeById(read.doc, passage.nodeId)
              ?.ether?.tasks?.items.find(
                (candidate) => candidate.id === taskId,
              );
            const evidence = row?.completionEvidence;
            const refs = [
              ...new Set(
                (evidence?.responses ?? []).flatMap(
                  (response) => response.refs ?? [],
                ),
              ),
            ];
            return {
              nodeId: passage.nodeId,
              station: stationName(nodeById(read.doc, passage.nodeId), passage.nodeId),
              enteredAt: passage.enteredAt,
              epoch: passage.epoch,
              ...(passage.exitedAt !== undefined
                ? { exitedAt: passage.exitedAt }
                : {}),
              ...(passage.exit !== undefined ? { exit: passage.exit } : {}),
              ...(passage.next !== undefined
                ? {
                    next: passage.next,
                    nextStation: stationName(
                      nodeById(read.doc, passage.next),
                      passage.next,
                    ),
                  }
                : {}),
              ...(passage.emissionNote !== undefined
                ? { emissionNote: passage.emissionNote }
                : {}),
              refs,
              ...(view === "operator" && evidence !== undefined
                ? { evidence }
                : {}),
            };
          });
          const regions = regionStackFor(read.doc, nodeId);
          const sinkContract = sinkContractOf(node);
          const identity = stationIdentity(node, nodeId);
          const sinkInstruction = sinkContract?.instruction?.trim();
          const sinkTriage = sinkContract?.inbound?.instruction?.trim();
          // Emission is forwarding guidance — meaningless at a terminal sink.
          const sinkEmission =
            flowDestinations(read.doc, nodeId).length > 0
              ? sinkContract?.outbound?.emission?.trim()
              : undefined;
          return {
            task,
            station: {
              nodeId,
              name: identity.name,
              ...(identity.role ? { role: identity.role } : {}),
            },
            journey,
            claims: effectiveClaimsStack(read.doc, nodeId, task),
            ambient: {
              regions,
              ...(sinkInstruction ? { sinkInstruction } : {}),
              ...(sinkTriage ? { sinkTriage } : {}),
              ...(sinkEmission ? { sinkEmission } : {}),
            },
          };
        }),

      workTaskClaims: (canvas, nodeId, taskId) =>
        Effect.gen(function* () {
          const read = yield* readCanvas(canvas);
          const node = yield* requireNode(read.doc, nodeId);
          const task = taskId === undefined
            ? undefined
            : node.ether?.tasks?.items.find(
              (candidate) => candidate.id === taskId,
            );
          if (taskId !== undefined && task === undefined) {
            return yield* new WorkServiceError({
              code: "task_not_found",
              message: `task "${taskId}" not found`,
            });
          }
          const stack = effectiveClaimsStack(read.doc, nodeId, task);
          if (task === undefined) return { stack };
          const receipts = stationReceipts(read.doc, task);
          const unanswered = stack
            .filter(({ claim, provenance }) => {
              // Task claims are station-addressed: only a response recorded
              // at their own station counts. Region/sink claims are ambient
              // law in force at every station they cover, so any response
              // for the same claimId settles it journey-wide.
              const responded =
                provenance.kind === "task"
                  ? respondedAtStation(receipts.responded, provenance.station, claim.id)
                  : receipts.responded.has(claim.id);
              return (
                !responded &&
                !(claim.severity === "soft" && receipts.waived.has(claim.id))
              );
            })
            .map(({ claim }) => ({
              claimId: claim.id,
              severity: claim.severity,
              text: claim.text,
            }));
          const epoch = taskEpoch(task);
          const tickets = (task.boarding ?? []).filter(
            (ticket) => ticket.epoch === epoch,
          );
          const boarding = flowDestinations(read.doc, nodeId).map(
            (destination) => ({
              destination,
              checks: requiredBoardingChecks(read.doc, nodeId, destination)
                .map(({ check, side }) => {
                  const ticket = tickets.find(
                    (candidate) =>
                      candidate.checkId === check.id &&
                      candidate.side === side,
                  );
                  return {
                    checkId: check.id,
                    side,
                    label: check.label,
                    command: check.command,
                    status: ticket === undefined
                      ? ("missing" as const)
                      : ticket.command !== check.command
                        ? ("stale" as const)
                        : ticket.exitCode === 0
                          ? ("green" as const)
                          : ("red" as const),
                  };
                }),
            }),
          );
          return { stack, readiness: { unanswered, boarding } };
        }),

      workRulingsList: (canvas, nodeId) =>
        Effect.gen(function* () {
          const read = yield* readCanvas(canvas);
          yield* requireNode(read.doc, nodeId);
          return {
            regions: regionStack(read.doc, nodeId).map((group) => ({
              id: group.id,
              label: group.label?.trim() || group.id,
              rulings: [
                ...(group.ether?.region?.contract?.rulings ?? []),
              ],
            })),
          };
        }),

      workTaskBoard: (canvas, nodeId, taskId, results, next) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            if (home !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  "boarding tickets stamp on the task home installation",
              });
            }
            const node = yield* requireNode(read.doc, nodeId);
            const task = node.ether?.tasks?.items.find(
              (candidate) => candidate.id === taskId,
            );
            if (task === undefined) {
              return yield* new WorkServiceError({
                code: "task_not_found",
                message: `task "${taskId}" not found`,
              });
            }
            const destinations = flowDestinations(read.doc, nodeId);
            if (destinations.length === 0) {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  `sink "${nodeId}" has no flow destinations; boarding applies to forward moves`,
              });
            }
            const chosen = next ??
              (destinations.length === 1 ? destinations[0] : undefined);
            if (chosen === undefined) {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  `sink "${nodeId}" forwards to more than one station; pick next from [${destinations.join(", ")}]`,
              });
            }
            if (!destinations.includes(chosen)) {
              return yield* new WorkServiceError({
                code: "invalid",
                message:
                  `"${chosen}" is not a live flow destination of sink "${nodeId}" [${destinations.join(", ")}]`,
              });
            }
            const applicable = requiredBoardingChecks(
              read.doc,
              nodeId,
              chosen,
            );
            const nowIso = new Date().toISOString();
            const epoch = taskEpoch(task);
            const stamped = yield* runPolicy(() =>
              results.map((result): Ticket => {
                const match = applicable.find(
                  (entry) =>
                    entry.check.id === result.checkId &&
                    entry.side === result.side,
                );
                if (match === undefined) {
                  throw new WorkError(
                    "invalid",
                    `check "${result.checkId}" (${result.side}) is not on the applicable checklists for "${chosen}"`,
                  );
                }
                return {
                  checkId: match.check.id,
                  side: result.side,
                  // Label/command come from the authored CheckDef, never from
                  // the seat submission.
                  label: match.check.label,
                  command: match.check.command,
                  exitCode: result.exitCode,
                  outputTail: result.outputTail.slice(
                    -TICKET_OUTPUT_TAIL_MAX_BYTES,
                  ),
                  at: nowIso,
                  epoch,
                };
              })
            );
            // stampBoarding merges these against the live row inside its own
            // transaction, not this pre-transaction snapshot — pass only the
            // newly stamped tickets.
            const outcome = yield* local(
              repository.stampBoarding({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                taskId,
                epoch,
                tickets: stamped,
              }),
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
            if (
              sourceTask.state === "working" &&
              sourceTask.claimedBy === actor.seatId
            ) {
              return yield* complete(canvas, {
                value: sourceTask,
                disposition: "applied",
                message:
                  "Task " +
                  JSON.stringify(taskId) +
                  " is already claimed by you; continue working on it.",
              });
            }
            if (actorHome !== context.localInstallationId) {
              const pendingClaims = yield* repository.pendingCommands.pipe(
                Effect.mapError(toWorkServiceError),
              );
              const existingClaim = pendingClaims.some(
                ({ command, resolution }) =>
                  resolution === undefined &&
                  command.operation === "task.claim" &&
                  command.body.operation === "task.claim" &&
                  command.item.kind === "task" &&
                  command.item.sink.canvasName === canvas &&
                  command.item.sink.nodeId === nodeId &&
                  command.item.itemId === taskId &&
                  command.body.actor.seatId === actor.seatId,
              );
              if (existingClaim) {
                return yield* complete(canvas, {
                  value: sourceTask,
                  disposition: "queued",
                  message:
                    "Task " +
                    JSON.stringify(taskId) +
                    " already has your claim queued; continue when it is delivered.",
                });
              }
            }
            // Pipeline admission for every first-claim arm: seats never claim
            // at operator-owned sinks; baking and unpromoted operator-gated
            // arrivals are not claimable yet.
            if (sourceTask.state === "submitted") {
              const admission = taskAdmissionState(
                sourceTask,
                sinkContractOf(nodeById(read.doc, nodeId)),
                Date.now(),
              );
              if (admission === "operator-owned") {
                return yield* new WorkServiceError({
                  code: "claim_contention",
                  message:
                    `sink "${nodeId}" is operator-owned; the operator works tasks here — no seat claim`,
                });
              }
              if (admission === "held") {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message:
                    `task "${taskId}" is not claimable before ${sourceTask.holdUntil} (station bake)`,
                });
              }
              if (admission === "operator-gated") {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message:
                    `task "${taskId}" awaits operator promotion at sink "${nodeId}"`,
                });
              }
            }
            // Claim-ready gate for every first-claim arm (local + remote reserve).
            // dependsOn may resolve to other task sinks in the same region.
            if (
              sourceTask.state === "submitted" &&
              !taskIsClaimReady(
                sourceTask,
                dependencyScopeIndex(read.doc, nodeId),
              )
            ) {
              return yield* new WorkServiceError({
                code: "invalid",
                message: `task "${taskId}" is not claim-ready (unsatisfied dependsOn)`,
              });
            }
            // Content receipts: required media must be verified before claim.
            if (
              sourceTask.state === "submitted" &&
              collectContentRefsFromTask(sourceTask).length > 0
            ) {
              const statuses = yield* Effect.forEach(
                collectContentRefsFromTask(sourceTask),
                (ref) =>
                  contentService.availability(ref).pipe(
                    Effect.mapError(
                      (error) =>
                        new WorkServiceError({
                          code: "invalid",
                          message: `task "${taskId}" content availability failed: ${error.message}`,
                        }),
                    ),
                  ),
              );
              const bySha = new Map(
                statuses.map((status) => [status.ref.sha256, status] as const),
              );
              const content = taskContentReadiness(
                sourceTask,
                (ref) =>
                  bySha.get(ref.sha256) ?? {
                    ref,
                    state: "unavailable" as const,
                    reason: "content availability not resolved" as never,
                  },
              );
              if (content.kind === "pending") {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message: taskContentPendingMessage(taskId, content),
                });
              }
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

      workTaskComment: (canvas, nodeId, taskId, message) =>
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
                message:
                  "only the Command Center operator may comment on a task",
              });
            }
            const targetNode = yield* requireNode(read.doc, nodeId);
            const targetSpec = resolveSpec({
              isGroup: false,
              kind: targetNode.ether?.entity?.kind,
            });
            const isTaskSink = Match.value(targetSpec).pipe(
              Match.when({ _tag: "Sink", kind: "task" }, () => true),
              Match.orElse(() => false),
            );
            if (!isTaskSink) {
              return yield* new WorkServiceError({
                code: "illegal_kind",
                message: "task comments require a task sink",
              });
            }
            const policy = yield* runPolicy(() =>
              workMessageAppend(read.doc, canvas, nodeId, taskId, message)
            );
            const materializedMessage = yield* externalizeMessage(policy.message, {
              kind: "message",
              canvasName: canvas,
              nodeId,
              recordId: policy.message.messageId,
            });
            const sentBy = operatorPlanningActorRef(canvas);
            const destination = { kind: "task" as const, itemId: taskId };
            const outcome = home === context.localInstallationId
              ? yield* local(
                repository.appendMessage({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(context, read.intentWitness),
                  message: materializedMessage,
                  sentBy,
                  destination,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem(
                  "message",
                  materializedMessage.messageId,
                  canvas,
                  nodeId,
                ),
                {
                  operation: "message.append",
                  message: materializedMessage,
                  sentBy,
                  destination,
                },
                materializedMessage,
              );
            if (outcome.disposition === "applied") {
              yield* Effect.gen(function* () {
                const task = targetNode.ether?.tasks?.items.find(
                  (item) => item.id === taskId,
                );
                if (task === undefined) return;
                const ownerRef = taskCommentRecipient(
                  task,
                  sinkContractOf(targetNode),
                  sentBy,
                  read.actorRefs,
                  canvas,
                );
                if (ownerRef === undefined) return;
                const sourceText = message.parts
                  .flatMap((part) => (part.kind === "text" ? [part.text] : []))
                  .join("\n");
                const notification = makeUserMessage({
                  messageId: ulid(),
                  text: `${sourceText}\n(comment on task ${taskId} at "${nodeId}" — reply: vellum-command msg send '{"target":"${nodeId}","taskId":"${taskId}","text":"..."}')`,
                  contextId: canvas,
                  metadata: {
                    factoryMail: true,
                    taskComment: true,
                    taskId,
                    sinkNodeId: nodeId,
                  },
                });
                const copy = yield* externalizeMessage(notification, {
                  kind: "message",
                  canvasName: canvas,
                  nodeId: ownerRef.nodeId,
                  recordId: notification.messageId,
                });
                const delivered = yield* local(
                  repository.appendMessage({
                    sink: sinkRef(canvas, ownerRef.nodeId),
                    basis: intentBasis(context, read.intentWitness),
                    message: copy,
                    sentBy,
                    destination: { kind: "mailbox" },
                  }),
                );
                if (delivered.disposition === "applied") {
                  messageDelivery.notifyAppended(
                    canvas,
                    ownerRef.nodeId,
                    delivered.value,
                  );
                }
              }).pipe(Effect.catch(() => Effect.succeed(undefined)));
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
            const materializedMessage = yield* externalizeMessage(policy.message, {
              kind: "message",
              canvasName: canvas,
              nodeId,
              recordId: policy.message.messageId,
            });
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
                  message: materializedMessage,
                  sentBy,
                  destination,
                }),
              )
              : yield* enqueue(
                context,
                home,
                workItem(
                  "message",
                  materializedMessage.messageId,
                  canvas,
                  nodeId,
                ),
                {
                  operation: "message.append",
                  message: materializedMessage,
                  sentBy,
                  destination,
                },
                materializedMessage,
              );
            if (outcome.disposition === "applied" && taskId === null) {
              messageDelivery.notifyAppended(
                canvas,
                nodeId,
                outcome.value,
              );
            }
            // Owner routing: a task-scoped message is the comment channel, and
            // the current owner of the row gets a mailbox copy — the claiming
            // seat only, never the sender echoing itself; operator-owned and
            // unclaimed rows notify nobody. Best-effort by law: a notification
            // failure must never fail the append. Runs only on the home-local
            // path — an enqueued append has no local mailbox to notify.
            if (
              outcome.disposition === "applied" &&
              taskId !== null &&
              destination.kind === "task"
            ) {
              yield* Effect.gen(function* () {
                const task = targetNode.ether?.tasks?.items.find(
                  (item) => item.id === taskId,
                );
                if (task === undefined) return;
                const ownerRef = taskCommentRecipient(
                  task,
                  sinkContractOf(targetNode),
                  sentBy,
                  read.actorRefs,
                  canvas,
                );
                if (ownerRef === undefined) return;
                const sourceText = message.parts
                  .flatMap((part) => (part.kind === "text" ? [part.text] : []))
                  .join("\n");
                const notification = makeUserMessage({
                  messageId: ulid(),
                  text: `${sourceText}\n(comment on task ${taskId} at "${nodeId}" — reply: vellum-command msg send '{"target":"${nodeId}","taskId":"${taskId}","text":"..."}')`,
                  contextId: canvas,
                  metadata: {
                    factoryMail: true,
                    taskComment: true,
                    taskId,
                    sinkNodeId: nodeId,
                  },
                });
                const copy = yield* externalizeMessage(notification, {
                  kind: "message",
                  canvasName: canvas,
                  nodeId: ownerRef.nodeId,
                  recordId: notification.messageId,
                });
                const delivered = yield* local(
                  repository.appendMessage({
                    sink: sinkRef(canvas, ownerRef.nodeId),
                    basis: intentBasis(context, read.intentWitness),
                    message: copy,
                    sentBy,
                    destination: { kind: "mailbox" },
                  }),
                );
                if (delivered.disposition === "applied") {
                  messageDelivery.notifyAppended(
                    canvas,
                    ownerRef.nodeId,
                    delivered.value,
                  );
                }
              }).pipe(Effect.catch(() => Effect.succeed(undefined)));
            }
            return yield* complete(canvas, outcome);
          }),
        ),

      workSystemMailboxNotify: (canvas, nodeId, message) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            if (context.configuration.role !== "command-center") {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message:
                    "system mailbox notify is Command Center-homed only",
                }),
              );
            }
            const targetNode = yield* requireNode(read.doc, nodeId);
            const targetSpec = resolveSpec({
              isGroup: false,
              kind: targetNode.ether?.entity?.kind,
            });
            const isActor = Match.value(targetSpec).pipe(
              Match.when({ _tag: "Actor" }, () => true),
              Match.orElse(() => false),
            );
            if (!isActor) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message: `system mailbox notify requires an actor inbox; got kind ${
                    targetNode.ether?.entity?.kind ?? "none"
                  }`,
                }),
              );
            }
            if (message.taskId != null) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "system mailbox notify cannot target a task thread",
                }),
              );
            }
            const materializedMessage = yield* externalizeMessage(message, {
              kind: "message",
              canvasName: canvas,
              nodeId,
              recordId: message.messageId,
            });
            const sentBy = operatorPlanningActorRef(canvas);
            const outcome = yield* local(
              repository.appendMessage({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                message: materializedMessage,
                sentBy,
                destination: { kind: "mailbox" },
              }),
            );
            if (outcome.disposition === "applied") {
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

      workMessageReact: (canvas, nodeId, messageId, reaction, reactor) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            yield* requireLocalActor(
              read,
              reactor,
              nodeId,
              "msg.react",
              context,
            );
            if (reactor.nodeId !== nodeId || reactor.canvasName !== canvas) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "only the mailbox owner may react to a message",
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
            const deliveryId = mailboxMessageReactId(
              canvas,
              nodeId,
              trimmed,
              reaction,
            );
            const existingAt = yield* repository
              .acceptedDeliveryAt(sink, deliveryId)
              .pipe(Effect.mapError(toWorkServiceError));
            if (existingAt !== undefined) {
              return yield* complete(canvas, {
                disposition: "applied" as const,
                value: { messageId: trimmed, reaction, reactedAt: existingAt },
              });
            }
            const acceptedAt = new Date().toISOString();
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
                  actor: reactor,
                  acceptedAt,
                },
              })
              .pipe(
                Effect.map((result) => ({
                  value: {
                    messageId: trimmed,
                    reaction,
                    reactedAt: result.value.acceptedAt,
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
                                `react receipt "${deliveryId}" conflicted but is missing`,
                            }),
                          )
                          : Effect.succeed({
                            value: {
                              messageId: trimmed,
                              reaction,
                              reactedAt: at,
                            },
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
            const materializedArtifact = yield* externalizeParts(
              policy.artifact.parts,
              {
                kind: "artifact",
                canvasName: canvas,
                nodeId,
                recordId: policy.artifact.artifactId,
              },
            ).pipe(
              Effect.map((parts) => ({ ...policy.artifact, parts })),
            );
            const outcome = yield* local(
              repository.publishArtifact({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(context, read.intentWitness),
                artifact: materializedArtifact,
                publishedBy,
              }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workArtifactArchive: (canvas, nodeId, artifactId, archived) =>
        asResult(
          Effect.gen(function* () {
            yield* stationContext;
            const outcome = yield* local(
              repository
                .setArtifactArchived({
                  sink: sinkRef(canvas, nodeId),
                  artifactId,
                  archived,
                })
                .pipe(Effect.map((artifact) => ({ value: artifact }))),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workArtifactDelete: (canvas, nodeId, artifactId) =>
        asResult(
          Effect.gen(function* () {
            yield* stationContext;
            const outcome = yield* local(
              repository
                .deleteArtifact({
                  sink: sinkRef(canvas, nodeId),
                  artifactId,
                })
                .pipe(Effect.map((value) => ({ value }))),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workSeatRecentOps: (canvas, nodeId, limit) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readCanvas(canvas);
            const actors = read.actorRefs.filter(
              (actor) =>
                actor.canvasName === canvas && actor.nodeId === nodeId,
            );
            if (actors.length !== 1) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message:
                    `node "${nodeId}" does not identify exactly one compiled actor seat`,
                }),
              );
            }
            const feed = yield* repository
              .recentOpsForSeat({
                canvasName: canvas,
                actorSeatId: actors[0]!.seatId,
                ...(limit === undefined ? {} : { limit }),
              })
              .pipe(Effect.mapError(toWorkServiceError));
            const outcome = yield* local(Effect.succeed({ value: feed }));
            return yield* complete(canvas, outcome);
          }),
        ),

      // Board material rows are Command Center-homed (global sink). List reads
      // local SQLite only — same as mailbox projection: full board on CC.
      workBoardList: (canvas, nodeId, topicId) =>
        asResult(
          Effect.gen(function* () {
            const snap = yield* repository
              .readSnapshot(canvas, nodeId)
              .pipe(Effect.mapError(toWorkServiceError));
            const topics =
              topicId === undefined
                ? snap.board.topics
                : snap.board.topics.filter((t) => t.topicId === topicId);
            const outcome = yield* local(
              Effect.succeed({ value: { topics } }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workBoardCreateTopic: (canvas, nodeId, title, body, author, notify) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            const node = read.doc.nodes.find((n) => n.id === nodeId);
            if (node?.ether?.entity?.kind !== "board") {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message: `node "${nodeId}" is not a board sink`,
                }),
              );
            }
            const now = new Date().toISOString();
            const topicId = ids.id();
            const parts =
              body !== undefined && body.trim().length > 0
                ? [{ kind: "text" as const, text: body.trim() }]
                : [];
            const seedPost =
              parts.length > 0
                ? {
                    postId: ids.messageId(),
                    topicId,
                    author,
                    parts,
                    position: 0,
                    createdAt: now,
                  }
                : undefined;
            const topic = {
              topicId,
              title: title.trim(),
              state: "open" as const,
              openedBy: author,
              openedAt: now,
              postCount: seedPost ? 1 : 0,
              lastActivityAt: now,
              ...(parts.length > 0 ? { parts } : {}),
              ...(seedPost ? { posts: [seedPost] } : {}),
            };
            // Multi-reader bulletin: always Command Center-homed.
            const home =
              context.configuration.role === "command-center"
                ? context.localInstallationId
                : context.configuration.commandCenterInstallationId;
            const outcome =
              home === context.localInstallationId
                ? yield* local(
                  repository
                    .createBoardTopic({
                      sink: sinkRef(canvas, nodeId),
                      basis: intentBasis(context, read.intentWitness),
                      topic,
                      createdBy: author,
                    })
                    .pipe(
                      Effect.map((result) => ({
                        value: { topic: result.value, notify },
                      })),
                    ),
                )
                : yield* enqueue(
                  context,
                  home,
                  workItem("topic", topic.topicId, canvas, nodeId),
                  {
                    operation: "board.topic.create",
                    topic,
                    createdBy: author,
                  },
                  { topic, notify },
                );
            return yield* complete(canvas, outcome);
          }),
        ),

      workBoardPost: (canvas, nodeId, topicId, text, author, tags) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            if (
              read.doc.nodes.find((n) => n.id === nodeId)?.ether?.entity
                ?.kind !== "board"
            ) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message: `node "${nodeId}" is not a board sink`,
                }),
              );
            }
            const now = new Date().toISOString();
            const cleanTags =
              tags && tags.length > 0
                ? tags.filter((t) => typeof t === "string" && t.trim().length > 0)
                : undefined;
            const post = {
              postId: ids.messageId(),
              topicId,
              author,
              parts: [{ kind: "text" as const, text: text.trim() }],
              position: 0,
              createdAt: now,
              ...(cleanTags && cleanTags.length > 0
                ? { tags: cleanTags.map((t) => t.trim()) }
                : {}),
            };
            const home =
              context.configuration.role === "command-center"
                ? context.localInstallationId
                : context.configuration.commandCenterInstallationId;
            const outcome =
              home === context.localInstallationId
                ? yield* local(
                  repository
                    .appendBoardPost({
                      sink: sinkRef(canvas, nodeId),
                      basis: intentBasis(context, read.intentWitness),
                      post,
                      createdBy: author,
                    })
                    .pipe(
                      Effect.map((result) => ({
                        value: { post: result.value },
                      })),
                    ),
                )
                : yield* enqueue(
                  context,
                  home,
                  workItem("post", post.postId, canvas, nodeId),
                  {
                    operation: "board.post.append",
                    post,
                    createdBy: author,
                  },
                  { post },
                );
            return yield* complete(canvas, outcome);
          }),
        ),

      workBoardMarkRead: (canvas, nodeId, topicId, principalKey, upToPosition) =>
        asResult(
          Effect.gen(function* () {
            const snap = yield* repository
              .readSnapshot(canvas, nodeId)
              .pipe(Effect.mapError(toWorkServiceError));
            const topic = snap.board.topics.find((t) => t.topicId === topicId);
            if (!topic) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "task_not_found",
                  message: `topic "${topicId}" not found`,
                }),
              );
            }
            const maxPos =
              upToPosition ??
              Math.max(
                -1,
                ...(topic.posts ?? []).map((p) => p.position),
                topic.postCount - 1,
              );
            const outcome = yield* local(
              repository
                .markBoardRead({
                  sink: sinkRef(canvas, nodeId),
                  topicId,
                  principalKey,
                  lastReadPosition: maxPos,
                })
                .pipe(Effect.map(() => ({ value: { topicId } }))),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workPadRead: (canvas, nodeId, pinId) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readCanvas(canvas);
            const node = read.doc.nodes.find((n) => n.id === nodeId);
            if (node?.ether?.entity?.kind !== "pad") {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message: `node "${nodeId}" is not a pad sink`,
                }),
              );
            }
            const pad = yield* repository
              .readPad(canvas, nodeId)
              .pipe(Effect.mapError(toWorkServiceError));
            const digest = padToDigest(pad);
            const svg = padToSvg(pad, "dark");
            let lookHere: import("@shared/pad-project").PadLookHere | undefined;
            if (pinId !== undefined) {
              const focused = padLookHere(pad, pinId);
              if (Result.isFailure(focused)) {
                return yield* Effect.fail(
                  new WorkServiceError({
                    code: "invalid",
                    message: focused.failure.message,
                  }),
                );
              }
              lookHere = focused.success;
            }
            const outcome = yield* local(
              Effect.succeed({
                value: {
                  revision: pad.revision,
                  pad,
                  digest,
                  svg,
                  ...(lookHere === undefined ? {} : { lookHere }),
                },
              }),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      workPadPatch: (canvas, nodeId, patches, author) =>
        asResult(
          Effect.gen(function* () {
            const [context, read] = yield* Effect.all([
              stationContext,
              readCanvas(canvas),
            ]);
            if (
              read.doc.nodes.find((n) => n.id === nodeId)?.ether?.entity
                ?.kind !== "pad"
            ) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message: `node "${nodeId}" is not a pad sink`,
                }),
              );
            }
            const stamped = stampPadPatchAuthors(patches, author);
            const rule = padAuthorRuleError(
              author,
              stamped,
              inboundActorNodeIds(read.doc, nodeId),
            );
            if (rule !== undefined) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: rule,
                }),
              );
            }
            const materialized = yield* externalizePadPatches(
              stamped,
              canvas,
              nodeId,
            );
            const home =
              context.configuration.role === "command-center"
                ? context.localInstallationId
                : context.configuration.commandCenterInstallationId;
            const patchId = ids.id();
            const current = yield* repository
              .readPad(canvas, nodeId)
              .pipe(Effect.mapError(toWorkServiceError));
            const addedMentions = addedPadMentions(current, materialized);
            const outcome =
              home === context.localInstallationId
                ? yield* local(
                  repository
                    .applyPadPatch({
                      sink: sinkRef(canvas, nodeId),
                      basis: intentBasis(context, read.intentWitness),
                      patchId,
                      patches: materialized,
                      author,
                    })
                    .pipe(
                      Effect.map((result) => ({
                        value: {
                          revision: result.value.revision,
                          pad: result.value,
                          digest: padToDigest(result.value),
                        },
                      })),
                    ),
                )
                : yield* enqueue(
                  context,
                  home,
                  workItem("pad", patchId, canvas, nodeId),
                  {
                    operation: "pad.patch",
                    patchId,
                    patches: [...materialized],
                    author,
                  },
                  {
                    revision: current.revision,
                    pad: current,
                    digest: padToDigest(current),
                  },
                );
            if (
              home === context.localInstallationId &&
              addedMentions.length > 0
            ) {
              const actors = resolvePadInboundActors(read.doc, nodeId);
              const notifyIds = new Set(
                tagNotifyNodeIds(
                  addedMentions,
                  actors,
                  author.kind === "actor" ? author.nodeId : undefined,
                ),
              );
              const seats = resolveBoardWakeSet(read.doc, nodeId).filter(
                (seat) => notifyIds.has(seat.nodeId),
              );
              if (seats.length > 0) {
                const reply = materialized.find((patch) => patch.op === "pin.reply");
                const excerpt =
                  reply?.op === "pin.reply"
                    ? reply.post.parts
                      .flatMap((part) =>
                        part.kind === "text" ? [part.text] : [],
                      )
                      .join("\n")
                    : "look here";
                const pinId =
                  materialized.find((patch) => patch.op === "pin.upsert")?.pin.id ??
                  (reply?.op === "pin.reply" ? reply.pinId : "pin");
                void softBoardTagNotify({
                  canvas,
                  boardNodeId: nodeId,
                  seats,
                  topicId: pinId,
                  postId: pinId,
                  excerpt,
                  authorLabel:
                    author.label ?? author.nodeId ?? "someone",
                }).catch(() => undefined);
              }
            }
            return yield* complete(canvas, outcome);
          }),
        ),

      workPadMarkRead: (canvas, nodeId, pinId, principalKey) =>
        asResult(
          Effect.gen(function* () {
            const pad = yield* repository
              .readPad(canvas, nodeId)
              .pipe(Effect.mapError(toWorkServiceError));
            const pin = pad.pins.find((item) => item.id === pinId);
            if (!pin) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: `pin "${pinId}" does not exist`,
                }),
              );
            }
            const outcome = yield* local(
              repository
                .markPadRead({
                  sink: sinkRef(canvas, nodeId),
                  pinId,
                  principalKey,
                  lastReadPosition: Math.max(-1, pin.posts.length - 1),
                })
                .pipe(Effect.map(() => ({ value: { pinId } }))),
            );
            return yield* complete(canvas, outcome);
          }),
        ),

      commandStatus,
    });
  }),
);
