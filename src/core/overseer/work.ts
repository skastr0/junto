/**
 * Operator-equivalent work-plane dispatch for a live overseer seat.
 *
 * Parent admits the process-bound caller and passes a main-derived
 * OverseerWorkAdmin. This module re-checks the live overseer flag and
 * compiled ActorRef at every use, never impersonates OPERATOR_SEAT_ID, and
 * never treats WorkOpResult `{ ok: false }` as success.
 */
import { Buffer } from "node:buffer";
import { Effect, Option, Result } from "effect";
import { ulid } from "ulid";
import type { Canvas } from "@shared/model";
import { resolveMailboxTarget } from "@shared/mailbox-target";
import { sortMessagesNewestFirst } from "@shared/message-delivery";
import { makeUserMessage } from "@shared/task";
import { mailExtensionMetadata, mailThreadOf } from "@shared/crew";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
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
import { messageDelivery } from "../work/message-delivery";
import { seatStateRuntime } from "../term/agent-state/runtime";
import { thisMachineName } from "../term/machine-name";
import { checkBroadcastSet, readAudience, type Audience, type AudienceReadings } from "./broadcast";
import { mailSenderStamp } from "../work-control/mail";
import type { WorkCaller } from "../work-control/seat";
import { AgentSignalRepository } from "../signals/repository";
import { RemoteSeatState } from "../term/remote-seat-state";
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
  "msg.audience",
  "msg.broadcast",
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
 * The mail an overseer writes, as its own seat: one definition for msg.send,
 * msg.reply and each mail of a broadcast, so none ever reads as the operator's.
 */
const overseerMail = (
  canvas: string,
  actor: ActorRef,
  text: string,
  extra: NonNullable<Parameters<typeof makeUserMessage>[0]["metadata"]> = {},
) =>
  makeUserMessage({
    messageId: ulid(),
    text: `[factory mail from ${actor.nodeId}] ${text}`,
    contextId: canvas,
    metadata: { factoryMail: true, fromSeat: actor.nodeId, ...extra },
  });

/**
 * The overseer as a mail sender stamp reads it: its own seat's name, regions,
 * harness and live epoch. An overseer call carries no generation credential,
 * so with no live epoch the stamp says unknown, as it does for the harness.
 */
const overseerStampCaller = (caller: OverseerWorkCaller): WorkCaller => ({
  canvasName: caller.canvasName,
  nodeId: caller.nodeId,
  workHome: caller.canvasName,
  occupant: caller.nodeId,
  generation: "unknown",
});

/**
 * What the core holds of each seat, read for one broadcast set: this machine's
 * name, a seat's state here, a seat's state its own machine reported, and the
 * canvas's signals. With no signal store, no seat needs anything; with no
 * remote seat state, no seat elsewhere is current.
 */
const audienceReadings = (canvasName: string): Effect.Effect<AudienceReadings, WorkErrorBody> =>
  Effect.gen(function* () {
    const machineName = yield* Effect.try({
      try: () => thisMachineName(),
      catch: (): WorkErrorBody => ({
        type: "RuntimeDown",
        message: "Junto has not loaded this machine's name yet, so the set cannot tell the seats here from those elsewhere",
        details: { retryable: true, next_step: "send again in a moment" },
      }),
    });
    const store = yield* Effect.serviceOption(AgentSignalRepository);
    const signals = Option.isNone(store)
      ? []
      : yield* store.value.listCanvas(canvasName).pipe(
          Effect.mapError((error): WorkErrorBody => ({
            type: "RuntimeDown",
            message: `the seats' signals could not be read: ${error.message}`,
            details: { retryable: true },
          })),
        );
    const remote = yield* Effect.serviceOption(RemoteSeatState);
    const remoteEvents = Option.isNone(remote)
      ? new Map<string, AgentSeatStateEvent>()
      : new Map(remote.value.events().map((event) => [event.bindingId, event] as const));
    return {
      machineName,
      localState: (bindingId) => seatStateRuntime.getState(bindingId),
      remoteState: (bindingId) => ({
        event: remoteEvents.get(bindingId),
        current: Option.isSome(remote) && remote.value.current(bindingId),
      }),
      signals,
    } satisfies AudienceReadings;
  });

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
        overseerMail(canvas, actor, args.text),
        actor,
        admin,
      );
      return exposeMutation(yield* fromWorkResult(result));
    }
    if (op === "msg.audience") {
      const args = yield* decodeArgs(op, raw);
      const readings = yield* audienceReadings(caller.canvasName);
      return yield* Effect.fromResult(readAudience({
        canvasName: caller.canvasName,
        canvas: origin.canvas,
        callerId: caller.nodeId,
        selection: args,
        readings,
      }));
    }
    if (op === "msg.broadcast") {
      // The text was checked by the decode, before the set is read.
      const args = yield* decodeArgs(op, raw);
      const readings = yield* audienceReadings(caller.canvasName);
      let audience: Audience | undefined;
      // One transaction for the whole set: the live grant, the set read again
      // and every row. A revoke, a changed set or a failure at any seat leaves
      // no thread at all.
      const written = yield* work.workMessageAppendAll(
        caller.canvasName,
        (topology) =>
          Effect.gen(function* () {
            const read = yield* Effect.fromResult(
              Result.flatMap(
                readAudience({ canvasName: caller.canvasName, canvas: topology, callerId: caller.nodeId, selection: args, readings }),
                (set) => checkBroadcastSet(set, { expect: args.expect, ...(args.set === undefined ? {} : { set: args.set }) }),
              ),
            );
            audience = read;
            const stamp = mailSenderStamp(topology, overseerStampCaller(caller), actor);
            return read.seats.map((seat) => {
              // A new root: its id is the thread's. Stamped here, never taken from the arguments.
              const message = overseerMail(caller.canvasName, actor, args.text, mailExtensionMetadata({
                ...stamp,
                mailKind: "notice",
                broadcast: true,
                // Stored on the row: a seat that is not up is never started by it, across a restart too.
                noWake: true,
              }));
              // Held in memory too, before the commit, as delivery reads both.
              messageDelivery.holdWake(message.messageId);
              return { nodeId: seat.nodeId, message };
            });
          }),
        actor,
        admin,
      ).pipe(
        Effect.mapError((error): WorkErrorBody =>
          error instanceof WorkServiceError ? mapWorkCode(error.code, error.message, error.details) : error),
      );
      const set = audience!;
      const bySeat = new Map(set.seats.map((seat) => [seat.nodeId, seat] as const));
      // After the commit: each seat's delivery state, as msg.send answers it for one.
      const seats = yield* Effect.forEach(written, (row) =>
        Effect.promise(() => messageDelivery.deliver(caller.canvasName, row.nodeId, row.message.messageId)).pipe(
          Effect.map((delivery) => {
            const seat = bySeat.get(row.nodeId)!;
            return {
              nodeId: row.nodeId,
              name: seat.name,
              running: seat.running,
              elsewhere: seat.elsewhere,
              messageId: row.message.messageId,
              threadId: row.message.messageId,
              delivery,
            };
          }),
        ), { concurrency: "unbounded" });
      return {
        count: set.count,
        set: set.set,
        picks: set.picks,
        notRunning: set.notRunning,
        elsewhere: set.elsewhere,
        unread: set.unread,
        seats,
      };
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
        overseerMail(canvas, actor, args.text, {
          inReplyTo: args.inReplyTo,
          ...(parent === undefined ? {} : { threadId: mailThreadOf(parent) }),
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
