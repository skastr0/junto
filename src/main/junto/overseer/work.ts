/**
 * Operator-equivalent work-plane dispatch for a live overseer seat.
 *
 * Parent admits the process-bound caller and passes a main-derived
 * OverseerWorkAdmin. This module re-checks the live overseer flag and
 * compiled ActorRef at every use, never impersonates OPERATOR_SEAT_ID, and
 * never treats WorkOpResult `{ ok: false }` as success.
 */
import { Buffer } from "node:buffer";
import { Effect, Result } from "effect";
import { ulid } from "ulid";
import type { Canvas } from "@shared/model";
import { resolveMailboxTarget } from "@shared/mailbox-target";
import { sortMessagesNewestFirst } from "@shared/message-delivery";
import { makeUserMessage } from "@shared/task";
import { mailThreadOf } from "@shared/crew";
import {
  decodeOverseerArgs,
  decodeOverseerRequest,
  type OverseerArgsFor,
  type OverseerCaller,
  type OverseerOperation,
  type OverseerRequest,
} from "@shared/overseer-control";
import type { WorkErrorBody, WorkOpName } from "@shared/work-control";
import type { ActorRef } from "@shared/work-protocol";
import type { Author } from "@shared/author";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import { ContentService } from "../content/service";
import type { ModelService } from "../model/service";
import {
  admitLiveOverseer,
  admitOverseerWorkTarget,
  findNode,
  nodeTitle,
  overseerWorkAdmin,
  type OverseerWorkAdmin,
} from "../work/authz";
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
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "msg.react",
  "content.ingest",
]);

const LOCAL_CONTENT_OPERATIONS = new Set<string>([
  "content.ingest",
]);

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

const actorAuthor = (canvas: Canvas, actor: ActorRef): Author => {
  const node = findNode(canvas, actor.nodeId);
  return {
    kind: "actor",
    seatId: actor.seatId,
    nodeId: actor.nodeId,
    label: node ? nodeTitle(node) : actor.nodeId,
  };
};

const requireTarget = (
  canvas: Canvas,
  targetId: string,
  op: WorkOpName,
): Effect.Effect<void, WorkErrorBody> => {
  const admitted = admitOverseerWorkTarget(canvas, targetId, op);
  if (Result.isFailure(admitted)) return failBody(admitted.failure);
  return Effect.void;
};

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

const topologyOf = (canvasName: string) =>
  Effect.gen(function* () {
    const work = yield* WorkService;
    return yield* work.readTopology(canvasName).pipe(
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
  WorkService | ModelService | ContentService
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

    const origin = yield* topologyOf(caller.canvasName);
    const actor = yield* Effect.fromResult(
      admitLiveOverseer(origin.canvas, origin.actorRefs, caller, admin),
    );
    const canvas = canvasOf(caller, namedCanvas(decoded.args));
    const read = canvas === caller.canvasName ? origin : yield* topologyOf(canvas);
    const work = yield* WorkService;
    const author = actorAuthor(origin.canvas, actor);
    const raw = decoded.args;
    const op = decoded.operation;

    if (op === "msg.list") {
      const args = yield* decodeArgs(op, raw);
      const targetId = resolveMailboxTarget(args.target, caller);
      if (targetId === caller.nodeId) {
        const items = yield* catchWork(work.readMailbox(caller.canvasName, caller.nodeId));
        return { target: caller.nodeId, items: sortMessagesNewestFirst(items) };
      }
      yield* requireTarget(read.canvas, targetId, "msg.list");
      return {
        target: targetId,
        items: sortMessagesNewestFirst(
          yield* catchWork(work.readMailbox(caller.canvasName, targetId)),
        ),
      };
    }
    if (op === "msg.send") {
      const args = yield* decodeArgs(op, raw);
      const target = targetOf(caller, args.target);
      yield* requireTarget(read.canvas, target, "msg.send");
      const result = yield* work.workMessageAppend(
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
      yield* requireTarget(read.canvas, target, "msg.send");
      // A reply joins its parent's thread, as every seat's reply does.
      const parent = yield* work.readMailMessage(canvas, caller.nodeId, args.inReplyTo).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      const sent = yield* work.workMessageAppend(
        canvas,
        target,
        null,
        makeUserMessage({
          messageId: ulid(),
          text: `[factory mail from ${actor.nodeId}] ${args.text}`,
          contextId: canvas,
          metadata: {
            factoryMail: true,
            fromSeat: actor.nodeId,
            inReplyTo: args.inReplyTo,
            ...(parent === undefined ? {} : { threadId: mailThreadOf(parent) }),
          },
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
    return yield* failBody({
      type: "InputError",
      message: `operation "${op}" is not a work-plane overseer command`,
      details: { retryable: false },
    });
  });

/** True when parent should keep this op on the caller installation (Remote-safe). */
export const overseerWorkRunsLocally = (operation: OverseerOperation): boolean =>
  LOCAL_CONTENT_OPERATIONS.has(operation);
