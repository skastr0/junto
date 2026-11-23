/**
 * `thread.list` and `thread.show`: an overseer reads the threads of any seat
 * on a canvas, no edge needed, through the seat commands' own reads with
 * admission left to the caller (`seatThreadsView`, `seatThreadMessagesView`
 * in src/core/work-control/thread.ts), themselves over the window's one read
 * (`seatThreadsPage`, `seatThreadMessagesPage`). A read passes
 * no read points and marks nothing: the operator's read point never moves,
 * and a summary carries none of the operator's read state (`readAt`,
 * `unread`), as the seat's own `junto thread list` drops it.
 *
 * Admission is the dispatcher's, as for every overseer operation: the live
 * grant, checked at each use; pause and blocked have no bearing on it.
 */
import { Effect, Result } from "effect";
import type { Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { OverseerArgsFor, OverseerCaller } from "@shared/overseer-control";
import type { TargetCandidate, WorkErrorBody } from "@shared/work-control";
import { ModelService } from "../model/service";
import { findNode, resolveWorkTarget, type TargetCandidates } from "../work/authz";
import type { OperatorThreadRow } from "@shared/operator-threads";
import { threadRowsPage } from "../work/thread-rows";
import { seatThreadMessagesView, seatThreadsView } from "../work-control/thread";

export type OverseerThreadOperation = "thread.list" | "thread.show";

/** Every agent seat on the canvas: an overseer reaches each one. */
const everySeat: TargetCandidates = (doc) =>
  [...doc.nodes.values()]
    .filter((node) => node.kind === "agent")
    .map((node): TargetCandidate => ({ kind: node.kind, nodeId: node.id, name: titleOf(node) }));

const canvasOf = (canvasName: string) =>
  Effect.flatMap(ModelService, (model) => model.canvas(canvasName)).pipe(
    Effect.mapError((): WorkErrorBody => ({
      type: "UnknownTarget",
      message: `canvas "${canvasName}" was not found`,
      details: { retryable: false },
    })),
  );

/** The seat `seat` names: a name, node id or ref of any agent seat on the canvas, no edge needed. */
const seatOf = (
  canvas: Canvas,
  caller: OverseerCaller,
  operation: OverseerThreadOperation,
  typed: string,
): Result.Result<string, WorkErrorBody> => {
  const resolved = resolveWorkTarget(canvas, caller.nodeId, typed, operation, everySeat);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  const node = resolved.success.itemId === undefined ? findNode(canvas, resolved.success.nodeId) : undefined;
  if (node?.kind !== "agent") {
    return Result.fail({
      type: "UnknownTarget",
      message: `"${typed}" is not an agent seat`,
      details: {
        target: typed,
        hint: "threads belong to agent seats",
        retryable: false,
        next_step: "junto overseer agent list shows the seats",
      },
    });
  }
  return Result.succeed(node.id);
};

/** A row without the operator's read state: an overseer is not the operator. */
export type OverseerThreadRow = Omit<OperatorThreadRow, "readAt" | "unread">;

const rowWithoutReadState = ({ readAt: _readAt, unread: _unread, ...row }: OperatorThreadRow): OverseerThreadRow => row;

/**
 * Every thread on the canvas, between seats included, newest activity first:
 * the across-seats read with `who: all` and no read points.
 */
const everyThread = (canvasName: string, list: OverseerArgsFor<"thread.list">) =>
  threadRowsPage(canvasName, {
    who: "all",
    ...(list.region === undefined ? {} : { region: list.region }),
    ...(list.search === undefined ? {} : { search: list.search }),
    ...(list.limit === undefined ? {} : { limit: list.limit }),
    ...(list.after === undefined ? {} : { after: list.after }),
  }).pipe(
    Effect.map((page) => ({
      threads: page.rows.map(rowWithoutReadState),
      ...(page.next === undefined ? {} : { next: page.next }),
      total: page.total,
    })),
    // Fixed words: the store's own message could quote mail.
    Effect.mapError((): WorkErrorBody => ({
      type: "InternalError",
      message: "the threads could not be read",
      details: { retryable: true, next_step: "junto overseer thread list" },
    })),
  );

export const executeOverseerThreads = <Operation extends OverseerThreadOperation>(
  caller: OverseerCaller,
  operation: Operation,
  args: OverseerArgsFor<Operation>,
) =>
  Effect.gen(function* () {
    const canvasName = args.canvas ?? caller.canvasName;
    const canvas = yield* canvasOf(canvasName);
    if (operation === "thread.list") {
      const list = args as OverseerArgsFor<"thread.list">;
      if (list.seat === undefined) return yield* everyThread(canvasName, list);
      const seat = yield* Effect.fromResult(seatOf(canvas, caller, operation, list.seat));
      return yield* seatThreadsView(canvasName, seat, {
        ...(list.limit === undefined ? {} : { limit: list.limit }),
        ...(list.after === undefined ? {} : { after: list.after }),
        ...(list.group === undefined ? {} : { group: list.group }),
      });
    }
    const show = args as OverseerArgsFor<"thread.show">;
    const seat = yield* Effect.fromResult(seatOf(canvas, caller, operation, show.seat));
    return yield* seatThreadMessagesView(canvasName, seat, show.threadId, {
      ...(show.limit === undefined ? {} : { limit: show.limit }),
      ...(show.before === undefined ? {} : { before: show.before }),
    }).pipe(
      Effect.mapError((error): WorkErrorBody =>
        error.type === "UnknownTarget"
          ? { ...error, details: { ...error.details, next_step: `junto overseer thread list --seat ${seat}` } }
          : error,
      ),
    );
  });
