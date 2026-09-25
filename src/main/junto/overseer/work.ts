/**
 * Operator-equivalent work-plane dispatch for a live overseer seat.
 *
 * Parent admits the process-bound caller and passes a main-derived
 * OverseerWorkAdmin. This module re-checks the live ether.overseer flag and
 * compiled ActorRef at every use, never impersonates OPERATOR_SEAT_ID, and
 * never treats WorkOpResult `{ ok: false }` as success.
 */
import { Buffer } from "node:buffer";
import { Effect, Result } from "effect";
import { ulid } from "ulid";
import type { Artifact, CanvasDoc, Part } from "@shared/canvas";
import { resolveMailboxTarget } from "@shared/mailbox-target";
import { sortMessagesNewestFirst } from "@shared/message-delivery";
import { padLookHere, padToFocused } from "@shared/pad-project";
import { makeUserMessage } from "@shared/task";
import {
  decodeOverseerArgs,
  decodeOverseerRequest,
  type OverseerArgsFor,
  type OverseerCaller,
  type OverseerOperation,
  type OverseerRequest,
} from "@shared/overseer-control";
import { workControlDir, WORK_HOME_ENV } from "@shared/work-control";
import type { WorkErrorBody, WorkOpName } from "@shared/work-control";
import { resolveJuntoHome } from "@shared/junto-home";
import type { ActorRef } from "@shared/work-protocol";
import type { BoardAuthor } from "@shared/work-model";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import { CanvasesService } from "../canvases";
import { ContentService } from "../content/service";
import {
  materializeContentObject,
  taskContentRef,
} from "../content/agent-access";
import { contentObjectPath } from "../content/paths";
import { ContentStoreError } from "../content/store";
import {
  admitLiveOverseer,
  admitOverseerWorkTarget,
  findNode,
  nodeKind,
  nodeTitle,
  overseerWorkAdmin,
  scopeError,
  type OverseerWorkAdmin,
} from "../work/authz";
import { deliverBoardWake } from "../work/board-delivery";
import {
  WorkService,
  WorkServiceError,
  type WorkOpResult,
  type WorkServiceErrorCode,
} from "../work/service";

export type { OverseerWorkAdmin } from "../work/authz";
export { overseerWorkAdmin };

export type OverseerWorkCaller = OverseerCaller;

const WORK_OPERATIONS = new Set<string>([
  "tasks.list",
  "tasks.create",
  "tasks.claim",
  "tasks.describe",
  "tasks.update",
  "tasks.show",
  "tasks.rules",
  "tasks.check",
  "tasks.promote",
  "tasks.comment",
  "tasks.respond",
  "request.list",
  "request.get",
  "request.create",
  "request.resolve",
  "request.comment",
  "artifact.list",
  "artifact.get",
  "artifact.publish",
  "artifact.archive",
  "artifact.delete",
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "msg.react",
  "board.list",
  "board.create-topic",
  "board.post",
  "board.mark-read",
  "board.tags",
  "board.notify",
  "pad.read",
  "pad.patch",
  "pad.digest",
  "pad.render",
  "pad.look-here",
  "pad.get",
  "pad.tagged",
  "content.ingest",
  "content.path",
  "content.stat",
  "content.materialize",
]);

const LOCAL_CONTENT_OPERATIONS = new Set<string>([
  "content.ingest",
  "content.path",
  "content.stat",
  "content.materialize",
]);

const callerWorkHome = (): string => {
  const env = process.env[WORK_HOME_ENV]?.trim();
  if (env) return env;
  return workControlDir(resolveJuntoHome());
};

const mapWorkCode = (
  code: WorkServiceErrorCode,
  message: string,
  details?: WorkErrorBody["details"],
): WorkErrorBody => {
  switch (code) {
    case "claim_contention":
    case "operator_owned":
      return { type: "ClaimConflict", message, details: { ...details, retryable: false } };
    case "illegal_transition":
      return { type: "InvalidTransition", message, details: { ...details, retryable: false } };
    case "node_not_found":
    case "task_not_found":
      return { type: "UnknownTarget", message, details: { ...details, retryable: false } };
    case "canvas_not_found":
      return { type: "StaleNodeRef", message, details: { ...details, retryable: false } };
    case "illegal_kind":
      return { type: "ScopeError", message, details: { ...details, retryable: false } };
    default:
      return { type: "InputError", message, details: { ...details, retryable: false } };
  }
};

const failBody = (error: WorkErrorBody): Effect.Effect<never, WorkErrorBody> =>
  Effect.fail(error);

const fromWorkResult = <T>(
  result: WorkOpResult<T>,
): Effect.Effect<
  { readonly value: T; readonly disposition: "applied" | "queued"; readonly message?: string },
  WorkErrorBody
> => {
  if (result.ok) {
    return Effect.succeed({
      value: result.data,
      disposition: result.disposition,
      ...(result.message === undefined ? {} : { message: result.message }),
    });
  }
  return failBody(mapWorkCode(result.code, result.message, result.details));
};

const exposeMutation = <T extends object>(
  outcome: {
    readonly value: T;
    readonly disposition: "applied" | "queued";
    readonly message?: string;
  },
): T & { readonly disposition: "applied" | "queued"; readonly message?: string } => ({
  ...outcome.value,
  disposition: outcome.disposition,
  ...(outcome.message === undefined ? {} : { message: outcome.message }),
});

const canvasOf = (
  caller: OverseerWorkCaller,
  named?: string,
): string => named ?? caller.canvasName;

const namedCanvas = (raw: unknown): string | undefined => {
  if (raw !== null && typeof raw === "object" && "canvas" in raw) {
    const value = (raw as { readonly canvas?: unknown }).canvas;
    if (typeof value === "string") return value;
  }
  return undefined;
};

const actorAuthor = (doc: CanvasDoc, actor: ActorRef): BoardAuthor => {
  const node = findNode(doc, actor.nodeId);
  return {
    kind: "actor",
    seatId: actor.seatId,
    nodeId: actor.nodeId,
    label: node ? nodeTitle(node) : actor.nodeId,
  };
};

const requireTarget = (
  doc: CanvasDoc,
  targetId: string,
  op: WorkOpName,
): Effect.Effect<void, WorkErrorBody> => {
  const admitted = admitOverseerWorkTarget(doc, targetId, op);
  if (Result.isFailure(admitted)) return failBody(admitted.failure);
  return Effect.void;
};

/** Request administration targets a Requests node, admitted like its thread. */
const requireRequestsTarget = (
  doc: CanvasDoc,
  targetId: string,
): Effect.Effect<void, WorkErrorBody> =>
  Effect.gen(function* () {
    yield* requireTarget(doc, targetId, "msg.list");
    const kind = nodeKind(findNode(doc, targetId));
    if (kind !== "requests") {
      return yield* failBody(
        scopeError("overseer", targetId, "wrong_kind", { kind, op: "msg.list" }),
      );
    }
  });

const decodeRequest = (
  request: OverseerRequest,
): Effect.Effect<OverseerRequest, WorkErrorBody> => {
  const decoded = decodeOverseerRequest(request);
  if (Result.isFailure(decoded)) {
    return failBody({
      type: "InputError",
      message: decoded.failure.message,
      details: { path: "request", retryable: false },
    });
  }
  return Effect.succeed(decoded.success);
};

const decodeArgs = <Operation extends OverseerOperation>(
  operation: Operation,
  args: unknown,
): Effect.Effect<OverseerArgsFor<Operation>, WorkErrorBody> => {
  const decoded = decodeOverseerArgs(operation, args);
  if (Result.isFailure(decoded)) {
    return failBody({
      type: "InputError",
      message: decoded.failure.message,
      details: { path: "args", retryable: false },
    });
  }
  return Effect.succeed(decoded.success);
};

const readCanvas = (canvasName: string) =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    return yield* canvases.read(canvasName).pipe(
      Effect.mapError((error): WorkErrorBody => ({
        type: "UnknownTarget",
        message: error.message,
        details: { retryable: false },
      })),
    );
  });

const catchWork = <A>(
  effect: Effect.Effect<A, WorkServiceError>,
): Effect.Effect<A, WorkErrorBody> =>
  effect.pipe(
    Effect.mapError((error): WorkErrorBody =>
      mapWorkCode(error.code, error.message, error.details),
    ),
  );

const targetOf = (caller: OverseerWorkCaller, named?: string): string =>
  named ?? caller.nodeId;

/**
 * Execute one overseer work-plane operation.
 *
 * `admin` is main-derived. Live grant + compiled ActorRef are re-checked here
 * so a forged `{ kind: "overseer" }` cannot skip edges. Content path/stat/
 * materialize/ingest run on the caller installation (usable local paths);
 * other mutations keep existing WorkService home/disposition routing.
 */
export const executeOverseerWork = (
  caller: OverseerWorkCaller,
  request: OverseerRequest,
  admin: OverseerWorkAdmin,
): Effect.Effect<
  unknown,
  WorkErrorBody,
  WorkService | CanvasesService | ContentService
> =>
  Effect.gen(function* () {
    if (admin.kind !== "overseer") {
      return yield* failBody({
        type: "AuthError",
        message: "overseer admin kind is invalid",
        details: { caller: caller.nodeId, retryable: false, missing: "overseer grant" },
      });
    }
    if (
      admin.actor.seatId === OPERATOR_SEAT_ID ||
      admin.actor.nodeId === "operator"
    ) {
      return yield* failBody({
        type: "AuthError",
        message: "overseer provenance cannot use the operator seat",
        details: { caller: caller.nodeId, retryable: false, missing: "overseer grant" },
      });
    }

    const decoded = yield* decodeRequest(request);
    if (!WORK_OPERATIONS.has(decoded.operation)) {
      return yield* failBody({
        type: "InputError",
        message: `operation "${decoded.operation}" is not a work-plane overseer command`,
        details: { retryable: false },
      });
    }

    const origin = yield* readCanvas(caller.canvasName);
    const actor = yield* Effect.fromResult(
      admitLiveOverseer(origin.doc, origin.actorRefs, caller, admin),
    );
    const canvas = canvasOf(caller, namedCanvas(decoded.args));
    const read = canvas === caller.canvasName ? origin : yield* readCanvas(canvas);
    const work = yield* WorkService;
    const author = actorAuthor(origin.doc, actor);
    const raw = decoded.args;
    const op = decoded.operation;

    if (op === "tasks.list") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.list");
      return { target, items: findNode(read.doc, target)?.ether?.tasks?.items ?? [] };
    }
    if (op === "tasks.create") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.create");
      const result = yield* work.workTaskCreate(
        canvas,
        target,
        args.brief,
        args.metadata,
        args.reason,
        args.media,
        args.dependsOn,
        args.finishCriteria,
        args.rules,
        {
          admission: args.admission,
          admissionOmitted: "inherit",
          ...(args.waitFor !== undefined ? { waitForMs: args.waitFor } : {}),
          raisedBy: actor,
        },
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "tasks.claim") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.claim");
      const assignee =
        args.actor === undefined
          ? actor
          : (yield* readCanvas(canvas)).actorRefs.find(
              (candidate) =>
                candidate.canvasName === canvas && candidate.nodeId === args.actor,
            ) ??
            origin.actorRefs.find(
              (candidate) => candidate.nodeId === args.actor,
            );
      if (assignee === undefined) {
        return yield* failBody({
          type: "UnknownTarget",
          message: `actor "${args.actor}" is not a compiled seat`,
          details: { target: args.actor, retryable: false },
        });
      }
      const result = yield* work.workTaskClaim(canvas, target, args.task, assignee, admin);
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "tasks.describe") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.update");
      const result = yield* work.workTaskDescribe(canvas, target, args.task, args.brief);
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "tasks.update") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.update");
      const result = yield* work.workTaskTransition(
        canvas,
        target,
        args.task,
        args.state,
        args.note,
        args.completionEvidence,
        {
          ...(args.next !== undefined ? { next: args.next } : {}),
          ...(args.defect !== undefined ? { defect: args.defect } : {}),
          ...(args.waitFor !== undefined ? { waitForMs: args.waitFor } : {}),
          ...(args.handoffNote !== undefined ? { handoffNote: args.handoffNote } : {}),
        },
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "tasks.show") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.show");
      return yield* catchWork(work.workTaskShow(canvas, target, args.task, "operator"));
    }
    if (op === "tasks.rules") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.rules");
      return yield* catchWork(work.workTaskRules(canvas, target, args.task));
    }
    if (op === "tasks.check") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.check");
      const result = yield* work.workTaskCheck(
        canvas,
        target,
        args.task,
        args.results,
        args.next,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "tasks.promote") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.update");
      const result = yield* work.workTaskPromote(canvas, target, args.task, args.note, admin);
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "tasks.comment") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.update");
      const result = yield* work.workTaskComment(
        canvas,
        target,
        args.task,
        makeUserMessage({
          messageId: ulid(),
          text: args.text,
          contextId: canvas,
          taskId: args.task,
          metadata: {
            taskComment: true,
            fromSeat: actor.nodeId,
            "junto.taskThread.kind": "comment",
          },
        }),
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "tasks.respond") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "tasks.update");
      const result = yield* work.workTaskRespond(
        canvas,
        target,
        args.task,
        args.responseText,
        args.disposition,
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "request.list") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireRequestsTarget(read.doc, target);
      return { target, items: findNode(read.doc, target)?.ether?.requests?.items ?? [] };
    }
    if (op === "request.get") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireRequestsTarget(read.doc, target);
      const item = (findNode(read.doc, target)?.ether?.requests?.items ?? []).find(
        (candidate) => candidate.id === args.request,
      );
      if (item === undefined) {
        return yield* failBody({
          type: "UnknownTarget",
          message: `request "${args.request}" not found`,
          details: { target: args.request, retryable: false },
        });
      }
      return { target, request: item };
    }
    if (op === "request.create") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireRequestsTarget(read.doc, target);
      const result = yield* work.workRequestCreate(
        canvas,
        target,
        args.brief,
        args.metadata,
        actor,
        args.reason,
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "request.resolve") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireRequestsTarget(read.doc, target);
      const result = yield* work.workRequestResolve(
        canvas,
        target,
        args.request,
        args.responseText,
        args.disposition,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "request.comment") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "msg.send");
      const result = yield* work.workMessageAppend(
        canvas,
        target,
        args.request,
        makeUserMessage({
          messageId: ulid(),
          text: args.text,
          contextId: canvas,
          taskId: args.request,
          metadata: { fromSeat: actor.nodeId },
        }),
        actor,
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "artifact.list") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "artifact.publish");
      return { target, items: findNode(read.doc, target)?.ether?.artifacts?.items ?? [] };
    }
    if (op === "artifact.get") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "artifact.publish");
      const item = (findNode(read.doc, target)?.ether?.artifacts?.items ?? []).find(
        (candidate) => candidate.artifactId === args.artifact,
      );
      if (item === undefined) {
        return yield* failBody({
          type: "UnknownTarget",
          message: `artifact "${args.artifact}" not found`,
          details: { target: args.artifact, retryable: false },
        });
      }
      return { target, artifact: item };
    }
    if (op === "artifact.publish") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "artifact.publish");
      const artifact: Artifact = {
        artifactId: args.artifactId?.trim() || ulid(),
        parts: args.parts as Part[],
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.task !== undefined
          ? {
              task: {
                kind: "task" as const,
                itemId: args.task.id,
                sink: { canvasName: canvas, nodeId: args.task.target },
              },
            }
          : {}),
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      };
      const result = yield* work.workArtifactPublish(canvas, target, artifact, actor, admin);
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "artifact.archive") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "artifact.publish");
      const result = yield* work.workArtifactArchive(
        canvas,
        target,
        args.artifact,
        args.archived,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "artifact.delete") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "artifact.publish");
      const result = yield* work.workArtifactDelete(canvas, target, args.artifact);
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "msg.list") {
      const args = yield* decodeArgs(op, raw);
      const targetId = resolveMailboxTarget(args.target, caller);
      if (args.taskId) {
        yield* requireTarget(read.doc, targetId, "msg.list");
        const node = findNode(read.doc, targetId);
        const kind = nodeKind(node);
        const list =
          kind === "task"
            ? node?.ether?.tasks?.items ?? []
            : node?.ether?.requests?.items ?? [];
        const task = list.find((item) => item.id === args.taskId);
        if (!task) {
          return yield* failBody({
            type: "UnknownTarget",
            message: `task "${args.taskId}" not found`,
            details: { target: args.taskId, retryable: false },
          });
        }
        return { target: targetId, taskId: task.id, items: task.history };
      }
      if (targetId === caller.nodeId) {
        const items = findNode(read.doc, caller.nodeId)?.ether?.messages?.items ?? [];
        return { target: caller.nodeId, items: sortMessagesNewestFirst(items) };
      }
      yield* requireTarget(read.doc, targetId, "msg.list");
      return {
        target: targetId,
        items: sortMessagesNewestFirst(
          findNode(read.doc, targetId)?.ether?.messages?.items ?? [],
        ),
      };
    }
    if (op === "msg.send") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "msg.send");
      const result = yield* work.workMessageAppend(
        canvas,
        target,
        args.taskId ?? null,
        makeUserMessage({
          messageId: ulid(),
          text: `[factory mail from ${actor.nodeId}] ${args.text}`,
          contextId: canvas,
          ...(args.taskId ? { taskId: args.taskId } : {}),
          metadata: { factoryMail: true, fromSeat: actor.nodeId },
        }),
        actor,
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "msg.read") {
      const args = yield* decodeArgs(op, raw);
      const targetId = resolveMailboxTarget(args.target, caller);
      const result = yield* work.workMessageMarkRead(
        canvas,
        targetId,
        args.messageId,
        actor,
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "msg.reply") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "msg.send");
      const sent = yield* work.workMessageAppend(
        canvas,
        target,
        null,
        makeUserMessage({
          messageId: ulid(),
          text: `[factory mail from ${actor.nodeId}] ${args.text}`,
          contextId: canvas,
          metadata: { factoryMail: true, fromSeat: actor.nodeId },
        }),
        actor,
        admin,
      );
      const sentOk = yield* fromWorkResult(sent);
      const marked = yield* work.workMessageMarkRead(
        canvas,
        caller.nodeId,
        args.inReplyTo,
        actor,
        admin,
      );
      const markedOk = yield* fromWorkResult(marked);
      return {
        ...exposeMutation(sentOk),
        inReplyTo: args.inReplyTo,
        read: exposeMutation(markedOk),
      };
    }
    if (op === "msg.react") {
      const args = yield* decodeArgs(op, raw);
      const targetId = resolveMailboxTarget(args.target, caller);
      const result = yield* work.workMessageReact(
        canvas,
        targetId,
        args.messageId,
        args.reaction ?? "ack",
        actor,
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "board.list") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "board.list");
      const result = yield* work.workBoardList(canvas, target, args.topicId);
      const mapped = yield* fromWorkResult(result);
      return { topics: mapped.value.topics };
    }
    if (op === "board.create-topic") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "board.create_topic");
      const result = yield* work.workBoardCreateTopic(
        canvas,
        target,
        args.title,
        args.body,
        author,
        args.notify === true,
      );
      const mapped = yield* fromWorkResult(result);
      if (mapped.disposition === "applied" && args.notify === true) {
        yield* deliverBoardWake({
          canvas,
          boardNodeId: target,
          kind: "operator.topic.notify",
          topicId: mapped.value.topic.topicId,
          topicTitle: mapped.value.topic.title,
          excerptSource: args.title,
        }).pipe(Effect.catch(() => Effect.succeed(0)));
      }
      return exposeMutation(mapped);
    }
    if (op === "board.post") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "board.post");
      const result = yield* work.workBoardPost(
        canvas,
        target,
        args.topicId,
        args.text,
        author,
        args.tags,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "board.mark-read") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "board.mark_read");
      const result = yield* work.workBoardMarkRead(
        canvas,
        target,
        args.topicId,
        `seat:${actor.seatId}`,
        args.upToPosition,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "board.tags") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "board.tags");
      const result = yield* work.workBoardList(canvas, target, args.topicId);
      const mapped = yield* fromWorkResult(result);
      const me = actor.nodeId;
      const posts = mapped.value.topics.flatMap((topic) =>
        (topic.posts ?? [])
          .filter((post) => Array.isArray(post.tags) && post.tags.includes(me))
          .map((post) => ({
            topicId: topic.topicId,
            topicTitle: topic.title,
            post,
          })),
      );
      return { actorNodeId: me, posts };
    }
    if (op === "board.notify") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "board.list");
      const wakeCount = yield* deliverBoardWake({
        canvas,
        boardNodeId: target,
        kind: "operator.notify.all",
        topicId: args.topicId,
        excerptSource: args.topicId ? `notify topic ${args.topicId}` : "notify all",
      });
      return { wakeCount, disposition: "applied" as const };
    }
    if (op === "pad.read") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "pad.read");
      const result = yield* work.workPadRead(canvas, target, args.pinId);
      return (yield* fromWorkResult(result)).value;
    }
    if (op === "pad.digest") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "pad.read");
      const result = yield* work.workPadRead(canvas, target);
      const value = (yield* fromWorkResult(result)).value;
      return { revision: value.revision, digest: value.digest };
    }
    if (op === "pad.render") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "pad.read");
      const result = yield* work.workPadRead(canvas, target);
      const value = (yield* fromWorkResult(result)).value;
      return { revision: value.revision, svg: value.svg };
    }
    if (op === "pad.look-here") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "pad.read");
      const result = yield* work.workPadRead(canvas, target, args.pinId);
      const value = (yield* fromWorkResult(result)).value;
      const focused =
        value.lookHere ??
        (() => {
          const crop = padLookHere(value.pad, args.pinId);
          return Result.isSuccess(crop) ? crop.success : undefined;
        })();
      if (focused === undefined) {
        return yield* failBody({
          type: "InputError",
          message: `pin "${args.pinId}" is not on this pad`,
          details: { path: "pinId", retryable: false },
        });
      }
      return { revision: value.revision, pinId: args.pinId, ...focused };
    }
    if (op === "pad.get") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "pad.read");
      const result = yield* work.workPadRead(canvas, target);
      const value = (yield* fromWorkResult(result)).value;
      const items = padToFocused(value.pad);
      if (args.id === undefined) return { revision: value.revision, items };
      const found = items.filter((item) => item.id === args.id);
      if (found.length === 0) {
        return yield* failBody({
          type: "InputError",
          message: `element "${args.id}" is not on this pad`,
          details: { path: "id", retryable: false },
        });
      }
      return { revision: value.revision, items: found };
    }
    if (op === "pad.tagged") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "pad.read");
      const result = yield* work.workPadRead(canvas, target);
      const value = (yield* fromWorkResult(result)).value;
      return {
        revision: value.revision,
        pins: value.pad.pins.filter((pin) => pin.mentions.includes(actor.nodeId)),
      };
    }
    if (op === "pad.patch") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "pad.patch");
      const result = yield* work.workPadPatch(canvas, target, args.patches, author, admin);
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "content.ingest") {
      const args = yield* decodeArgs(op, raw);
      const content = yield* ContentService;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(args.bytesBase64, "base64");
      } catch {
        return yield* failBody({
          type: "InputError",
          message: "bytesBase64 is not valid base64",
          details: { path: "bytesBase64", retryable: false },
        });
      }
      if (bytes.length === 0) {
        return yield* failBody({
          type: "InputError",
          message: "bytesBase64 decoded to empty bytes",
          details: { path: "bytesBase64", retryable: false },
        });
      }
      const ingested = yield* content.put({
        source: bytes,
        mediaType: args.mediaType,
        ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
        ...(args.expected !== undefined ? { expected: args.expected } : {}),
      }).pipe(
        Effect.mapError((error): WorkErrorBody => ({
          type: "InternalError",
          message: error instanceof Error ? error.message : String(error),
          details: { retryable: true },
        })),
      );
      return {
        ref: ingested.ref,
        created: ingested.created,
        disposition: "applied" as const,
      };
    }
    if (op === "content.path" || op === "content.stat") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "content.path");
      const node = findNode(read.doc, target);
      const task = (node?.ether?.tasks?.items ?? []).find(
        (candidate) => candidate.id === args.task,
      );
      if (task === undefined) {
        return yield* failBody({
          type: "UnknownTarget",
          message: `task "${args.task}" not found on target "${target}"`,
          details: { target: args.task, retryable: false },
        });
      }
      const authorizedRef = taskContentRef(task, args.ref);
      if (authorizedRef === undefined) {
        return yield* failBody({
          type: "ScopeError",
          message: `content ref is not attached to task "${args.task}"`,
          details: { target, caller: caller.nodeId, retryable: false },
        });
      }
      const content = yield* ContentService;
      const availability = yield* content.availability(authorizedRef).pipe(
        Effect.mapError((error): WorkErrorBody => ({
          type: "InternalError",
          message: error.message,
          details: { retryable: true },
        })),
      );
      const base = {
        target,
        task: args.task,
        ref: authorizedRef,
        availability,
        state: availability.state,
      };
      if (availability.state !== "verified") return base;
      return {
        ...base,
        path: contentObjectPath(content.root, authorizedRef.sha256),
      };
    }
    if (op === "content.materialize") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.doc, target, "content.materialize");
      const node = findNode(read.doc, target);
      const task = (node?.ether?.tasks?.items ?? []).find(
        (candidate) => candidate.id === args.task,
      );
      if (task === undefined) {
        return yield* failBody({
          type: "UnknownTarget",
          message: `task "${args.task}" not found on target "${target}"`,
          details: { target: args.task, retryable: false },
        });
      }
      const authorizedRef = taskContentRef(task, args.ref);
      if (authorizedRef === undefined) {
        return yield* failBody({
          type: "ScopeError",
          message: `content ref is not attached to task "${args.task}"`,
          details: { target, caller: caller.nodeId, retryable: false },
        });
      }
      const content = yield* ContentService;
      const availability = yield* content.availability(authorizedRef).pipe(
        Effect.mapError((error): WorkErrorBody => ({
          type: "InternalError",
          message: error.message,
          details: { retryable: true },
        })),
      );
      const base = {
        target,
        task: args.task,
        ref: authorizedRef,
        availability,
        state: availability.state,
      };
      if (availability.state !== "verified") return base;
      const canonicalPath = contentObjectPath(content.root, authorizedRef.sha256);
      const materialized = yield* Effect.tryPromise({
        try: () =>
          materializeContentObject({
            contentRoot: content.root,
            workHome: callerWorkHome(),
            canvasName: canvas,
            targetNodeId: target,
            taskId: args.task,
            ref: authorizedRef,
            name: args.name,
          }),
        catch: (error): WorkErrorBody => {
          const invalidInput =
            error instanceof ContentStoreError && error.code === "invalid";
          return {
            type: invalidInput ? "InputError" : "InternalError",
            message: error instanceof Error ? error.message : String(error),
            details: { retryable: !invalidInput },
          };
        },
      });
      return {
        ...base,
        path: materialized.path,
        canonicalPath,
        materialized: materialized.created,
      };
    }

    return yield* failBody({
      type: "InputError",
      message: `operation "${op}" is not a work-plane overseer command`,
      details: { retryable: false },
    });
  });

/** True when parent should keep this op on the caller installation (Remote-safe). */
export const overseerWorkRunsLocally = (operation: OverseerOperation): boolean =>
  LOCAL_CONTENT_OPERATIONS.has(operation);
