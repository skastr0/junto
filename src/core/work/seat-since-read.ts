/**
 * Since your last session, read for onboard and `junto since`: the seat's own
 * mailbox and the mail it sent into other seats' (sent mail lives in each
 * recipient's), this seat's signals, the tasks it holds, held or reviews,
 * and the previous session's start, projected by the pure
 * `seatSince`. Nothing here writes, and nothing is stored.
 */
import { Cause, Clock, Effect, Option } from "effect";
import { TASKS_ENABLED } from "@shared/features";
import type { HeldMailbox } from "@shared/mail-threads";
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { SINCE_PER_SECTION, seatSince, type Since } from "@shared/seat-since";
import { taskNodeId } from "@shared/task-model";
import type { Message } from "@shared/work-model";
import { AgentSignalRepository } from "../signals/repository";
import { TaskRepository } from "./task-repository";
import { WorkService } from "./service";

/**
 * The mail `seatSince` reads for one seat: its own mailbox, and what it wrote
 * into the other seats' mailboxes, each row in the mailbox it sits in. The
 * projection only ever uses mail the seat wrote or was written, so this is
 * every mailbox on the canvas with the rest left out. Mail held at a node
 * that is not a seat (a subject comment at its task) stays out, as it does
 * when every seat's mailbox is read.
 */
export const seatMailboxes = (
  nodeId: string,
  seats: ReadonlySet<string>,
  own: ReadonlyArray<Message>,
  sent: ReadonlyArray<{ readonly nodeId: string; readonly message: Message }>,
): ReadonlyArray<HeldMailbox> => {
  const held = new Map<string, Message[]>();
  for (const row of sent) {
    if (!seats.has(row.nodeId) || row.nodeId === nodeId) continue;
    const messages = held.get(row.nodeId);
    if (messages === undefined) held.set(row.nodeId, [row.message]);
    else messages.push(row.message);
  }
  return [
    ...(seats.has(nodeId) ? [{ nodeId, messages: own }] : []),
    ...[...held].map(([holder, messages]) => ({ nodeId: holder, messages })),
  ];
};

/**
 * The tasks `seatSince` reads, each once and without bodies: the seat's open
 * tasks, those in review it may owe a stamp on, and those it finished or sent
 * on from its layer since the previous session, at most a section's worth of
 * each (`TaskRepository.seatTasks`). `leftOut` counts the changes past that.
 * None on a tasks-off build or where no task store is built.
 */
export const readSinceTasks = (
  board: Canvas,
  canvasName: string,
  nodeId: string,
  previousStartedAt: number | undefined,
  perSection: number,
) =>
  Effect.gen(function* () {
    const none = { tasks: [], leftOut: 0 };
    const store = yield* Effect.serviceOption(TaskRepository);
    if (!TASKS_ENABLED || Option.isNone(store)) return none;
    const nodeIds = [...board.nodes.values()].filter((node) => node.kind === "task").map((node) => taskNodeId(node.id));
    if (nodeIds.length === 0) return none;
    return yield* store.value.seatTasks(canvasName, {
      nodeIds,
      seat: nodeId,
      ...(previousStartedAt === undefined ? {} : { since: previousStartedAt }),
      limit: perSection,
    });
  });

export const readSeatSince = (
  board: Canvas,
  canvasName: string,
  nodeId: string,
  /** The previous session's start; absent on a first session. */
  previousStartedAt: number | undefined,
  perSection: number = SINCE_PER_SECTION,
) =>
  Effect.gen(function* () {
    const work = yield* WorkService;
    const seats = [...board.nodes.values()].filter((node) => node.kind === "agent");
    const mailboxes = seatMailboxes(
      nodeId,
      new Set(seats.map((seat) => seat.id as string)),
      // Read on the mail read worker, off main's loop: a read, never inside a write.
      yield* work.readMailboxSnapshot(canvasName, nodeId),
      yield* work.readMailSentBySnapshot(canvasName, nodeId),
    );
    const names = new Map(
      [...board.nodes.values()]
        .filter((node) => node.kind === "agent" || node.kind === "task")
        .map((node) => [node.id as string, titleOf(node)]),
    );
    const store = yield* Effect.serviceOption(AgentSignalRepository);
    // Open signals from the listing, which always holds every open one;
    // answers by answer time, since the listing's closed history is capped.
    const signals = Option.isNone(store)
      ? []
      : [
          ...(yield* store.value.listSeat({ canvasName, nodeId })).filter((signal) => signal.state === "open"),
          ...(yield* store.value.listSeatAnswered({ canvasName, nodeId }, previousStartedAt)),
        ];
    const { tasks, leftOut } = yield* readSinceTasks(board, canvasName, nodeId, previousStartedAt, perSection);
    const now = yield* Clock.currentTimeMillis;
    const since: Since = seatSince(
      {
        seat: asNodeId(nodeId),
        mailboxes,
        nameOf: (id) => names.get(id),
        signals,
        tasks,
        tasksLeftOut: leftOut,
        now,
        ...(previousStartedAt === undefined ? {} : { previousStartedAt }),
      },
      { perSection },
    );
    return since;
  });

/** Onboard's since section when it cannot be read: onboard stands without it. */
export const SINCE_UNAVAILABLE = { unavailable: "since your last session is not available" } as const;

/**
 * Onboard's since section: the read as rendered, or, on any failure or
 * defect (a bug in the read or the render, a service missing a method), the
 * cause logged and the section marked unavailable. Since is one section of
 * onboard, and onboard never dies with it.
 */
export const onboardSinceSection = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  where: string,
): Effect.Effect<A | typeof SINCE_UNAVAILABLE, never, R> =>
  read.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error(`[onboard] since unavailable for ${where}:`, Cause.pretty(cause));
        return SINCE_UNAVAILABLE;
      }),
    ),
  );
