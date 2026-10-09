import { ModelNotFound, ModelRecords } from "../model/records";
import type { KernelWork } from "@shared/work-kernel";
export type { KernelWork } from "@shared/work-kernel";
import { asCanvasName, asNodeId, taskBoardTitle, type Canvas, type Node, type SheetGrid } from "@shared/model";
// WorkService — one repository-native orchestration seam for the SQLite work
// plane. Typed canvas rows supply topology;
// every durable mutation goes through a specific WorkRepository verb.
// Canonical Tasks vocabulary: boards, rules, claims, checks, visits, defects,
// admission (auto/approval/operator), and wait.

import {
  Context,
  Effect,
  Layer,
  Match,
  Result,
  Schema,
} from "effect";
import type {
  Artifact,
  Message,
  Part,
  Task,
  TaskState,
  WorkMetadata,
} from "@shared/work-model";
import { type Pad, type PadPatch } from "@shared/pad";
import { padLookHere, padToDigest, padToSvg } from "@shared/pad-project";
import {
  resolvePadInboundActors,
  tagNotifyNodeIds,
} from "@shared/board-actors";
import { resolveBoardWakeSet } from "@shared/board-wake";
import { ModelService } from "../model/service";
import { ModelActorRefs } from "../model/actor-refs";
import { SqlClient } from "effect/unstable/sql";
import { withSqlRead } from "../state/sql-read";
import {
  addedPadMentions,
  inboundActorNodeIds,
  padAuthorRuleError,
  stampPadPatchAuthors,
} from "./pad-rules";
import { softBoardTagNotify } from "./board-delivery";
import type {
  CheckResult,
  CompletionEvidence,
  FinishCriteria,
  TaskPathArm,
  TaskRule,
  Visit,
  VisitExit,
} from "@shared/work-model";
import { CHECK_OUTPUT_TAIL_MAX_BYTES } from "@shared/work-model";
import type { WorkSeatRecentOpsFeed } from "@shared/work-recent-ops";
import type { ContentPart } from "@shared/content";
import type {
  InstallationId as InstallationIdValue,
} from "@shared/installation-id";
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
  type WorkPolicyRead,
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
  boardContractOf,
  claimedAtBoard,
  claimsRecorded,
  effectiveTaskAdmission,
  evaluateChecks,
  evaluateForkWaivers,
  evaluateRules,
  evaluateTerminalClose,
  requiredChecks,
  regionContractOf,
  rulesInForce,
  taskAdmissionState,
  taskApproved,
  taskEpoch,
  type RuleInForce,
  type RuleProvenance,
} from "@shared/rules";
import {
  capOutputTail,
  resolveCheckPlan,
  type CheckPlanItem,
  type CheckSubmissionResult,
} from "@shared/checks";
import { WorkErrorDetails, type VerdictPostArgs, type WorkErrorBody } from "@shared/work-control";
import type { MailSenderStamp, ReviewVerdict, VerdictSubject } from "@shared/crew";
import { flowDestinations } from "@shared/flow-graph";
import { regionStack } from "@shared/model/canvas";
import { taskCommentRecipient } from "@shared/task-owner";
import { makeUserMessage, isTerminalTaskState } from "@shared/task";
import type { Ruling } from "@shared/work-model";
import { operatorActorRef } from "@shared/work-reference";
import type {
  ActorRef,
  IntentFactBasis as IntentFactBasisValue,
  WorkItemRef,
} from "@shared/work-protocol";
import { IntentFactBasis } from "@shared/work-protocol";
import { ulid } from "ulid";
import { MachineRepository } from "../machines/repository";
import { ContentService } from "../content/service";
import type { ContentOwner } from "../content/manifest";
import {
  admitLiveOverseer,
  admitOverseerWorkTarget,
  admitWorkTarget,
  regionStackFor,
  type OverseerWorkAdmin,
} from "./authz";

export type { OverseerWorkAdmin };
import {
  mailboxMessageReactId,
  mailboxMessageReadId,
} from "./mailbox-receipts";
import { messageDelivery } from "./message-delivery";
import { CrewRepository } from "./crew-repository";
import {
  evaluateReviewGate,
  planVerdictPost,
  resolveTaskSubject,
  reviewAuthorSeat,
  reviewSubjectProjection,
  reviewersOfAuthor,
  reviewsEdgeExists,
  type ReviewGateResult,
  type ReviewSubjectProjection,
  type ResolvedReviewSubject,
} from "./reviews";

import {
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryError,
  createCanvasTaskDependencyScopeCapability,
  type ReviewGateWithin,
  type ReviewReceiptRecord,
  type TaskDependencyScopeCapability,
  type TaskRecordPatch,
} from "./repository";

/**
 * Work-service error codes. The legacy seven stay; the canonical domain codes
 * (tasks-consolidation plan B3) carry structured facts so the control plane
 * maps deterministically without parsing message text.
 */
export const WorkServiceErrorCode = Schema.Literals([
  "canvas_not_found",
  "node_not_found",
  "task_not_found",
  "illegal_kind",
  "illegal_transition",
  "claim_contention",
  "invalid",
  "not_ready",
  "unadmitted",
  "fork_choice",
  "wrong_home",
  "operator_owned",
  "reviewer_is_author",
  "scope_error",
]);
export type WorkServiceErrorCode = typeof WorkServiceErrorCode.Type;

export class WorkServiceError extends Schema.TaggedError<WorkServiceError>()(
  "WorkServiceError",
  {
    code: WorkServiceErrorCode,
    message: Schema.String,
    /** Structured facts for the control plane; never parsed out of message. */
    details: Schema.optionalKey(WorkErrorDetails),
  },
) {}

export type WorkOpResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly disposition: "applied" | "queued";
      /** Human-readable context for an idempotent or otherwise notable mutation. */
      readonly message?: string;
    }
  | {
      readonly ok: false;
      readonly code: WorkServiceErrorCode;
      readonly message: string;
      readonly details?: WorkErrorDetails;
    };

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
        // The repository refuses a mutation because this installation does
        // not own the row — a structured wrong-home fact, not a generic
        // invalid. Causal/identity/target conflicts stay invalid.
        case "authority-mismatch":
          return "wrong_home" as const;
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
  if (error instanceof ModelNotFound) {
    return new WorkServiceError({
      code: error.what === "canvas" ? "canvas_not_found" : "node_not_found",
      message: `${error.what} "${error.id}" not found`,
    });
  }

  return new WorkServiceError({
    code: "invalid",
    message: error instanceof Error ? error.message : String(error),
  });
};

const reviewServiceError = (error: WorkErrorBody): WorkServiceError =>
  new WorkServiceError({
    code: error.type === "ReviewerIsAuthor"
      ? "reviewer_is_author"
      : error.type === "ScopeError"
        ? "scope_error"
        : "invalid",
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  });

type WorkMutationOutcome<T> = {
  readonly value: T;
  readonly disposition: "applied" | "queued";
  readonly message?: string;
};

type WorkApplyOk<T> = WorkMutationOutcome<T>;

const asResult = <T>(
  effect: Effect.Effect<WorkApplyOk<T>, WorkServiceError>,
): Effect.Effect<WorkOpResult<T>> =>
  effect.pipe(
    Effect.map(
      ({ value, disposition, message }): WorkOpResult<T> => ({
        ok: true,
        data: value,
        disposition,
        ...(message === undefined ? {} : { message }),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }),
    ),
  );

type InstallationContext = {
  readonly localInstallationId: InstallationIdValue;
};

/** One board a task has been through, as shown by tasks.show. */
export type WorkTaskVisitView = {
  readonly boardId: string;
  readonly board: string;
  readonly enteredAt: string;
  readonly epoch: number;
  readonly claimedBy?: string;
  readonly exitedAt?: string;
  readonly exit?: VisitExit;
  readonly next?: string;
  readonly nextBoard?: string;
  readonly handoffNote?: string;
  /** Refs cited by that board's claims (onion-visible). */
  readonly refs: ReadonlyArray<string>;
  /** Operator view only: the board row's full completion evidence. */
  readonly evidence?: CompletionEvidence;
};

export type WorkTaskShowView = {
  readonly task: Task;
  readonly reviewSubject: ReviewSubjectProjection;
  readonly verdicts: ReadonlyArray<ReviewVerdict>;
  readonly board: {
    readonly nodeId: string;
    readonly name: string;
  };
  readonly visits: ReadonlyArray<WorkTaskVisitView>;
  /** Rules in force at this board for this task (regions outer to inner, board, task). */
  readonly rules: ReadonlyArray<RuleInForce>;
  readonly ambient: {
    readonly regions: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly instruction?: string;
    }>;
    readonly boardInstructions?: string;
    readonly incoming?: {
      readonly handling?: string;
      readonly description?: string;
    };
    readonly outgoing?: {
      readonly handoff?: string;
      readonly description?: string;
    };
  };
};

/** A check the agent must run before sending on, with its current-epoch status. */
export type WorkCheckReadiness = CheckPlanItem & {
  readonly status: "green" | "red" | "missing" | "stale";
};

export type WorkTaskRulesView = {
  readonly rules: ReadonlyArray<RuleInForce>;
  readonly readiness?: {
    readonly review: ReviewGateResult;
    /** Rules still lacking a live claim or waiver. */
    readonly unanswered: ReadonlyArray<{
      readonly ruleId: string;
      readonly text: string;
      readonly provenance: RuleProvenance;
    }>;
    /** Applicable checks per next board for the current epoch. */
    readonly checks: ReadonlyArray<{
      readonly destination: string;
      readonly checks: ReadonlyArray<WorkCheckReadiness>;
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

const sameActor = (left: ActorRef, right: ActorRef): boolean =>
  left.seatId === right.seatId &&
  left.canvasName === right.canvasName &&
  left.nodeId === right.nodeId;

const nodeById = (
  doc: Canvas,
  nodeId: string,
): Node | undefined =>
  doc.nodes.get(asNodeId(nodeId));

const taskIdentity = (node: Node | undefined, id: string) => taskBoardTitle(node?.kind === "task" ? node : undefined, id);
const taskName = (node: Node | undefined, id: string) => taskIdentity(node, id).name;

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
    readonly workVerdictPost: (
      canvas: string,
      target: string,
      input: Omit<VerdictPostArgs, "target">,
      reviewer: ActorRef,
    ) => Effect.Effect<WorkOpResult<WorkVerdictPostResult>>;
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
      rules?: ReadonlyArray<TaskRule>,
      options?: WorkTaskCreateOptions,
      admin?: OverseerWorkAdmin,
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
      path?: TaskPathArm,
      receiptAuthor?: MailSenderStamp,
    ) => Effect.Effect<WorkOpResult<Task>>;
    /** Operator approval of an approval-admission task (epoch-scoped stamp). */
    readonly workTaskPromote: (
      canvas: string,
      nodeId: string,
      taskId: string,
      note?: string,
      admin?: OverseerWorkAdmin,
    ) => Effect.Effect<WorkOpResult<Task>>;
    /**
     * Task record with visits. Seat view is onion-scoped: prior boards expose
     * handoff notes and cited refs, never their interiors; the operator view
     * exposes everything.
     */
    readonly workTaskShow: (
      canvas: string,
      nodeId: string,
      taskId: string,
      view: "seat" | "operator",
    ) => Effect.Effect<WorkTaskShowView, WorkServiceError>;
    /** Rules in force at a board with provenance; readiness when a task is named. */
    readonly workTaskRules: (
      canvas: string,
      nodeId: string,
      taskId?: string,
    ) => Effect.Effect<WorkTaskRulesView, WorkServiceError>;
    /** Pinned rulings across the node's region stack, outer to inner. */
    readonly workRulingsList: (
      canvas: string,
      nodeId: string,
    ) => Effect.Effect<WorkRulingsView, WorkServiceError>;
    /**
     * Record seat-submitted check runs as current-epoch CheckResults. The CLI
     * executes the check commands in the seat's own environment; this service
     * only validates results against the applicable checks and stamps them.
     * Checks are never accepted through any other op.
     */
    readonly workTaskCheck: (
      canvas: string,
      nodeId: string,
      taskId: string,
      results: ReadonlyArray<CheckSubmissionResult>,
      next?: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskRespond: (
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "working" | "rejected",
      admin?: OverseerWorkAdmin,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskClaim: (
      canvas: string,
      nodeId: string,
      taskId: string,
      actor: ActorRef,
      admin?: OverseerWorkAdmin,
    ) => Effect.Effect<WorkOpResult<Task>>;
    /** Command Center operator comment on the canonical task thread. */
    readonly workTaskComment: (
      canvas: string,
      nodeId: string,
      taskId: string,
      message: Message,
      admin?: OverseerWorkAdmin,
    ) => Effect.Effect<WorkOpResult<Message>>;
    readonly listTopologies: (canvasName?: string) => Effect.Effect<ReadonlyArray<Canvas>, WorkServiceError>;
    readonly subscribeTopologyChanges: (listener: (canvasName: string) => void) => () => void;
    readonly subscribeWorkChanges: (listener: (canvasName?: string, nodeId?: string) => void) => () => void;
    readonly readKernelWork: (canvas: string) => Effect.Effect<KernelWork, WorkServiceError>;
    readonly readArtifacts: (canvas: string, nodeId: string) => Effect.Effect<ReadonlyArray<Artifact>, WorkServiceError>;
    readonly readArtifact: (canvas: string, nodeId: string, id: string) => Effect.Effect<Artifact | undefined, WorkServiceError>;
    readonly readSheet: (canvas: string, nodeId: string) => Effect.Effect<SheetGrid | undefined, WorkServiceError>;
    readonly readTopology: (canvas: string) => Effect.Effect<{ readonly canvas: Canvas; readonly actorRefs: ReadonlyArray<ActorRef> }, WorkServiceError>;
    readonly readTask: (canvas: string, nodeId: string, id: string, kind?: "task" | "requests") => Effect.Effect<Task | undefined, WorkServiceError>;
    readonly readTasks: (canvas: string, nodeId: string, kind?: "task" | "requests") => Effect.Effect<ReadonlyArray<Task>, WorkServiceError>;
    readonly readMailbox: (canvas: string, nodeId: string) => Effect.Effect<ReadonlyArray<Message>, WorkServiceError>;
    readonly readMailMessage: (canvas: string, nodeId: string, messageId: string) => Effect.Effect<Message | undefined, WorkServiceError>;
    readonly workMessageAppend: (
      canvas: string,
      nodeId: string,
      taskId: string | null,
      message: Message,
      sentBy: ActorRef,
      admin?: OverseerWorkAdmin,
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
      admin?: OverseerWorkAdmin,
    ) => Effect.Effect<WorkOpResult<{ readonly messageId: string; readonly readAt: string }>>;
    readonly workMessageReact: (
      canvas: string,
      nodeId: string,
      messageId: string,
      reaction: "ack",
      reactor: ActorRef,
      admin?: OverseerWorkAdmin,
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
      admin?: OverseerWorkAdmin,
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
      admin?: OverseerWorkAdmin,
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
      admin?: OverseerWorkAdmin,
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
}

export type WorkService = WorkServiceId;

export type WorkVerdictPostResult = {
  readonly verdictId: string;
  readonly subject: VerdictSubject;
  readonly epoch: number;
  readonly authorSeatId: ReviewVerdict["authorSeatId"];
  readonly effect: "none" | "rejected";
  readonly newEpoch?: number;
};

export const WorkService = Context.Service<WorkService, WorkServiceShape>("@junto/WorkService");

export const WorkLive = Layer.effect(
  WorkService,
  Effect.gen(function* () {
    const model = yield* ModelService;
    const modelActors = yield* ModelActorRefs;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* WorkRepository;
    const modelRecords = yield* ModelRecords;
    const crew = yield* CrewRepository;
    const machines = yield* MachineRepository;
    // S2: ContentService is a hard WorkLive dependency (both CC + Remote graphs
    // compose it — runtime.ts / core-runtime.ts). Hard yield*, never
    // serviceOption: a missing ContentService must fail layer build, not soft-
    // degrade claim/media as "unavailable". Closed over for media claim gate +
    // raw externalize (methods stay R=never). Kernel still runs via warm
    // Runtime.runPromise so other ambient lookups cannot reintroduce the
    // empty-Context class of bug.
    const contentService = yield* ContentService;
    const ids = defaultIds();

    const installationContext: Effect.Effect<InstallationContext, WorkServiceError> =
      machines.installationId.pipe(
        Effect.mapError(toWorkServiceError),
        Effect.map((localInstallationId) => ({ localInstallationId })),
      );

    const readTopology = Effect.fn("WorkService.readTopology")(function* (canvasName: string) {
      return yield* withSqlRead(sql, Effect.gen(function* () {
        const topology = yield* model.canvas(canvasName);
        return { topology, actorRefs: yield* modelActors.read(canvasName),
          intentWitness: { canvasName, seq: topology.seq } };
      })).pipe(Effect.mapError(toWorkServiceError));
    });

    const readItem = (canvasName: string, nodeId: string, itemId: string, kind: "task" | "requests" = "task") =>
      repository.taskItem({ canvasName, nodeId, itemId, kind }).pipe(Effect.mapError(toWorkServiceError));

    const policyRows = Effect.fn("WorkService.policyRows")(function* (
      canvasName: string, nodeId: string, ids: ReadonlyArray<string>, artifactIds: ReadonlyArray<string> = [],
      kind: "task" | "requests" = "task",
    ): Effect.fn.Return<WorkPolicyRead, WorkServiceError> {
      const selectedTaskIds = kind === "task" ? ids : [];
      const rows = yield* repository.taskRowsByIds(canvasName, selectedTaskIds).pipe(Effect.mapError(toWorkServiceError));
      const dependencies = [...new Set(rows.flatMap(({ item }) => item.dependsOn ?? []))].filter((id) => !ids.includes(id));
      const deps = yield* repository.taskRowsByIds(canvasName, dependencies).pipe(Effect.mapError(toWorkServiceError));
      const tasks = new Map<string, Task[]>();
      for (const row of [...rows, ...deps]) {
        const items = tasks.get(row.nodeId) ?? [];
        items.push(row.item); tasks.set(row.nodeId, items);
      }
      const requests = yield* Effect.forEach(kind === "requests" ? ids : [], (id) => readItem(canvasName, nodeId, id, "requests"));
      const artifacts = yield* Effect.forEach(artifactIds, (id) => repository.artifactItem(canvasName, nodeId, id).pipe(Effect.mapError(toWorkServiceError)));
      return {
        itemsOf: (board) => tasks.get(board) ?? [],
        taskAt: (board, id) => tasks.get(board)?.find((task) => task.id === id),
        requestItemsOf: (board) => board === nodeId ? requests.filter((item): item is Task => item !== undefined) : [],
        artifactsOf: (board) => board === nodeId ? artifacts.filter((item): item is Artifact => item !== undefined) : [],
        artifactsByNode: new Map(),
      };
    });

    const intentBasis = (witness: { canvasName: string; seq: number }): IntentFactBasisValue =>
      Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })(
        { kind: "canvas", canvasName: witness.canvasName, seq: witness.seq });

    const taskDependencyScopeCapability = (
      canvasName: string,
      nodeId: string,
      basis: IntentFactBasisValue,
    ): Effect.Effect<TaskDependencyScopeCapability, WorkServiceError> =>
      Effect.gen(function* () {
        const header = yield* modelRecords.getCanvas(canvasName).pipe(Effect.mapError(toWorkServiceError));
        if (basis.kind !== "canvas" || basis.canvasName !== canvasName || basis.seq !== header?.seq) return yield* new WorkServiceError({ code: "invalid", message: "task topology changed after its canvas read" });
        const [nodes, wires] = yield* Effect.all([modelRecords.listNodes(canvasName), modelRecords.listWires(canvasName)]).pipe(Effect.mapError(toWorkServiceError));
        const canvas: Canvas = { name: asCanvasName(canvasName), seq: header!.seq, nodes: new Map(nodes.map((node) => [node.id, node])), wires: new Map(wires.map((wire) => [wire.id, wire])) };
        return yield* Effect.try({ try: () => createCanvasTaskDependencyScopeCapability({ canvas, authoringSink: sinkRef(canvasName, nodeId) }), catch: toWorkServiceError });
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

    const complete = <T>(outcome: WorkMutationOutcome<T>): Effect.Effect<WorkApplyOk<T>> => Effect.succeed(outcome);

    const reviewForTask = (
      read: { readonly topology: Canvas; readonly actorRefs: ReadonlyArray<ActorRef> },
      canvas: string,
      nodeId: string,
      task: Task,
      installationId: string,
    ) => Effect.gen(function* () {
      const currentRules = rulesInForce(read.topology, nodeId, task);
      const rules: ReadonlyArray<RuleInForce> = flowDestinations(read.topology, nodeId).length > 0
        ? currentRules
        : [
            ...currentRules,
            ...(task.rules ?? [])
              .filter((rule) => rule.kind === "requires-review" && rule.board !== nodeId)
              .map((rule): RuleInForce => ({ rule, provenance: { kind: "task", board: rule.board } })),
          ];
      const projection = reviewSubjectProjection({
        installationId,
        canvasName: canvas,
        nodeId,
        task,
      });
      const verdicts = yield* crew.verdictsForSubject({
        kind: "task",
        installationId,
        canvasName: canvas,
        nodeId,
        taskId: task.id,
      }).pipe(Effect.mapError(toWorkServiceError));
      const author = read.actorRefs.find((actor) => actor.seatId === projection.authorSeatId);
      const reviewers = author === undefined ? [] : reviewersOfAuthor({
        doc: read.topology,
        authorNodeId: author.nodeId,
        actorRefs: read.actorRefs,
      });
      const gate = evaluateReviewGate({
        rulesInForce: rules,
        projection,
        verdicts,
        authorSeatId: projection.authorSeatId,
        reviewerHasCurrentEdge: (seatId) => reviewers.some((reviewer) => reviewer.seatId === seatId),
      });
      return { projection, verdicts, gate, rules };
    });

    const requireNode = (
      doc: Canvas,
      nodeId: string,
    ): Effect.Effect<Node, WorkServiceError> => {
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

    const requireLiveOverseer = (
      admin: OverseerWorkAdmin,
    ): Effect.Effect<ActorRef, WorkServiceError> =>
      readTopology(admin.actor.canvasName).pipe(
        Effect.flatMap((origin) => {
          const admitted = admitLiveOverseer(
            origin.topology,
            origin.actorRefs,
            { canvasName: admin.actor.canvasName, nodeId: admin.actor.nodeId },
            admin,
          );
          if (Result.isFailure(admitted)) {
            return Effect.fail(
              new WorkServiceError({
                code: "invalid",
                message: admitted.failure.message,
                details: admitted.failure.details,
              }),
            );
          }
          return Effect.succeed(admitted.success);
        }),
      );

    const requireExactActorNode = (
      actor: ActorRef,
    ): Effect.Effect<Node, WorkServiceError> =>
      readTopology(actor.canvasName).pipe(
        Effect.flatMap((origin) => {
          const exact = origin.actorRefs.filter((candidate) =>
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
          const actorNode = nodeById(origin.topology, actor.nodeId);
          return actorNode === undefined
            ? Effect.fail(
              new WorkServiceError({
                code: "node_not_found",
                message: `actor node "${actor.nodeId}" not found`,
              }),
            )
            : Effect.succeed(actorNode);
        }),
      );

    const requireActor = (
      read: { readonly topology: Canvas; readonly actorRefs: ReadonlyArray<ActorRef> },
      actor: ActorRef,
      targetNodeId: string,
      op:
        | "tasks.create"
        | "tasks.claim"
        | "msg.send"
        | "msg.read"
        | "msg.reply"
        | "msg.react"
        | "artifact.publish",
      admin?: OverseerWorkAdmin,
    ): Effect.Effect<Node, WorkServiceError> => {
      if (admin !== undefined) {
        return requireLiveOverseer(admin).pipe(
          Effect.flatMap((live) => {
            const overseerTarget = admitOverseerWorkTarget(
              read.topology,
              targetNodeId,
              op,
            );
            if (Result.isFailure(overseerTarget)) {
              return Effect.fail(
                new WorkServiceError({
                  code:
                    overseerTarget.failure.type === "UnknownTarget"
                      ? "node_not_found"
                      : "invalid",
                  message: overseerTarget.failure.message,
                }),
              );
            }
            if (op !== "tasks.claim" && !sameActor(live, actor)) {
              return Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "overseer admin actor does not match the acting seat",
                }),
              );
            }
            // Administrative authorization is the live overseer. Residency and
            // claim routing use the acting seat's exact ActorRef/node, never
            // the overseer's installation as a stand-in.
            return requireExactActorNode(actor);
          }),
        );
      }
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
        const actorNode = nodeById(read.topology, actor.nodeId);
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
        read.topology,
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
      const actorNode = nodeById(read.topology, actor.nodeId);
      return actorNode === undefined
        ? Effect.fail(
          new WorkServiceError({
            code: "node_not_found",
            message: `actor node "${actor.nodeId}" not found`,
          }),
        )
        : Effect.succeed(actorNode);
    };

    const beforeCommit = (
      admin?: OverseerWorkAdmin,
    ): Effect.Effect<ActorRef | undefined, WorkServiceError> =>
      admin === undefined
        ? Effect.succeed(undefined)
        : requireLiveOverseer(admin).pipe(
          Effect.map((live): ActorRef | undefined => live),
        );

    const local = <T>(
      effect: Effect.Effect<
        { readonly value: T; readonly reviewReceipts?: ReadonlyArray<ReviewReceiptRecord> },
        unknown
      >,
      admin?: OverseerWorkAdmin,
    ): Effect.Effect<WorkMutationOutcome<T>, WorkServiceError> =>
      beforeCommit(admin).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.mapError(toWorkServiceError),
            Effect.tap(({ reviewReceipts }) => reviewReceipts === undefined
              ? Effect.void
              : Effect.sync(() => {
                  for (const receipt of reviewReceipts) {
                    messageDelivery.notifyAppended(receipt.canvas, receipt.nodeId, receipt.message);
                  }
                })),
            Effect.map(({ value }) => ({
              value,
              disposition: "applied" as const,
            })),
          ),
        ),
      );

    const itemHome = (
      lane: "task" | "request",
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

    const planWorkVerdict = (
      canvas: string,
      target: string,
      input: Omit<VerdictPostArgs, "target">,
      reviewer: ActorRef,
    ) => Effect.gen(function* () {
      const [context, read] = yield* Effect.all([installationContext, readTopology(canvas)]);
      if (reviewer.canvasName !== canvas ||
        read.actorRefs.filter((actor) => sameActor(actor, reviewer)).length !== 1) {
        return yield* new WorkServiceError({
          code: "scope_error",
          message: "reviewer no longer identifies a live actor seat on this canvas",
          details: { reason: "reviewer-not-current", retryable: false },
        });
      }
      let subject: ResolvedReviewSubject;
      let authorNodeId: string | undefined;
      if (input.subject.kind === "task") {
        const expected = input.subject;
        const node = yield* requireNode(read.topology, target);
        const task = yield* readItem(canvas, target, expected.taskId);
        if (task === undefined) {
          return yield* new WorkServiceError({
            code: "task_not_found",
            message: `task "${input.subject.taskId}" not found at "${target}"`,
          });
        }
        const home = yield* itemHome("task", canvas, target, task.id);
        if (home !== context.localInstallationId) {
          return yield* new WorkServiceError({
            code: "wrong_home",
            message: "review verdicts execute on the task home installation",
          });
        }
        const projection = reviewSubjectProjection({
          installationId: home,
          canvasName: canvas,
          nodeId: target,
          task,
        });
        const resolved = resolveTaskSubject({ projection, expected: input.subject });
        if (!resolved.ok) return yield* reviewServiceError(resolved.error);
        subject = resolved.subject;
        authorNodeId = read.actorRefs.find((actor) => actor.seatId === projection.authorSeatId)?.nodeId;
      } else {
        const sha = input.subject.sha.trim().toLowerCase();
        const authorSeatId = yield* crew.firstAuthorForSha(sha).pipe(Effect.mapError(toWorkServiceError));
        const author = read.actorRefs.find((actor) => actor.nodeId === target);
        if (authorSeatId !== undefined && author?.seatId !== authorSeatId) {
          return yield* new WorkServiceError({
            code: "scope_error",
            message: "commit target does not match its durable author provenance",
            details: { reason: "commit-author-mismatch", retryable: false },
          });
        }
        subject = {
          kind: "commit",
          sha,
          ...(authorSeatId !== undefined && author !== undefined ? { authorSeatId: author.seatId } : {}),
        };
        authorNodeId = author?.nodeId;
      }
      const plan = planVerdictPost({
        caller: { seatId: reviewer.seatId, nodeId: reviewer.nodeId },
        subject,
        kind: input.kind,
        findings: input.findings ?? [],
        refs: input.refs ?? [],
        reviewsEdgeCurrent: authorNodeId !== undefined && reviewsEdgeExists(read.topology, reviewer.nodeId, authorNodeId),
        verdictId: ids.id(),
        postedAtMs: Date.now(),
      });
      if (!plan.ok) return yield* reviewServiceError(plan.error);
      return { context, read, plan };
    });

    return WorkService.of({
      listTopologies: (canvasName) => withSqlRead(sql, Effect.gen(function* () {
        const names = canvasName === undefined ? yield* model.listCanvases() : [canvasName];
        return yield* Effect.forEach(names, (name) => model.canvas(name));
      })).pipe(Effect.mapError(toWorkServiceError)),
      subscribeTopologyChanges: (listener) => {
        const offChanges = model.subscribeChanges((event) => listener(event.canvas));
        const offCanvases = model.subscribeCanvasesChanges((event) => listener(event.canvas));
        return () => { offChanges(); offCanvases(); };
      },
      subscribeWorkChanges: (listener) => repository.subscribeChanges((canvas, nodeId, kind) => {
        if (kind !== "mail") listener(canvas, nodeId);
      }),
      readKernelWork: (canvas) => repository.kernelWork(canvas).pipe(Effect.mapError(toWorkServiceError)),
      readArtifacts: (canvas, nodeId) => repository.artifactLane(canvas, nodeId).pipe(Effect.mapError(toWorkServiceError)),
      readArtifact: (canvas, nodeId, id) => repository.artifactItem(canvas, nodeId, id).pipe(Effect.mapError(toWorkServiceError)),
      readSheet: (canvas, nodeId) => model.readSheet(canvas, nodeId).pipe(Effect.mapError(toWorkServiceError)),
      readTopology: (canvas) => readTopology(canvas).pipe(Effect.map((read) => ({ canvas: read.topology, actorRefs: read.actorRefs }))),
      readTask: readItem,
      readTasks: (canvas, nodeId, kind = "task") => repository.taskLane(canvas, nodeId, kind).pipe(Effect.mapError(toWorkServiceError)),
      readMailbox: (canvas, nodeId) => repository.mailbox(canvas, nodeId).pipe(Effect.mapError(toWorkServiceError)),
      readMailMessage: (canvas, nodeId, messageId) => repository.mailMessage(canvas, nodeId, messageId).pipe(Effect.mapError(toWorkServiceError)),
      workVerdictPost: (canvas, target, input, reviewer) =>
        asResult(
          Effect.gen(function* () {
            const { read, plan } = yield* planWorkVerdict(canvas, target, input, reviewer);
            const result: WorkVerdictPostResult = {
              verdictId: plan.verdict.verdictId,
              subject: plan.verdict.subject,
              epoch: plan.verdict.epoch,
              authorSeatId: plan.verdict.authorSeatId,
              effect: "none",
            };
            if (plan.effect.kind === "blocking" && plan.verdict.subject.kind === "task") {
              const subject = plan.verdict.subject;
              const defect = plan.effect.defect;
              const policyWork = yield* policyRows(canvas, target, [subject.taskId]);
              const policy = yield* runPolicy(() => workTaskTransition(policyWork, read.topology,
                canvas,
                target,
                subject.taskId,
                "rejected",
                undefined,
                ids,
                undefined,
                { defect },
              ));
              if (policy.sentBack === undefined) {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message: "blocking review did not produce a task defect transition",
                });
              }
              const before = policyWork.taskAt(target, subject.taskId);
              const message = before !== undefined && policy.task.history.length > before.history.length
                ? policy.task.history.at(-1)
                : undefined;
              const moved = yield* repository.sendTaskBack({
                sink: sinkRef(canvas, target),
                basis: intentBasis(read.intentWitness),
                taskId: subject.taskId,
                ...(message === undefined ? {} : { message }),
                visits: policy.task.visits ?? [],
                ...(policy.task.defects === undefined ? {} : { defects: policy.task.defects }),
                target: sinkRef(canvas, policy.sentBack.nodeId),
                sentBackTask: policy.sentBack.task,
                review: { verdict: plan.verdict },
              }).pipe(Effect.mapError(toWorkServiceError));
              return yield* complete({
                value: { ...result, effect: "rejected" as const, newEpoch: taskEpoch(moved.value.sentBack) },
                disposition: "applied",
              });
            }
            const posted = yield* repository.postReviewVerdict(plan.verdict, {
              basis: intentBasis(read.intentWitness),
              canvasName: canvas,
            }).pipe(Effect.mapError(toWorkServiceError));
            if ("rejected" in posted) {
              return yield* new WorkServiceError({
                code: posted.rejected === "reviewer-is-author"
                  ? "reviewer_is_author"
                  : posted.rejected === "reviews-edge-missing"
                    ? "scope_error"
                    : "invalid",
                message: `review verdict refused at write: ${posted.rejected}`,
                details: { reason: posted.rejected, retryable: posted.rejected === "stale-subject" },
              });
            }
            return yield* complete({ value: result, disposition: "applied" });
          }),
        ),
      workTaskHome: (canvas, nodeId, taskId) =>
        itemHome("task", canvas, nodeId, taskId),
      workTaskCreate: (canvas, nodeId, brief, metadata, reason, media, dependsOn, finishCriteria, rules, options, admin) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            if (admin !== undefined) yield* requireLiveOverseer(admin);
            yield* requireNode(read.topology, nodeId);
            const policyWork = yield* policyRows(canvas, nodeId, dependsOn ?? []);
            const policy = yield* runPolicy(() =>
              workTaskCreate(policyWork, read.topology,
                canvas,
                nodeId,
                brief,
                metadata,
                ids,
                reason,
                media,
                dependsOn,
                finishCriteria,
                rules,
                options,
              )
            );
            const basis = intentBasis(read.intentWitness);
            const dependencyScope = yield* taskDependencyScopeCapability(
              canvas,
              nodeId,
              basis,
            );
            const task = yield* externalizeTask(policy.task, {
              kind: "task",
              canvasName: canvas,
              nodeId,
              recordId: policy.task.id,
            });
            const outcome = yield* local(
                repository.createTask({
                  sink: sinkRef(canvas, nodeId),
                  basis,
                  dependencyScope,
                  task,
                }),
                admin,
              );
            return yield* complete(outcome);
          }),
        ),

      workTaskDescribe: (canvas, nodeId, taskId, brief) =>
        asResult(
          Effect.gen(function* () {
            const [read] = yield* Effect.all([
              readTopology(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const policyWork = yield* policyRows(canvas, nodeId, taskId === null ? [] : [taskId]);
            const policy = yield* runPolicy(() =>
              workTaskDescribe(policyWork, read.topology,
                canvas,
                nodeId,
                taskId,
                brief,
                ids,
              )
            );
            const message = policy.task.history[0]!;
            const outcome = yield* local(
                repository.describeTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  taskId,
                  message,
                }),
              );
            return yield* complete(outcome);
          }),
        ),

      workTaskTransition: (canvas, nodeId, taskId, state, note, completionEvidence, path, receiptAuthor) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              installationContext,
              readTopology(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const before = yield* readItem(canvas, nodeId, taskId);
            const localReceiptAuthor = (completionEvidence?.git?.commits.length ?? 0) > 0
              ? receiptAuthor
              : undefined;
            if (localReceiptAuthor !== undefined) {
              const author = read.actorRefs.find((actor) => actor.seatId === localReceiptAuthor.fromSeat &&
                (localReceiptAuthor.senderNodeId === undefined || actor.nodeId === localReceiptAuthor.senderNodeId));
              if (before === undefined || reviewAuthorSeat(before) !== localReceiptAuthor.fromSeat || author === undefined) {
                return yield* new WorkServiceError({
                  code: "scope_error",
                  message: "commit evidence must come from the task's current claimant",
                  details: { reason: "receipt-author-mismatch", retryable: false },
                });
              }
            }
            // Finish-criteria gate is home-local only. Off-home callers enqueue
            // a command; the executor re-runs the gate against its SQLite shelf.
            // Rules/checks gates are doc-derived and run in policy always.
            const evaluateFinish = false; // The home repository evaluates its artifact shelf atomically.
            const policyWork = yield* policyRows(canvas, nodeId, taskId === null ? [] : [taskId]);
            const policy: WorkTaskTransitionResult = yield* runPolicy(() =>
              workTaskTransition(policyWork, read.topology,
                canvas,
                nodeId,
                taskId,
                state,
                note,
                ids,
                completionEvidence,
                {
                  evaluateFinishCriteria: evaluateFinish,
                  ...(path?.next !== undefined
                    ? { next: path.next }
                    : {}),
                  ...(path?.defect !== undefined
                    ? { defect: path.defect }
                    : {}),
                  ...(path?.waitForMs !== undefined
                    ? { waitForMs: path.waitForMs }
                    : {}),
                  ...(path?.handoffNote !== undefined
                    ? { handoffNote: path.handoffNote }
                    : {}),
                },
              )
            );
            let reviewGate: ReviewGateWithin | undefined;
            if (state === "completed" && before !== undefined) {
              const candidate = {
                ...before,
                completionEvidence: policy.task.completionEvidence,
              };
              const review = yield* reviewForTask(read, canvas, nodeId, candidate, home);
              if (!review.gate.satisfied) {
                return yield* new WorkServiceError({
                  code: "not_ready",
                  message: "completion requires a current eligible reviewer's green verdict for these exact refs",
                  details: {
                    reason: "review-required",
                    received: { subject: review.projection, unsatisfied: review.gate.unsatisfied },
                    retryable: true,
                    next_step: "have a distinct reviewer approve the current subject, then retry completion with the same refs",
                  },
                });
              }
              if (review.gate.armed.length > 0) {
                if (review.projection.authorSeatId === undefined) {
                  return yield* new WorkServiceError({
                    code: "not_ready",
                    message: "review-gated completion requires current author provenance",
                    details: { reason: "author-unresolved", retryable: true },
                  });
                }
                reviewGate = {
                  installationId: home,
                  canvasName: canvas,
                  nodeId,
                  taskId,
                  epoch: review.projection.epoch,
                  subjectHash: review.projection.subjectHash,
                  excludingSeatId: review.projection.authorSeatId,
                };
              }
            }
            const message =
              before !== undefined &&
                policy.task.history.length > before.history.length
                ? policy.task.history.at(-1)
                : undefined;
            if (policy.sentOn !== undefined || policy.sentBack !== undefined) {
              // Re-homing writes two rows atomically; it executes only at the
              // task home installation (task paths are Command Center authority).
              if (home !== context.localInstallationId) {
                return yield* new WorkServiceError({
                  code: "wrong_home",
                  message:
                    "send on and send back execute on the task home installation",
                  details: {
                    target: nodeId,
                    retryable: false,
                    next_step:
                      "run this op on the installation that owns the task",
                  },
                });
              }
            }
            if (policy.sentOn !== undefined) {
              const sentOn = policy.sentOn;
              const moved = yield* local(
                repository.sendTaskOn({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  taskId,
                  ...(message === undefined ? {} : { message }),
                  ...(completionEvidence !== undefined
                    ? { completionEvidence }
                    : {}),
                  visits: policy.task.visits ?? [],
                  next: sinkRef(canvas, sentOn.nodeId),
                  nextTask: sentOn.task,
                  ...(reviewGate === undefined ? {} : { reviewGate }),
                  ...(localReceiptAuthor === undefined ? {} : { receiptAuthor: localReceiptAuthor }),
                }),
              );
              return yield* complete({
                ...moved,
                value: moved.value.completed,
              });
            }
            if (policy.sentBack !== undefined) {
              const sentBack = policy.sentBack;
              const returned = yield* local(
                repository.sendTaskBack({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  taskId,
                  ...(message === undefined ? {} : { message }),
                  visits: policy.task.visits ?? [],
                  ...(policy.task.defects !== undefined
                    ? { defects: policy.task.defects }
                    : {}),
                  target: sinkRef(canvas, sentBack.nodeId),
                  sentBackTask: sentBack.task,
                }),
              );
              return yield* complete({
                ...returned,
                value: returned.value.rejected,
              });
            }
            // Terminal close of a moved task stamps the visit exit on the
            // same row; the durable write carries the visits patch.
            const taskPatch: TaskRecordPatch = {
              ...(policy.task.visits !== undefined
                ? { visits: policy.task.visits }
                : {}),
              ...(policy.task.defects !== undefined
                ? { defects: policy.task.defects }
                : {}),
            };
            const visitsPatch =
              Object.keys(taskPatch).length > 0
                ? { taskPatch }
                : {};
            const outcome = yield* local(
                repository.transitionTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  taskId,
                  state,
                  ...(message === undefined ? {} : { message }),
                  ...(completionEvidence !== undefined
                    ? { completionEvidence }
                    : {}),
                  ...visitsPatch,
                  ...(reviewGate === undefined ? {} : { reviewGate }),
                  ...(localReceiptAuthor === undefined ? {} : { receiptAuthor: localReceiptAuthor }),
                }),
              );
            return yield* complete(outcome);
          }),
        ),

      workTaskPromote: (canvas, nodeId, taskId, note, admin) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              installationContext,
              readTopology(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            if (admin !== undefined) yield* requireLiveOverseer(admin);
            // Local-only: protocol 1 has no promote action to enqueue.
            if (home !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "wrong_home",
                message: "approval happens on the task home installation",
                details: {
                  target: taskId,
                  retryable: false,
                  next_step:
                    "run the approval from the installation that owns the task",
                },
              });
            }
            const node = yield* requireNode(read.topology, nodeId);
            const task = yield* readItem(canvas, nodeId, taskId);
            if (task === undefined) {
              return yield* new WorkServiceError({
                code: "task_not_found",
                message: `task "${taskId}" not found`,
              });
            }
            const admission = effectiveTaskAdmission(task, boardContractOf(read.topology, node.id));
            if (admission !== "approval") {
              return yield* new WorkServiceError({
                code: "unadmitted",
                message:
                  `task "${taskId}" effective admission is ${admission}; approval applies to approval-admission tasks`,
                details: {
                  target: taskId,
                  retryable: false,
                  next_step:
                    "approval applies only to tasks waiting for operator approval",
                },
              });
            }
            if (taskApproved(task)) {
              if (note?.trim()) {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message:
                    `task "${taskId}" is already approved; the supplied note was not recorded`,
                });
              }
              return yield* complete({
                value: task,
                disposition: "applied" as const,
              });
            }
            const noteText = note?.trim();
            let message: Message | undefined;
            if (noteText) {
              const policyWork = yield* policyRows(canvas, nodeId, taskId === null ? [] : [taskId]);
            const policy = yield* runPolicy(() =>
                workMessageAppend(policyWork, read.topology,
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
                basis: intentBasis(read.intentWitness),
                taskId,
                ...(message === undefined ? {} : { message }),
              }),
            );
            return yield* complete(outcome);
          }),
        ),

      workTaskShow: (canvas, nodeId, taskId, view) =>
        Effect.gen(function* () {
          const read = yield* readTopology(canvas);
          const node = yield* requireNode(read.topology, nodeId);
          const task = yield* readItem(canvas, nodeId, taskId);
          if (task === undefined) {
            return yield* new WorkServiceError({
              code: "task_not_found",
              message: `task "${taskId}" not found`,
            });
          }
          const home = yield* itemHome("task", canvas, nodeId, taskId);
          const review = yield* reviewForTask(read, canvas, nodeId, task, home);
          // Onion visibility: prior boards surface their handoff note and the
          // refs their claims cited; full interiors (claims, waivers) travel
          // only on the operator view. The current row is onion-correct by
          // construction — re-homing starts a fresh thread.
          const visitWork = yield* policyRows(canvas, nodeId, [taskId]);
          const visits = (task.visits ?? []).map((visit): WorkTaskVisitView => {
            const row = visitWork.taskAt(visit.board, taskId);
            const evidence = row?.completionEvidence;
            const refs = [
              ...new Set(
                (evidence?.claims ?? []).flatMap(
                  (claim) => claim.refs ?? [],
                ),
              ),
            ];
            return {
              boardId: visit.board,
              board: taskName(
                nodeById(read.topology, visit.board),
                visit.board,
              ),
              enteredAt: visit.enteredAt,
              epoch: visit.epoch,
              ...(visit.claimedBy !== undefined
                ? { claimedBy: visit.claimedBy }
                : {}),
              ...(visit.exitedAt !== undefined
                ? { exitedAt: visit.exitedAt }
                : {}),
              ...(visit.exit !== undefined ? { exit: visit.exit } : {}),
              ...(visit.next !== undefined
                ? {
                    next: visit.next,
                    nextBoard: taskName(
                      nodeById(read.topology, visit.next),
                      visit.next,
                    ),
                  }
                : {}),
              ...(visit.handoffNote !== undefined
                ? { handoffNote: visit.handoffNote }
                : {}),
              refs,
              ...(view === "operator" && evidence !== undefined
                ? { evidence }
                : {}),
            };
          });
          const contract = boardContractOf(read.topology, node.id);
          const identity = taskIdentity(node, nodeId);
          const boardInstructions = contract?.instructions?.trim();
          const incomingHandling = contract?.incoming?.handling?.trim();
          const incomingDescription = contract?.incoming?.description?.trim();
          // Handoff prose only surfaces when the board can send the task on.
          const hasNext = flowDestinations(read.topology, nodeId).length > 0;
          const outgoingHandoff = hasNext
            ? contract?.outgoing?.handoff?.trim()
            : undefined;
          const outgoingDescription = hasNext
            ? contract?.outgoing?.description?.trim()
            : undefined;
          return {
            task,
            reviewSubject: review.projection,
            verdicts: review.verdicts,
            board: {
              nodeId,
              name: identity.name,
            },
            visits,
            rules: review.rules,
            ambient: {
              regions: regionStackFor(read.topology, nodeId),
              ...(boardInstructions ? { boardInstructions } : {}),
              ...(incomingHandling || incomingDescription
                ? {
                    incoming: {
                      ...(incomingHandling ? { handling: incomingHandling } : {}),
                      ...(incomingDescription
                        ? { description: incomingDescription }
                        : {}),
                    },
                  }
                : {}),
              ...(outgoingHandoff || outgoingDescription
                ? {
                    outgoing: {
                      ...(outgoingHandoff ? { handoff: outgoingHandoff } : {}),
                      ...(outgoingDescription
                        ? { description: outgoingDescription }
                        : {}),
                    },
                  }
                : {}),
            },
          };
        }),

      workTaskRules: (canvas, nodeId, taskId) =>
        Effect.gen(function* () {
          const read = yield* readTopology(canvas);
          const node = yield* requireNode(read.topology, nodeId);
          const task = taskId === undefined
            ? undefined
            : yield* readItem(canvas, nodeId, taskId);
          if (taskId !== undefined && task === undefined) {
            return yield* new WorkServiceError({
              code: "task_not_found",
              message: `task "${taskId}" not found`,
            });
          }
          const rules = rulesInForce(read.topology, nodeId, task);
          if (task === undefined) return { rules };
          const taskWork = yield* policyRows(canvas, nodeId, [task.id]);
          const recorded = claimsRecorded(taskWork, task);
          const localClaims = new Set(
            (task.completionEvidence?.claims ?? []).map((claim) => claim.ruleId),
          );
          const waived = new Set([
            ...recorded.waived,
            ...(task.completionEvidence?.waivers ?? []).map(
              (waiver) => waiver.ruleId,
            ),
          ]);
          const unanswered = rules
            .filter(({ rule, provenance }) => {
              if (rule.kind === "requires-review") return false;
              // Task rules answer at their own board; region/board rules are
              // once per epoch, answered by any live recorded claim.
              const claimed =
                provenance.kind === "task"
                  ? claimedAtBoard(recorded.claimed, provenance.board, rule.id) ||
                    (provenance.board === nodeId && localClaims.has(rule.id))
                  : recorded.claimed.has(rule.id);
              return !claimed && !waived.has(rule.id);
            })
            .map(({ rule, provenance }) => ({
              ruleId: rule.id,
              text: rule.text,
              provenance,
            }));
          const epoch = taskEpoch(task);
          const results = task.checkResults ?? [];
          const checks = flowDestinations(read.topology, nodeId).map(
            (destination) => ({
              destination,
              checks: requiredChecks(read.topology, nodeId, destination).map(
                ({ check, side }) => {
                  const result = results.find(
                    (candidate) =>
                      candidate.checkId === check.id &&
                      candidate.side === side &&
                      candidate.epoch === epoch,
                  );
                  return {
                    checkId: check.id,
                    side,
                    label: check.label,
                    command: check.command,
                    status: result === undefined
                      ? ("missing" as const)
                      : result.command !== check.command
                        ? ("stale" as const)
                        : result.exitCode === 0
                          ? ("green" as const)
                          : ("red" as const),
                  };
                },
              ),
            }),
          );
          const home = yield* itemHome("task", canvas, nodeId, task.id);
          const review = yield* reviewForTask(read, canvas, nodeId, task, home);
          return { rules: review.rules, readiness: { unanswered, checks, review: review.gate } };
        }),

      workRulingsList: (canvas, nodeId) =>
        Effect.gen(function* () {
          const read = yield* readTopology(canvas);
          yield* requireNode(read.topology, nodeId);
          return {
            regions: regionStack(read.topology, asNodeId(nodeId)).map((group) => ({
              id: group.id,
              label: group.label?.trim() || group.id,
              rulings: [
                ...(regionContractOf(group)?.rulings ?? []),
              ],
            })),
          };
        }),

      workTaskCheck: (canvas, nodeId, taskId, results, next) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, home] = yield* Effect.all([
              installationContext,
              readTopology(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            if (home !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "wrong_home",
                message:
                  "check results stamp on the task home installation",
                details: {
                  target: taskId,
                  retryable: false,
                  next_step:
                    "run tasks check from the installation that owns the task",
                },
              });
            }
            const node = yield* requireNode(read.topology, nodeId);
            const task = yield* readItem(canvas, nodeId, taskId);
            if (task === undefined) {
              return yield* new WorkServiceError({
                code: "task_not_found",
                message: `task "${taskId}" not found`,
              });
            }
            const plan = resolveCheckPlan(read.topology, nodeId, next);
            if (!plan.ok) {
              const rejection = plan.rejection;
              const code =
                rejection.code === "ambiguous-next"
                  ? ("fork_choice" as const)
                  : rejection.code === "unknown-destination"
                    ? ("invalid" as const)
                    : ("fork_choice" as const);
              return yield* new WorkServiceError({
                code,
                message: rejection.message,
                details: {
                  target: nodeId,
                  ...(next === undefined ? {} : { to: next }),
                  missing: "next",
                  retryable: false,
                  next_step: rejection.next_step,
                },
              });
            }
            const nowIso = new Date().toISOString();
            const epoch = taskEpoch(task);
            // Label/command come from the authored checks, never from the seat
            // submission; the output tail is capped by bytes.
            const stamped = yield* runPolicy(() =>
              results.map((result): CheckResult => {
                const match = plan.plan.checks.find(
                  (entry) =>
                    entry.checkId === result.checkId &&
                    entry.side === result.side,
                );
                if (match === undefined) {
                  throw new WorkError(
                    "invalid",
                    `check "${result.checkId}" (${result.side}) is not on the applicable checks for "${plan.plan.next}"`,
                  );
                }
                return {
                  checkId: match.checkId,
                  side: result.side,
                  command: match.command,
                  exitCode: result.exitCode,
                  outputTail: capOutputTail(
                    result.outputTail.slice(-CHECK_OUTPUT_TAIL_MAX_BYTES),
                  ),
                  at: nowIso,
                  epoch,
                };
              })
            );
            // recordCheckResults merges these against the live row inside its
            // own transaction, not this pre-transaction snapshot — pass only
            // the newly stamped results.
            const outcome = yield* local(
              repository.recordCheckResults({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(read.intentWitness),
                taskId,
                results: stamped,
              }),
            );
            return yield* complete(outcome);
          }),
        ),

      workTaskRespond: (canvas, nodeId, taskId, responseText, disposition, admin) =>
        asResult(
          Effect.gen(function* () {
            const [read] = yield* Effect.all([
              readTopology(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            if (admin !== undefined) yield* requireLiveOverseer(admin);
            const policyWork = yield* policyRows(canvas, nodeId, taskId === null ? [] : [taskId]);
            const policy = yield* runPolicy(() =>
              workTaskRespond(policyWork, read.topology,
                canvas,
                nodeId,
                taskId,
                responseText,
                disposition,
                ids,
              )
            );
            const message = policy.task.history.at(-1)!;
            const outcome = yield* local(
                repository.transitionTask({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  taskId,
                  state: disposition,
                  message,
                }),
                admin,
              );
            return yield* complete(outcome);
          }),
        ),

      workTaskClaim: (canvas, nodeId, taskId, actor, admin) =>
        asResult(
          Effect.gen(function* () {
            const [context, read, sourceHome] = yield* Effect.all([
              installationContext,
              readTopology(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            yield* requireActor(
              read,
              actor,
              nodeId,
              "tasks.claim",
              admin,
            );
            if (sourceHome !== context.localInstallationId) {
              return yield* new WorkServiceError({
                code: "wrong_home",
                message:
                  "first claim must execute on the installation that owns the submitted queue",
                details: {
                  target: nodeId,
                  retryable: false,
                  next_step:
                    "run the claim from the installation that owns the queue",
                },
              });
            }
            const claimWork = yield* policyRows(canvas, nodeId, [taskId]);
            const sourceItems = claimWork.itemsOf(nodeId);
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
              return yield* complete({
                value: sourceTask,
                disposition: "applied",
                message:
                  "Task " +
                  JSON.stringify(taskId) +
                  " is already claimed by you; continue working on it.",
              });
            }
            if (
              sourceTask.claimedBy !== undefined &&
              sourceTask.claimedBy !== actor.seatId
            ) {
              return yield* new WorkServiceError({
                code: "claim_contention",
                message: `task "${taskId}" is already claimed by another seat`,
                details: {
                  holder: sourceTask.claimedBy,
                  caller: actor.seatId,
                  retryable: false,
                  next_step:
                    "wait for the holder to release the task, or pick another task",
                },
              });
            }
            // Admission for every first-claim arm: seats never claim at a Me
            // board; waiting and Approval tasks are not claimable yet.
            if (sourceTask.state === "submitted") {
              const admission = taskAdmissionState(
                sourceTask,
                boardContractOf(read.topology, nodeId),
                Date.now(),
              );
              if (admission === "operator") {
                return yield* new WorkServiceError({
                  code: "operator_owned",
                  message:
                    `board "${nodeId}" is set to Me — the operator works tasks here; no seat claim`,
                  details: {
                    target: nodeId,
                    caller: actor.seatId,
                    retryable: false,
                    next_step:
                      "pick a task at a board agents can claim, or ask the operator to change Who starts tasks",
                  },
                });
              }
              if (admission === "waiting") {
                return yield* new WorkServiceError({
                  code: "unadmitted",
                  message:
                    `task "${taskId}" is not claimable before ${sourceTask.waitUntil} (wait before starting)`,
                  details: {
                    target: taskId,
                    retryable: false,
                    next_step:
                      "wait until the wait before starting passes, or pick another task",
                  },
                });
              }
              if (admission === "approval") {
                return yield* new WorkServiceError({
                  code: "unadmitted",
                  message:
                    `task "${taskId}" awaits operator approval at board "${nodeId}"`,
                  details: {
                    target: taskId,
                    retryable: false,
                    next_step:
                      "wait for the operator to approve this task, or pick another task",
                  },
                });
              }
            }
            // Claim-ready gate for every first claim.
            // dependsOn may resolve to other task sinks in the same region.
            if (
              sourceTask.state === "submitted" &&
              !taskIsClaimReady(
                sourceTask,
                dependencyScopeIndex(read.topology, claimWork, nodeId),
              )
            ) {
              return yield* new WorkServiceError({
                code: "not_ready",
                message: `task "${taskId}" is not claim-ready (unsatisfied dependsOn)`,
                details: {
                  target: taskId,
                  missing: "dependsOn",
                  retryable: false,
                  next_step:
                    "finish the prerequisite tasks before claiming this one",
                },
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
            const basis = intentBasis(read.intentWitness);
            const dependencyScope = yield* taskDependencyScopeCapability(
              canvas,
              nodeId,
              basis,
            );
            const outcome = yield* local(
              repository.claimLocalTask({
                sink: sinkRef(canvas, nodeId),
                basis,
                dependencyScope,
                taskId,
                actor,
              }),
              admin,
            );
            return yield* complete(outcome);
          }),
        ),

      workTaskComment: (canvas, nodeId, taskId, message, admin) =>
        asResult(
          Effect.gen(function* () {
            const [read] = yield* Effect.all([
              readTopology(canvas),
              itemHome("task", canvas, nodeId, taskId),
            ]);
            const overseer =
              admin === undefined
                ? undefined
                : yield* requireLiveOverseer(admin);
            const targetNode = yield* requireNode(read.topology, nodeId);
            const targetSpec = resolveSpec({
              isGroup: false,
              kind: targetNode.kind,
            });
            const isTaskSink = Match.value(targetSpec).pipe(
              Match.when({ _tag: "Sink", kind: "task" }, () => true),
              Match.orElse(() => false),
            );
            if (!isTaskSink) {
              return yield* new WorkServiceError({
                code: "illegal_kind",
                message: "task comments require a task board",
              });
            }
            const policyWork = yield* policyRows(canvas, nodeId, taskId === null ? [] : [taskId], [], read.topology.nodes.get(asNodeId(nodeId))?.kind === "requests" ? "requests" : "task");
            const policy = yield* runPolicy(() =>
              workMessageAppend(policyWork, read.topology, canvas, nodeId, taskId, message)
            );
            const materializedMessage = yield* externalizeMessage(policy.message, {
              kind: "message",
              canvasName: canvas,
              nodeId,
              recordId: policy.message.messageId,
            });
            const sentBy = overseer ?? operatorActorRef(canvas);
            const destination = { kind: "task" as const, itemId: taskId };
            const outcome = yield* local(
                repository.appendMessage({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  message: materializedMessage,
                  sentBy,
                  destination,
                }),
                admin,
              );
            if (outcome.disposition === "applied") {
              yield* Effect.gen(function* () {
                const task = policyWork.taskAt(nodeId, taskId);
                if (task === undefined) return;
                const ownerRef = taskCommentRecipient(
                  task,
                  boardContractOf(read.topology, targetNode.id),
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
                  text: `${sourceText}\n(comment on task ${taskId} at "${nodeId}" — reply: junto msg send '{"target":"${nodeId}","taskId":"${taskId}","text":"..."}')`,
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
                    basis: intentBasis(read.intentWitness),
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
            return yield* complete(outcome);
          }),
        ),

      workMessageAppend: (
        canvas,
        nodeId,
        taskId,
        message,
        sentBy,
        admin,
      ) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            yield* requireActor(
              read,
              sentBy,
              nodeId,
              "msg.send",
              admin,
            );
            const targetNode = yield* requireNode(read.topology, nodeId);
            const policyWork = yield* policyRows(canvas, nodeId, taskId === null ? [] : [taskId], [], read.topology.nodes.get(asNodeId(nodeId))?.kind === "requests" ? "requests" : "task");
            const policy = yield* runPolicy(() =>
              workMessageAppend(policyWork, read.topology,
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
              kind: targetNode.kind,
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
            if (taskId !== null) yield* itemHome(isRequestSink ? "request" : "task", canvas, nodeId, taskId);
            const outcome = yield* local(
                repository.appendMessage({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  message: materializedMessage,
                  sentBy,
                  destination,
                }),
                admin,
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
            // seat only, never the sender echoing itself; operator-worked and
            // unclaimed rows notify nobody. Best-effort by law: a notification
            // failure must never fail the append. Runs only on the home-local
            // path — an enqueued append has no local mailbox to notify.
            if (
              outcome.disposition === "applied" &&
              taskId !== null &&
              destination.kind === "task"
            ) {
              yield* Effect.gen(function* () {
                const task = policyWork.taskAt(nodeId, taskId);
                if (task === undefined) return;
                const ownerRef = taskCommentRecipient(
                  task,
                  boardContractOf(read.topology, targetNode.id),
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
                  text: `${sourceText}\n(comment on task ${taskId} at "${nodeId}" — reply: junto msg send '{"target":"${nodeId}","taskId":"${taskId}","text":"..."}')`,
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
                    basis: intentBasis(read.intentWitness),
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
            return yield* complete(outcome);
          }),
        ),

      workSystemMailboxNotify: (canvas, nodeId, message) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            const targetNode = yield* requireNode(read.topology, nodeId);
            const targetSpec = resolveSpec({
              isGroup: false,
              kind: targetNode.kind,
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
                    targetNode.kind ?? "none"
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
            const sentBy = operatorActorRef(canvas);
            const outcome = yield* local(
              repository.appendMessage({
                sink: sinkRef(canvas, nodeId),
                basis: intentBasis(read.intentWitness),
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
            return yield* complete(outcome);
          }),
        ),

      workMessageMarkRead: (canvas, nodeId, messageId, reader, admin) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            yield* requireActor(
              read,
              reader,
              nodeId,
              "msg.read",
              admin,
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
            const exists = (yield* repository.mailMessage(canvas, nodeId, trimmed).pipe(Effect.mapError(toWorkServiceError))) !== undefined;
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
              return yield* complete({
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
                basis: intentBasis(read.intentWitness),
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
            return yield* complete(outcome);
          }),
        ),

      workMessageReact: (canvas, nodeId, messageId, reaction, reactor, admin) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            yield* requireActor(
              read,
              reactor,
              nodeId,
              "msg.react",
              admin,
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
            const exists = (yield* repository.mailMessage(canvas, nodeId, trimmed).pipe(Effect.mapError(toWorkServiceError))) !== undefined;
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
              return yield* complete({
                disposition: "applied" as const,
                value: { messageId: trimmed, reaction, reactedAt: existingAt },
              });
            }
            const acceptedAt = new Date().toISOString();
            const outcome = yield* repository
              .acceptDelivery({
                sink,
                basis: intentBasis(read.intentWitness),
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
            return yield* complete(outcome);
          }),
        ),

      workRequestCreate: (
        canvas,
        nodeId,
        brief,
        metadata,
        raisedBy,
        reason,
        admin,
      ) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            yield* requireActor(
              read,
              raisedBy,
              nodeId,
              // A request is filed into the Requests node's thread; seats no
              // longer escalate through it (agent signals replaced that).
              "msg.send",
              admin,
            );
            const policyWork = yield* policyRows(canvas, nodeId, []);
            const policy = yield* runPolicy(() =>
              workRequestCreate(policyWork, read.topology,
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
                  basis: intentBasis(read.intentWitness),
                  request: policy.task,
                  raisedBy,
                }),
                admin,
              );
            return yield* complete(outcome);
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
            const [read] = yield* Effect.all([
              readTopology(canvas),
              itemHome("request", canvas, nodeId, taskId),
            ]);
            const before = yield* readItem(canvas, nodeId, taskId, "requests");
            if (before !== undefined && isTerminalTaskState(before.state)) {
              // Already resolved — a stale second surface (RequestInbox
              // overlay or actor ledger) may still offer Send while its doc
              // write is in flight. Absorb the duplicate as an idempotent
              // settle: the current doc is truth and the surfaces refresh
              // from it via scoped Work store refresh, so no error banner.
              return yield* complete({
                value: before,
                disposition: "applied",
                message:
                  `request "${taskId}" is already resolved (${before.state})`,
              });
            }
            const policyWork = yield* policyRows(canvas, nodeId, [taskId], [], "requests");
            const policy = yield* runPolicy(() =>
              workRequestResolve(policyWork, read.topology,
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
            const outcome = yield* local(
                repository.resolveRequest({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  requestId: taskId,
                  response: policy.task.response!,
                  disposition,
                  ...(message === undefined ? {} : { message }),
                }),
              );
            const completed = yield* complete(outcome);
            if (
              outcome.disposition === "applied" &&
              before?.claimedBy !== undefined
            ) {
              const raisers = read.actorRefs.filter(
                (actor) =>
                  actor.canvasName === canvas &&
                  actor.seatId === before.claimedBy,
              );
              if (raisers.length === 0) {
                // Never a silent drop: the raising agent must learn its
                // escalation was answered. If no live actor ref matches the
                // claiming seat (node deleted / moved off canvas), say so.
                console.warn(
                  `[work] request "${taskId}" resolved but no live actor ref ` +
                    `on canvas "${canvas}" matches seat "${before.claimedBy}" — ` +
                    "resolved-response nudge not delivered",
                );
              } else {
                for (const raiser of raisers) {
                  messageDelivery.notifyRequestResolved({
                    canvas,
                    actorNodeId: raiser.nodeId,
                    requestId: taskId,
                    response: policy.task.response!,
                  });
                }
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
        admin,
      ) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            if (admin === undefined) {
              yield* requireActor(
                read,
                publishedBy,
                nodeId,
                "artifact.publish",
              );
            } else {
              const live = yield* requireLiveOverseer(admin);
              if (!sameActor(live, publishedBy)) {
                return yield* new WorkServiceError({
                  code: "invalid",
                  message: "overseer admin actor does not match the publishing seat",
                });
              }
              const sink = admitOverseerWorkTarget(
                read.topology,
                nodeId,
                "artifact.publish",
              );
              if (Result.isFailure(sink)) {
                return yield* new WorkServiceError({
                  code:
                    sink.failure.type === "UnknownTarget"
                      ? "node_not_found"
                      : "invalid",
                  message: sink.failure.message,
                });
              }
            }
            const policyWork = yield* policyRows(canvas, nodeId, [artifact.task?.itemId].filter((id): id is string => id !== undefined), [artifact.artifactId]);
            const policy = yield* runPolicy(() =>
              workArtifactPublish(policyWork, read.topology,
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
            const origin = yield* readTopology(publishedBy.canvasName);
            yield* requireNode(origin.topology, publishedBy.nodeId);
            const outcome = yield* local(
                  repository.publishArtifact({
                    sink: sinkRef(canvas, nodeId),
                    basis: intentBasis(read.intentWitness),
                    artifact: materializedArtifact,
                    publishedBy,
                  }),
                  admin,
                );
            return yield* complete(outcome);
          }),
        ),

      workArtifactArchive: (canvas, nodeId, artifactId, archived) =>
        asResult(
          Effect.gen(function* () {
            yield* installationContext;
            const outcome = yield* local(
              repository
                .setArtifactArchived({
                  sink: sinkRef(canvas, nodeId),
                  artifactId,
                  archived,
                })
                .pipe(Effect.map((artifact) => ({ value: artifact }))),
            );
            return yield* complete(outcome);
          }),
        ),

      workArtifactDelete: (canvas, nodeId, artifactId) =>
        asResult(
          Effect.gen(function* () {
            yield* installationContext;
            const outcome = yield* local(
              repository
                .deleteArtifact({
                  sink: sinkRef(canvas, nodeId),
                  artifactId,
                })
                .pipe(Effect.map((value) => ({ value }))),
            );
            return yield* complete(outcome);
          }),
        ),

      workSeatRecentOps: (canvas, nodeId, limit) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
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
            return yield* complete(outcome);
          }),
        ),

      // Board material rows are Command Center-homed (global sink). List reads
      // local SQLite only — same as mailbox projection: full board on CC.
      workBoardList: (canvas, nodeId, topicId) =>
        asResult(
          Effect.gen(function* () {
            const topics = yield* repository.boardTopics(canvas, nodeId, topicId)
              .pipe(Effect.mapError(toWorkServiceError));
            const outcome = yield* local(
              Effect.succeed({ value: { topics } }),
            );
            return yield* complete(outcome);
          }),
        ),

      workBoardCreateTopic: (canvas, nodeId, title, body, author, notify) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            const node = read.topology.nodes.get(asNodeId(nodeId));
            if (node?.kind !== "board") {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message: `node "${nodeId}" is not a board sink`,
                }),
              );
            }
            // Validate before either local creation or remote enqueue: the
            // repository decodes with strict schema and an out-of-window
            // title would surface as an untyped defect.
            const cleanTitle = title.trim();
            if (cleanTitle.length < 1 || cleanTitle.length > 512) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "topic title must be between 1 and 512 characters",
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
              title: cleanTitle,
              state: "open" as const,
              openedBy: author,
              openedAt: now,
              postCount: seedPost ? 1 : 0,
              lastActivityAt: now,
              ...(parts.length > 0 ? { parts } : {}),
              ...(seedPost ? { posts: [seedPost] } : {}),
            };
            const outcome = yield* local(
                  repository
                    .createBoardTopic({
                      sink: sinkRef(canvas, nodeId),
                      basis: intentBasis(read.intentWitness),
                      topic,
                      createdBy: author,
                    })
                    .pipe(
                      Effect.map((result) => ({
                        value: { topic: result.value, notify },
                      })),
                    ),
                );
            return yield* complete(outcome);
          }),
        ),

      workBoardPost: (canvas, nodeId, topicId, text, author, tags) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            if (
              read.topology.nodes.get(asNodeId(nodeId))?.kind !== "board"
            ) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "illegal_kind",
                  message: `node "${nodeId}" is not a board sink`,
                }),
              );
            }
            // A blank post would fail the BoardPost parts minimum only at
            // repository decode — as an untyped defect. Refuse it here.
            if (text.trim().length === 0) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "post text must not be empty",
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
            const outcome = yield* local(
                  repository
                    .appendBoardPost({
                      sink: sinkRef(canvas, nodeId),
                      basis: intentBasis(read.intentWitness),
                      post,
                      createdBy: author,
                    })
                    .pipe(
                      Effect.map((result) => ({
                        value: { post: result.value },
                      })),
                    ),
                );
            return yield* complete(outcome);
          }),
        ),

      workBoardMarkRead: (canvas, nodeId, topicId, principalKey, upToPosition) =>
        asResult(
          Effect.gen(function* () {
            if (
              upToPosition !== undefined &&
              (!Number.isSafeInteger(upToPosition) || upToPosition < 0)
            ) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "upToPosition must be a non-negative integer",
                }),
              );
            }
            const topics = yield* repository.boardTopics(canvas, nodeId, topicId)
              .pipe(Effect.mapError(toWorkServiceError));
            const topic = topics[0];
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
            return yield* complete(outcome);
          }),
        ),

      workPadRead: (canvas, nodeId, pinId) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            const node = read.topology.nodes.get(asNodeId(nodeId));
            if (node?.kind !== "pad") {
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
              // A stale pinId degrades to a plain read (lookHere is an
              // addition, not a precondition). Other projection failures
              // still fail the read.
              if (
                Result.isFailure(focused) &&
                focused.failure.code !== "missing"
              ) {
                return yield* Effect.fail(
                  new WorkServiceError({
                    code: "invalid",
                    message: focused.failure.message,
                  }),
                );
              }
              lookHere = Result.isSuccess(focused) ? focused.success : undefined;
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
            return yield* complete(outcome);
          }),
        ),

      workPadPatch: (canvas, nodeId, patches, author, admin) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            const overseer =
              admin === undefined
                ? undefined
                : yield* requireLiveOverseer(admin);
            if (
              read.topology.nodes.get(asNodeId(nodeId))?.kind !== "pad"
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
              inboundActorNodeIds(read.topology, nodeId),
              overseer === undefined ? undefined : { overseer: true },
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
            const patchId = ids.id();
            const current = yield* repository
              .readPad(canvas, nodeId)
              .pipe(Effect.mapError(toWorkServiceError));
            const addedMentions = addedPadMentions(current, materialized);
            const outcome = yield* local(
                  repository
                    .applyPadPatch({
                      sink: sinkRef(canvas, nodeId),
                      basis: intentBasis(read.intentWitness),
                      patchId,
                      patches: materialized,
                      author,
                      ...(overseer === undefined ? {} : { overseer: true }),
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
                  admin,
                );
            if (addedMentions.length > 0) {
              const actors = resolvePadInboundActors(read.topology, nodeId);
              const notifyIds = new Set(
                tagNotifyNodeIds(
                  addedMentions,
                  actors,
                  author.kind === "actor" ? author.nodeId : undefined,
                ),
              );
              const seats = resolveBoardWakeSet(read.topology, nodeId).filter(
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
            return yield* complete(outcome);
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
            return yield* complete(outcome);
          }),
        ),

    });
  }),
);
