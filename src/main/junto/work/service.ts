import { ModelNotFound, ModelRecords } from "../model/records";
import { workRowTooLargeIn } from "@shared/exchange-bounds";
import { asNodeId, type Canvas, type Node } from "@shared/model";
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
  Option,
  Result,
  Schema,
} from "effect";
import type {
  Artifact,
  Message,
  Part,
  Task,
} from "@shared/work-model";
import { ModelService } from "../model/service";
import { ModelActorRefs } from "../model/actor-refs";
import { SqlClient } from "effect/unstable/sql";
import { withSqlRead } from "../state/sql-read";
import type { WorkSeatRecentOpsFeed } from "@shared/work-recent-ops";
import type { ContentPart } from "@shared/content";
import type {
  InstallationId as InstallationIdValue,
} from "@shared/installation-id";
import { resolveSpec } from "@shared/physics";
import {
  WorkError,
  workMessageAppend,
  type WorkPolicyRead,
} from "@shared/work";
import {
  boardContractOf,
  regionContractOf,
} from "@shared/rules";
import { WorkErrorDetails } from "@shared/work-control";
import type { MailSenderStamp } from "@shared/crew";
import { regionStack } from "@shared/model/canvas";
import { taskCommentRecipient } from "@shared/task-owner";
import { taskCommentNotice } from "@shared/task-notices";
import { isCommentableKind } from "@shared/region-reach";
import { readMailExtension } from "@shared/crew";
import { makeUserMessage } from "@shared/task";
import type { Ruling } from "@shared/work-model";
import { operatorActorRef } from "@shared/work-reference";
import type {
  ActorRef,
  IntentFactBasis as IntentFactBasisValue,
  WorkItemRef,
} from "@shared/work-protocol";
import { IntentFactBasis } from "@shared/work-protocol";
import { MachineRepository } from "../machines/repository";
import { ContentService } from "../content/service";
import { StateEngine } from "../state/service";
import { workerMailReads } from "./mail-read-host";
import { type MailPage, type MailPageQuery, pageOfInbox, pageOfSent } from "./mail-read-sql";
import type { ContentOwner } from "../content/manifest";
import {
  admitLiveOverseer,
  admitOverseerWorkTarget,
  admitWorkTarget,
  type OverseerWorkAdmin,
} from "./authz";

export type { OverseerWorkAdmin };
import {
  mailboxMessageReactId,
  mailboxMessageReadId,
} from "./mailbox-receipts";
import { messageDelivery } from "./message-delivery";

import {
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryError,
  type ReviewReceiptRecord,
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

/**
 * Who a task comment is from, as its notice names them: the comment's own
 * sender stamp, or the bare actor when the comment carries none.
 */
const commentSenderOf = (comment: Message, sentBy: ActorRef): MailSenderStamp => {
  const stamped = readMailExtension(comment.metadata);
  if (stamped === undefined) return { fromSeat: sentBy.seatId, senderGeneration: "unknown", senderHarness: "unknown" };
  const { mailKind: _kind, subject: _subject, refs: _refs, ...stamp } = stamped;
  return stamp;
};

const toWorkServiceError = (error: unknown): WorkServiceError => {
  if (error instanceof WorkServiceError) return error;
  const tooLarge = workRowTooLargeIn(error);
  if (tooLarge !== undefined) {
    return new WorkServiceError({
      code: "invalid",
      message: tooLarge.message,
      details: {
        reason: "row_too_large",
        expected: tooLarge.limit,
        received: tooLarge.bytes,
        retryable: false,
        next_step: "send the long text as an attached file, which travels as a content ref",
      },
    });
  }
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
    /** Pinned rulings across the node's region stack, outer to inner. */
    readonly workRulingsList: (
      canvas: string,
      nodeId: string,
    ) => Effect.Effect<WorkRulingsView, WorkServiceError>;
    readonly listTopologies: (canvasName?: string) => Effect.Effect<ReadonlyArray<Canvas>, WorkServiceError>;
    readonly subscribeTopologyChanges: (listener: (canvasName: string) => void) => () => void;
    readonly subscribeWorkChanges: (listener: (canvasName?: string, nodeId?: string) => void) => () => void;
    /** A mailbox changed: mail landed in it, or one of its mails was delivered, read or acked. */
    readonly subscribeMailChanges: (listener: (canvasName: string, nodeId: string) => void) => () => void;
    readonly readArtifacts: (canvas: string, nodeId: string) => Effect.Effect<ReadonlyArray<Artifact>, WorkServiceError>;
    readonly readArtifact: (canvas: string, nodeId: string, id: string) => Effect.Effect<Artifact | undefined, WorkServiceError>;
    readonly readTopology: (canvas: string) => Effect.Effect<{ readonly canvas: Canvas; readonly actorRefs: ReadonlyArray<ActorRef> }, WorkServiceError>;
    readonly readTask: (canvas: string, nodeId: string, id: string) => Effect.Effect<Task | undefined, WorkServiceError>;
    readonly readMailbox: (canvas: string, nodeId: string) => Effect.Effect<ReadonlyArray<Message>, WorkServiceError>;
    readonly readMailMessage: (canvas: string, nodeId: string, messageId: string) => Effect.Effect<Message | undefined, WorkServiceError>;
    /** The newest mail seats `a` and `b` sent each other, both ways; `nodeId` is the mailbox it sits in. */
    readonly readMailBetween: (canvas: string, a: string, b: string, limit: number) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly message: Message }>, WorkServiceError>;
    /** Every mail `sender` wrote into another mailbox on the canvas, with its receipts; `nodeId` is the mailbox it sits in. */
    readonly readMailSentBy: (canvas: string, sender: string) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly message: Message }>, WorkServiceError>;
    /**
     * `readMailbox` and `readMailSentBy` as of the last commit, read on the mail
     * read worker so their SQL and IO wait leave main (mail-read-host.ts). Never
     * call them inside a write: they do not see its uncommitted rows. Where the
     * worker cannot answer, they read on main and answer the same.
     */
    readonly readMailboxSnapshot: (canvas: string, nodeId: string) => Effect.Effect<ReadonlyArray<Message>, WorkServiceError>;
    readonly readMailSentBySnapshot: (canvas: string, sender: string) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly message: Message }>, WorkServiceError>;
    /**
     * One page of each, newest first, as `msg list` pages: with no filter only
     * the page's rows are read. Same rules as the snapshot reads above.
     */
    readonly readMailboxPageSnapshot: (canvas: string, nodeId: string, page: MailPageQuery) => Effect.Effect<MailPage<Message>, WorkServiceError>;
    readonly readMailSentByPageSnapshot: (canvas: string, sender: string, page: MailPageQuery) => Effect.Effect<MailPage<{ readonly nodeId: string; readonly message: Message }>, WorkServiceError>;
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
     * A subject notice (03): one row in a seat's mailbox that a ruling or a
     * comment owes it, stamped as `sentBy`'s, the actor whose act it tells.
     * No edge or reach admits it: the applied ruling already did. Its id is
     * derived from its cause, so a row already written is not written again
     * and is no error: `written` is false.
     */
    readonly workSubjectNotice: (
      canvas: string,
      nodeId: string,
      message: Message,
      sentBy: ActorRef,
    ) => Effect.Effect<WorkOpResult<{ readonly messageId: string; readonly written: boolean }>>;
    /**
     * A comment's own row in its subject's thread (03), held at the subject's
     * node (a task, artifacts or page node), stamped as `sentBy`'s and typed
     * to no one. Reach admitted it before this is called. A row already
     * written is no error: `written` is false.
     */
    readonly workSubjectRow: (
      canvas: string,
      nodeId: string,
      message: Message,
      sentBy: ActorRef,
    ) => Effect.Effect<WorkOpResult<{ readonly messageId: string; readonly written: boolean }>>;
    /**
     * A seat's reply to mail the operator sent it. The operator has no inbox:
     * the reply is an agent-role row in the seat's own mailbox, so it is never
     * typed back into the seat, and it carries the thread it answers.
     *
     * It stays on this machine. It is written only on the machine that edits
     * the canvas, where the operator reads it, and the exchange gives any other
     * machine only mail addressed to its own seats, which this row is not. A
     * seat on another machine is refused until its row kind is reviewed.
     */
    readonly workOperatorReply: (
      canvas: string,
      nodeId: string,
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
}

export type WorkService = WorkServiceId;

export const WorkService = Context.Service<WorkService, WorkServiceShape>("@junto/WorkService");

export const WorkLive = Layer.effect(
  WorkService,
  Effect.gen(function* () {
    const model = yield* ModelService;
    const modelActors = yield* ModelActorRefs;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* WorkRepository;
    const modelRecords = yield* ModelRecords;
    const machines = yield* MachineRepository;
    // S2: ContentService is a hard WorkLive dependency (both CC + Remote graphs
    // compose it — runtime.ts / core-runtime.ts). Hard yield*, never
    // serviceOption: a missing ContentService must fail layer build, not soft-
    // degrade claim/media as "unavailable". Closed over for media claim gate +
    // raw externalize (methods stay R=never). Kernel still runs via warm
    // Runtime.runPromise so other ambient lookups cannot reintroduce the
    // empty-Context class of bug.
    const contentService = yield* ContentService;
    // The mail read worker reads the file this runtime's state engine opened;
    // a runtime with no engine file reads mail on main.
    const engine = yield* Effect.serviceOption(StateEngine);
    const mailReads = Option.isSome(engine) && engine.value.info.path !== ":memory:"
      ? workerMailReads(engine.value.info.path)
      : undefined;
    const offMain = <A, E>(
      read: () => Promise<A> | undefined,
      onMain: Effect.Effect<A, E>,
    ): Effect.Effect<A, WorkServiceError> => {
      const asked = Effect.suspend(() => {
        const answer = read();
        return answer === undefined ? onMain : Effect.tryPromise(() => answer).pipe(Effect.catch(() => onMain));
      });
      return asked.pipe(Effect.mapError(toWorkServiceError));
    };

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

    const readItem = (canvasName: string, nodeId: string, itemId: string) =>
      repository.taskItem({ canvasName, nodeId, itemId, kind: "task" }).pipe(Effect.mapError(toWorkServiceError));

    const policyRows = Effect.fn("WorkService.policyRows")(function* (
      canvasName: string, nodeId: string, ids: ReadonlyArray<string>, artifactIds: ReadonlyArray<string> = [],
    ): Effect.fn.Return<WorkPolicyRead, WorkServiceError> {
      const rows = yield* repository.taskRowsByIds(canvasName, ids).pipe(Effect.mapError(toWorkServiceError));
      const dependencies = [...new Set(rows.flatMap(({ item }) => item.dependsOn ?? []))].filter((id) => !ids.includes(id));
      const deps = yield* repository.taskRowsByIds(canvasName, dependencies).pipe(Effect.mapError(toWorkServiceError));
      const tasks = new Map<string, Task[]>();
      for (const row of [...rows, ...deps]) {
        const items = tasks.get(row.nodeId) ?? [];
        items.push(row.item); tasks.set(row.nodeId, items);
      }
      const artifacts = yield* Effect.forEach(artifactIds, (id) => repository.artifactItem(canvasName, nodeId, id).pipe(Effect.mapError(toWorkServiceError)));
      return {
        itemsOf: (board) => tasks.get(board) ?? [],
        taskAt: (board, id) => tasks.get(board)?.find((task) => task.id === id),
        artifactsOf: (board) => board === nodeId ? artifacts.filter((item): item is Artifact => item !== undefined) : [],
        artifactsByNode: new Map(),
      };
    });

    const intentBasis = (witness: { canvasName: string; seq: number }): IntentFactBasisValue =>
      Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })(
        { kind: "canvas", canvasName: witness.canvasName, seq: witness.seq });

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

    const externalizeMessage = (
      message: Message,
      owner?: ContentOwner,
    ): Effect.Effect<Message, WorkServiceError> =>
      externalizeParts(message.parts, owner).pipe(
        Effect.map((parts) => ({ ...message, parts })),
      );

    const complete = <T>(outcome: WorkMutationOutcome<T>): Effect.Effect<WorkApplyOk<T>> => Effect.succeed(outcome);

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
        | "task.create"
        | "task.claim"
        | "msg.send"
        | "msg.read"
        | "msg.reply"
        | "msg.react",
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
            if (op !== "task.claim" && !sameActor(live, actor)) {
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
        (op === "msg.read" || op === "msg.react" || op === "msg.reply") &&
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
      lane: "task",
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
      subscribeMailChanges: (listener) => repository.subscribeChanges((canvas, nodeId, kind) => {
        if (kind === "mail") listener(canvas, nodeId);
      }),
      subscribeWorkChanges: (listener) => repository.subscribeChanges((canvas, nodeId, kind) => {
        if (kind !== "mail") listener(canvas, nodeId);
      }),
      readArtifacts: (canvas, nodeId) => repository.artifactLane(canvas, nodeId).pipe(Effect.mapError(toWorkServiceError)),
      readArtifact: (canvas, nodeId, id) => repository.artifactItem(canvas, nodeId, id).pipe(Effect.mapError(toWorkServiceError)),
      readTopology: (canvas) => readTopology(canvas).pipe(Effect.map((read) => ({ canvas: read.topology, actorRefs: read.actorRefs }))),
      readTask: readItem,
      readMailbox: (canvas, nodeId) => repository.mailbox(canvas, nodeId).pipe(Effect.mapError(toWorkServiceError)),
      readMailMessage: (canvas, nodeId, messageId) => repository.mailMessage(canvas, nodeId, messageId).pipe(Effect.mapError(toWorkServiceError)),
      readMailBetween: (canvas, a, b, limit) => repository.mailBetween(canvas, a, b, limit).pipe(Effect.mapError(toWorkServiceError)),
      readMailSentBy: (canvas, sender) => repository.mailSentBy(canvas, sender).pipe(Effect.mapError(toWorkServiceError)),
      readMailboxSnapshot: (canvas, nodeId) =>
        offMain(() => mailReads?.inbox(canvas, nodeId), repository.mailbox(canvas, nodeId)),
      readMailSentBySnapshot: (canvas, sender) =>
        offMain(() => mailReads?.sentBy(canvas, sender), repository.mailSentBy(canvas, sender)),
      readMailboxPageSnapshot: (canvas, nodeId, page) =>
        offMain(
          () => mailReads?.inboxPage(canvas, nodeId, page),
          repository.mailbox(canvas, nodeId).pipe(Effect.map((messages) => pageOfInbox(messages, page))),
        ),
      readMailSentByPageSnapshot: (canvas, sender, page) =>
        offMain(
          () => mailReads?.sentByPage(canvas, sender, page),
          repository.mailSentBy(canvas, sender).pipe(Effect.map((rows) => pageOfSent(rows, page))),
        ),
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
            const policyWork = yield* policyRows(canvas, nodeId, taskId === null ? [] : [taskId]);
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
            const destination = taskId === null
              ? { kind: "mailbox" as const }
              : { kind: "task" as const, itemId: taskId };
            if (taskId !== null) yield* itemHome("task", canvas, nodeId, taskId);
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
                const { localInstallationId } = yield* installationContext;
                // Derived from (comment, owner): a second write meets
                // identity-conflict at the sink and is already written.
                const row = taskCommentNotice({
                  installationId: localInstallationId,
                  commentId: message.messageId,
                  text: message.parts
                    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
                    .join("\n"),
                  node: asNodeId(nodeId),
                  taskId,
                  recipient: asNodeId(ownerRef.nodeId),
                  sender: commentSenderOf(message, sentBy),
                });
                const notification = makeUserMessage({
                  messageId: row.messageId,
                  text: row.text,
                  contextId: canvas,
                  metadata: row.metadata,
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
                  }).pipe(
                    Effect.map((appended) => ({ value: appended.value as typeof appended.value | undefined })),
                    Effect.catchIf(
                      (error): error is WorkAuthorityError =>
                        error instanceof WorkAuthorityError && error.reason === "identity-conflict",
                      () => Effect.succeed({ value: undefined }),
                    ),
                  ),
                );
                if (delivered.disposition === "applied" && delivered.value !== undefined) {
                  messageDelivery.notifyAppended(
                    canvas,
                    ownerRef.nodeId,
                    delivered.value,
                  );
                }
                // The comment stands: a notice already written is identity-conflict,
                // above; any other failure to tell the owner is logged, never dropped.
              }).pipe(Effect.catch((error) =>
                Effect.logWarning("task comment owner notice not written", { canvas, nodeId, taskId, comment: message.messageId, error: String(error) })));
            }
            return yield* complete(outcome);
          }),
        ),

      workSubjectRow: (canvas, nodeId, message, sentBy) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            const targetNode = yield* requireNode(read.topology, nodeId);
            if (!isCommentableKind(targetNode.kind) || message.taskId != null) {
              return yield* new WorkServiceError({
                code: "illegal_kind",
                message: `a comment's row is held at a task, artifacts or page node; got kind ${targetNode.kind}`,
              });
            }
            const materializedMessage = yield* externalizeMessage(message, {
              kind: "message",
              canvasName: canvas,
              nodeId,
              recordId: message.messageId,
            });
            const outcome = yield* local(
              repository
                .appendMessage({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  message: materializedMessage,
                  sentBy,
                  destination: { kind: "mailbox" },
                })
                .pipe(
                  Effect.map(() => ({ value: true })),
                  Effect.catchIf(
                    (error): error is WorkAuthorityError =>
                      error instanceof WorkAuthorityError && error.reason === "identity-conflict",
                    () => Effect.succeed({ value: false }),
                  ),
                ),
            );
            return yield* complete({ ...outcome, value: { messageId: message.messageId, written: outcome.value } });
          }),
        ),

      workSubjectNotice: (canvas, nodeId, message, sentBy) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            const targetNode = yield* requireNode(read.topology, nodeId);
            // A peer is a seat of another machine, held in a copy: the same mailbox, written here and sent there.
            const isActor = Match.value(resolveSpec({ isGroup: false, kind: targetNode.kind === "peer" ? "agent" : targetNode.kind })).pipe(
              Match.when({ _tag: "Actor" }, () => true),
              Match.orElse(() => false),
            );
            if (!isActor || message.taskId != null) {
              return yield* new WorkServiceError({
                code: "illegal_kind",
                message: "a subject notice goes to a seat's own mailbox",
              });
            }
            const materializedMessage = yield* externalizeMessage(message, {
              kind: "message",
              canvasName: canvas,
              nodeId,
              recordId: message.messageId,
            });
            const outcome = yield* local(
              repository
                .appendMessage({
                  sink: sinkRef(canvas, nodeId),
                  basis: intentBasis(read.intentWitness),
                  message: materializedMessage,
                  sentBy,
                  destination: { kind: "mailbox" },
                })
                .pipe(
                  Effect.map((appended) => ({ value: { row: appended.value as typeof appended.value | undefined } })),
                  Effect.catchIf(
                    (error): error is WorkAuthorityError =>
                      error instanceof WorkAuthorityError && error.reason === "identity-conflict",
                    () => Effect.succeed({ value: { row: undefined } }),
                  ),
                ),
            );
            const row = outcome.value.row;
            if (row !== undefined) messageDelivery.notifyAppended(canvas, nodeId, row);
            return yield* complete({ ...outcome, value: { messageId: message.messageId, written: row !== undefined } });
          }),
        ),

      workSystemMailboxNotify: (canvas, nodeId, message) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            const targetNode = yield* requireNode(read.topology, nodeId);
            // A system notice is the operator's mail, written on the machine that edits the canvas
            // (rule 4): a seat of another machine is never told from a machine holding a copy.
            if (targetNode.kind === "peer") {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "wrong_home",
                  message: "the operator's notice to a seat of another machine is written on the machine that edits the canvas",
                }),
              );
            }
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

      workOperatorReply: (canvas, nodeId, message, sentBy) =>
        asResult(
          Effect.gen(function* () {
            const read = yield* readTopology(canvas);
            yield* requireActor(read, sentBy, nodeId, "msg.reply");
            const self = yield* machines.installationId.pipe(Effect.mapError(toWorkServiceError));
            const editor = (yield* modelRecords.canvasEditor(canvas).pipe(Effect.mapError(toWorkServiceError))) ?? self;
            if (editor !== self) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "scope_error",
                  message: "a seat answers the operator only on the machine that edits its canvas",
                }),
              );
            }
            if (message.role !== "agent" || message.taskId != null) {
              return yield* Effect.fail(
                new WorkServiceError({
                  code: "invalid",
                  message: "a reply to the operator is an agent-role mailbox row",
                }),
              );
            }
            const materializedMessage = yield* externalizeMessage(message, {
              kind: "message",
              canvasName: canvas,
              nodeId,
              recordId: message.messageId,
            });
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
              messageDelivery.notifyAppended(canvas, nodeId, outcome.value);
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
    });
  }),
);
