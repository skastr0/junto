/**
 * Since your last session, read for onboard and `junto since`: every agent
 * seat's mailbox on the canvas (sent mail lives in each recipient's), this
 * seat's signals, and the previous session's start, projected by the pure
 * `seatSince`. Nothing here writes, and nothing is stored.
 */
import { Clock, Effect, Option } from "effect";
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { SINCE_PER_SECTION, seatSince, type Since } from "@shared/seat-since";
import { AgentSignalRepository } from "../signals/repository";
import { WorkService } from "./service";

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
    const mailboxes = yield* Effect.forEach(seats, (seat) =>
      work.readMailbox(canvasName, seat.id).pipe(Effect.map((messages) => ({ nodeId: seat.id as string, messages }))),
    );
    const names = new Map(seats.map((seat) => [seat.id as string, titleOf(seat)]));
    const store = yield* Effect.serviceOption(AgentSignalRepository);
    const signals = Option.isNone(store) ? [] : yield* store.value.listSeat({ canvasName, nodeId });
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
