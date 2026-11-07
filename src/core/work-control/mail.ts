/**
 * Mail as the work socket's msg ops read and write it: a seat's view of a
 * mail, who a mail goes to, and who sent it.
 */
import { Effect, Result, Option } from "effect";
import { type Message } from "@shared/work-model";
import { MAIL_MESSAGE_ID_SHAPE, isMailMessageId, mailThreadOf, type MailSenderStamp } from "@shared/crew";
import { operatorFilesOf } from "@shared/mail-threads";
import { seatStateRuntime } from "../term/agent-state";
import { type ActorRef } from "@shared/work-protocol";
import { type WorkOpName, type WorkErrorBody } from "@shared/work-control";
import { type WorkCaller } from "./seat";
import { ContentService } from "../content/service";
import { operatorAttachmentLines } from "../content/operator-attachments";
import { liveTaskPorts, taskOnTarget, type TaskCaller } from "../work/task-control";
import { type TaskView } from "@shared/task-model";
import { filesNodeName } from "../work/subject-people";
import { TASKS_ENABLED } from "@shared/features";
import { seatPageShot, type SeatPageShot } from "../work/page-shot-seat";
import { findNode, nodeTitle, productDisabledError, resolveWorkTarget } from "../work/authz";
import { asNodeId, mailSenderRegions, seatIdentity, type Canvas, type SeatIdentity } from "@shared/model";

/** A mail as a seat reads it names its thread, and its parent when it answers one. */
export const withThread = <M extends Message>(message: M): M & { readonly threadId: string; readonly inReplyTo?: string } => {
  const inReplyTo = message.metadata?.inReplyTo;
  return {
    ...message,
    threadId: mailThreadOf(message),
    ...(typeof inReplyTo === "string" ? { inReplyTo } : {}),
  };
};

/**
 * A seat's own mail with the operator's files on it placed where the seat
 * opens them: `files`, one `Attached:` line each, the lines its delivery
 * typed. Mail with no files, or whose files are not on this machine yet,
 * reads as it is.
 */
const withMailFiles = (canvasName: string, nodeId: string) =>
  <M extends Message>(message: M): Effect.Effect<M | (M & { readonly files: ReadonlyArray<string> })> =>
    Effect.gen(function* () {
      const refs = operatorFilesOf(message);
      if (refs.length === 0) return message;
      const store = yield* Effect.serviceOption(ContentService);
      if (Option.isNone(store)) return message;
      const files = yield* operatorAttachmentLines(store.value, { canvasName, nodeId, messageId: message.messageId, refs }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return files === undefined ? message : { ...message, files };
    });

/**
 * A seat's own mail with the page box shot it names (page-shot-seat.ts):
 * `shot` ready at a path, on its way, or removed. Mail naming no shot, or
 * whose page is out of the seat's reach, reads as it is.
 */
const withPageShot = (board: Canvas, canvasName: string, nodeId: string) =>
  <M extends Message>(message: M): Effect.Effect<M | (M & { readonly shot: SeatPageShot })> =>
    Effect.serviceOption(ContentService).pipe(
      Effect.flatMap((store) =>
        Option.isNone(store)
          ? Effect.succeed(message)
          : seatPageShot({ canvasName, canvas: board, seatNodeId: nodeId }, message).pipe(
              Effect.provideService(ContentService, store.value),
              Effect.map((shot) => (shot === undefined ? message : { ...message, shot })),
            ),
      ),
    );

/** A seat's own mail as it reads it: its files, then its page box shot. */
export const asSeatReadsIt = (board: Canvas, canvasName: string, nodeId: string) =>
  <M extends Message>(message: M) =>
    Effect.flatMap(withMailFiles(canvasName, nodeId)(message), withPageShot(board, canvasName, nodeId));

/**
 * A message id argument. A refusal names the path and the shape it wants and
 * never echoes what the caller sent.
 */
export const mailIdArg = (path: string, value: string): Result.Result<string, WorkErrorBody> => {
  const trimmed = value.trim();
  return isMailMessageId(trimmed)
    ? Result.succeed(trimmed)
    : Result.fail({
        type: "InputError",
        message: `${path} must be ${MAIL_MESSAGE_ID_SHAPE}`,
        details: { path, expected: "ULID", retryable: false },
      });
};

/** A mail target: a seat, never an item inside a node. */
export const resolveMailTarget = (
  board: Canvas,
  callerId: string,
  typed: string,
  op: WorkOpName,
): Result.Result<string, WorkErrorBody> => {
  const named = resolveWorkTarget(board, callerId, typed, op);
  if (Result.isFailure(named)) return Result.fail(named.failure);
  if (named.success.itemId !== undefined) {
    return Result.fail({
      type: "InputError",
      message: "mail goes to a seat; this target names an item inside a node",
      details: { path: "target", retryable: false, next_step: "send to the seat's name, node id or ref without &item" },
    });
  }
  return Result.succeed(named.success.nodeId);
};

/**
 * The 0.10 task `msg --task` names, on the task node its target names, found
 * in the seat's reach as a task comment finds it (`taskOnTarget`). Mail to a
 * task never reads or writes the old task store.
 */
export const mailTask = (
  board: Canvas,
  caller: { readonly canvasName: string; readonly nodeId: string },
  actor: ActorRef,
  target: string | undefined,
  taskId: string,
  op: WorkOpName,
): Effect.Effect<TaskView, WorkErrorBody> => {
  if (!TASKS_ENABLED) return Effect.fail(productDisabledError(caller.nodeId, "task", op));
  if (target === undefined) {
    return Effect.fail({
      type: "InputError",
      message: "mail on a task names the task's node as its target",
      details: { path: "target", retryable: false, next_step: "send again with target set to the task node: junto task list shows it" },
    });
  }
  return taskOnTarget(seatTaskCaller(board, caller, actor), liveTaskPorts, { target, task: taskId });
};

/** A seat as the task verbs take it. */
export const seatTaskCaller = (
  board: Canvas,
  caller: { readonly canvasName: string; readonly nodeId: string },
  actor: ActorRef,
): TaskCaller => ({
  canvas: board,
  canvasName: caller.canvasName,
  actor: { kind: "seat", seatId: actor.seatId, nodeId: asNodeId(caller.nodeId) },
});

/** The thread metadata a reply to `parent` carries. One rule for all mail. */
export const replyThreadMetadata = (parent: Message): { readonly inReplyTo: string; readonly threadId: string } => ({
  inReplyTo: parent.messageId,
  threadId: mailThreadOf(parent),
});

export const mailSenderStamp = (
  board: Canvas,
  caller: WorkCaller,
  actor: ActorRef,
): MailSenderStamp => {
  const node = findNode(board, caller.nodeId);
  const terminal = node?.kind === "agent" ? node : undefined;
  const epoch = terminal?.bindingId === undefined
    ? undefined
    : seatStateRuntime.machine.getSlot(terminal.bindingId)?.epoch;
  return {
    fromSeat: actor.seatId,
    senderGeneration: epoch ?? caller.generation,
    senderHarness: terminal?.harness ?? "unknown",
    senderNodeId: caller.nodeId,
    senderName: node === undefined ? caller.nodeId : nodeTitle(node),
    ...(node === undefined ? {} : { senderRegions: mailSenderRegions(board, caller.nodeId) }),
  };
};

/** Who a mail went to, as the sender reads it back. */
export const recipientOf = (board: Canvas, nodeId: string): SeatIdentity => {
  const node = findNode(board, nodeId);
  if (node === undefined) return { nodeId, name: nodeId, regions: [] };
  // A Files node's title falls back to its root's basename, and the root never leaves its machine.
  return node.kind === "files" ? { ...seatIdentity(board, node), name: filesNodeName(node) } : seatIdentity(board, node);
};

/** The operator, who is no node, as a reply's recipient. */
export const OPERATOR_RECIPIENT: SeatIdentity = { nodeId: "operator", name: "operator", regions: [] };
