/**
 * The core's handlers for the work socket's thread.* ops (`ThreadRpcs`).
 * Owned by cli-protocol. A seat lists and reads its threads, those with the
 * operator and those between seats: its own with no `seat`, seat-local as `msg.list` with no target
 * is; a connected seat's with `seat`, admitted by port `threads.read`, which
 * refuses a seat on another machine with `other_machine` as `seat.read` is.
 *
 * Both read the core's one thread read, `seatThreadsPage` and
 * `seatThreadMessagesPage`, as the window does (src/core/ops/ipc-threads.ts),
 * and never with the operator's read points: a seat's read moves no read
 * point, and its view carries none of the operator's read state.
 *
 * `seatThreadsView` and `seatThreadMessagesView` are the reads with the
 * admission left to the caller: the overseer plane calls them with its own.
 */
import { Effect, Option, Result } from "effect";
import { SqlClient } from "effect/sql";
import { titleOf } from "@shared/model/title";
import type { ThreadGroup } from "@shared/mail-threads";
import { resolveMailboxTarget } from "@shared/mailbox-target";
import { type WorkErrorBody, type WorkOpName } from "@shared/work-control";
import { seatThreadMessageOf, seatThreadSummaryOf, type ThreadListAnswer, type ThreadShowAnswer } from "@shared/thread-control";
import { ThreadRpcs } from "../../contract/work/thread";
import { workFailure } from "../../contract/work/failure";
import { ModelService } from "../model/service";
import { WorkRepository } from "../work/repository";
import { WorkService } from "../work/service";
import { seatThreadMessagesPage, seatThreadsPage } from "../work/operator-threads";
import { admitWorkTarget, findNode, resolveWorkTarget } from "../work/authz";
import { WorkAdmission, WorkSeat } from "./seat";

type ThreadOp = Extract<WorkOpName, "thread.list" | "thread.show">;

const unavailable: WorkErrorBody = {
  type: "RuntimeDown",
  message: "threads are not available in this runtime",
  details: { retryable: false },
};

const unread = (op: ThreadOp): WorkErrorBody => ({
  type: "InternalError",
  message: "the threads could not be read",
  details: { retryable: true, next_step: `junto ${op === "thread.list" ? "thread list" : "thread show <threadId>"}` },
});

/**
 * The core's thread read, run with the services this core holds. A runtime
 * without a canvas model or a work store answers that, never a defect; a read
 * that failed answers in fixed words, never the store's message.
 */
const withThreadServices = <A>(
  op: ThreadOp,
  read: Effect.Effect<A, unknown, ModelService | WorkRepository | WorkService | SqlClient.SqlClient>,
): Effect.Effect<A, WorkErrorBody> =>
  Effect.gen(function* () {
    const model = yield* Effect.serviceOption(ModelService);
    const repository = yield* Effect.serviceOption(WorkRepository);
    const work = yield* Effect.serviceOption(WorkService);
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(model) || Option.isNone(repository) || Option.isNone(work) || Option.isNone(sql)) return yield* Effect.fail(unavailable);
    return yield* read.pipe(
      Effect.provideService(ModelService, model.value),
      Effect.provideService(WorkRepository, repository.value),
      Effect.provideService(WorkService, work.value),
      Effect.provideService(SqlClient.SqlClient, sql.value),
      Effect.mapError(() => unread(op)),
    );
  });

/** One page of a seat's threads, newest activity first, without the operator's read state. Admission is the caller's. */
export const seatThreadsView = (
  canvasName: string,
  nodeId: string,
  page: { readonly limit?: number; readonly after?: string; readonly group?: ThreadGroup },
): Effect.Effect<ThreadListAnswer, WorkErrorBody> =>
  withThreadServices(
    "thread.list",
    // No read points: the operator's read state stays out of a seat's view.
    Effect.map(seatThreadsPage(canvasName, nodeId, page), (found) => ({
      seat: nodeId,
      threads: found.threads.map(seatThreadSummaryOf),
      ...(found.next === undefined ? {} : { next: found.next }),
    })),
  );

/**
 * One page of one of a seat's threads, oldest first: the newest messages, or
 * those before `before`. A thread the seat is not in is refused, as one that
 * does not exist is. Admission is the caller's.
 */
export const seatThreadMessagesView = (
  canvasName: string,
  nodeId: string,
  threadId: string,
  page: { readonly limit?: number; readonly before?: string },
): Effect.Effect<ThreadShowAnswer, WorkErrorBody> =>
  Effect.gen(function* () {
    const found = yield* withThreadServices("thread.show", seatThreadMessagesPage(canvasName, nodeId, threadId, page));
    if (found.messages.length === 0 && page.before === undefined) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `no thread ${threadId} among the threads of ${nodeId}`,
        details: { target: threadId, retryable: false, next_step: "junto thread list" },
      });
    }
    return {
      seat: nodeId,
      threadId,
      messages: found.messages.map(seatThreadMessageOf),
      ...(found.older === undefined ? {} : { older: found.older }),
    };
  });

const notASeat = (typed: string, kind: string | undefined): WorkErrorBody => ({
  type: "UnknownTarget",
  message: `"${typed}" is not an agent seat`,
  details: {
    target: typed,
    ...(kind === undefined ? {} : { received: kind }),
    hint: "threads belong to agent seats",
    retryable: false,
    next_step: "junto thread list --seat <seat>",
  },
});

/**
 * Whose threads a call reads. No seat is the caller's own: no edge, no port.
 * A seat is resolved as `seat read` resolves one (its name, node id or ref)
 * and admitted on `threads.read`; naming the caller itself is its own read.
 */
const threadSeat = (op: ThreadOp, typed: string | undefined): Effect.Effect<string, WorkErrorBody, WorkSeat> =>
  Effect.gen(function* () {
    const { caller, board } = yield* WorkSeat;
    const self = findNode(board, caller.nodeId);
    if (self === undefined) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `target "${caller.nodeId}" not found`,
        details: { target: caller.nodeId, retryable: false },
      });
    }
    const wanted = typed?.trim();
    if (wanted === undefined || wanted === "" || resolveMailboxTarget(wanted, caller) === caller.nodeId || wanted === titleOf(self)) {
      return caller.nodeId;
    }
    const named = resolveWorkTarget(board, caller.nodeId, wanted, op);
    if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
    if (named.success.itemId !== undefined) return yield* Effect.fail(notASeat(wanted, "item"));
    const nodeId = named.success.nodeId as string;
    if (nodeId === caller.nodeId) return caller.nodeId;
    const admitted = admitWorkTarget(board, caller.nodeId, nodeId, op);
    if (Result.isFailure(admitted)) return yield* Effect.fail(admitted.failure);
    if (admitted.success.node.kind !== "agent") return yield* Effect.fail(notASeat(wanted, admitted.success.node.kind));
    return nodeId;
  });

/** The thread ops as this core serves them: each handler is handed its admitted seat. */
export const ThreadServed = ThreadRpcs.middleware(WorkAdmission);

export const ThreadHandlers = ThreadServed.toLayer(
  ThreadServed.of({
    "thread.list": (args) =>
      Effect.gen(function* () {
        const { caller } = yield* WorkSeat;
        const nodeId = yield* threadSeat("thread.list", args.seat);
        return yield* seatThreadsView(caller.canvasName, nodeId, {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.after === undefined ? {} : { after: args.after }),
          ...(args.group === undefined ? {} : { group: args.group }),
        });
      }).pipe(Effect.mapError(workFailure)),
    "thread.show": (args) =>
      Effect.gen(function* () {
        const { caller } = yield* WorkSeat;
        const nodeId = yield* threadSeat("thread.show", args.seat);
        return yield* seatThreadMessagesView(caller.canvasName, nodeId, args.threadId, {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.before === undefined ? {} : { before: args.before }),
        });
      }).pipe(Effect.mapError(workFailure)),
  }),
);
