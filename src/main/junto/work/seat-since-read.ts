/**
 * Since your last session, read for onboard and `junto since`: the seat's own
 * mailbox and the mail it sent into other seats' (sent mail lives in each
 * recipient's), this seat's signals, and the previous session's start,
 * projected by the pure `seatSince`. Nothing here writes, and nothing is
 * stored.
 */
import { Cause, Clock, Effect, Option } from "effect";
import type { HeldMailbox } from "@shared/mail-threads";
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { SINCE_PER_SECTION, seatSince, type Since } from "@shared/seat-since";
import type { Message } from "@shared/work-model";
import { AgentSignalRepository } from "../signals/repository";
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
      yield* work.readMailbox(canvasName, nodeId),
      yield* work.readMailSentBy(canvasName, nodeId),
    );
    const names = new Map(seats.map((seat) => [seat.id as string, titleOf(seat)]));
    const store = yield* Effect.serviceOption(AgentSignalRepository);
    // Open signals from the listing, which always holds every open one;
    // answers by answer time, since the listing's closed history is capped.
    const signals = Option.isNone(store)
      ? []
      : [
          ...(yield* store.value.listSeat({ canvasName, nodeId })).filter((signal) => signal.state === "open"),
          ...(yield* store.value.listSeatAnswered({ canvasName, nodeId }, previousStartedAt)),
        ];
    const now = yield* Clock.currentTimeMillis;
    const since: Since = seatSince(
      {
        seat: asNodeId(nodeId),
        mailboxes,
        nameOf: (id) => names.get(id),
        signals,
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
