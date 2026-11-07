/**
 * Read a seat's settled terminal grid by canvas and seat id: the owner's
 * command, on this machine or over the seats channel to the machine that runs
 * the seat. The text is terminal bytes: it goes to the caller and nowhere
 * else, never into a failure, a log row, the scrub registry or disk. A seat's
 * own terminal.read never becomes a Read; only the owner socket calls here.
 */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { MachineName } from "@shared/machine-control";
import { CanvasName, NodeId, type NodeOf } from "@shared/model";
import { clampReadLines } from "@shared/seat-control";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { ModelService } from "../model/service";
import { termPlane, type TermPlane } from "./plane";
import { NotASeat, SeatNotFound } from "./seat-control";
import { readLocalWindow, type SeatGrid, SeatsReadWindow } from "./seat-read-window";
import { unwrapSeatsFailure } from "./seats-failure";

export type SeatReadOptions = {
  readonly plane?: Pick<TermPlane, "router" | "host">;
  readonly grid?: SeatGrid;
};

/**
 * The owner's read of a seat by canvas and seat id. Vacant when it has no
 * live occupant. On another machine it is a Read over the seats channel,
 * which that machine admits like Stop: only from the machine editing the
 * seat's canvas.
 */
export const readSeatWindow = Effect.fn("SeatRead.command")(function* (input: {
  readonly canvas: CanvasName;
  readonly seatId: NodeId;
  readonly lines?: number;
  readonly operationId?: string;
}, options: SeatReadOptions = {}) {
  const plane = options.plane ?? termPlane;
  const model = yield* ModelService;
  if (!(yield* model.listCanvases()).includes(input.canvas))
    return yield* new SeatNotFound({ canvas: input.canvas, seatId: input.seatId, message: "No canvas by that name on this machine." });
  const node = (yield* model.canvas(input.canvas)).nodes.get(input.seatId);
  if (node === undefined)
    return yield* new SeatNotFound({ canvas: input.canvas, seatId: input.seatId, message: "No node with that id on this canvas." });
  if (node.kind !== "agent")
    return yield* new NotASeat({ canvas: input.canvas, seatId: input.seatId, kind: node.kind, message: "This node is not an agent seat." });
  const seat: NodeOf<"agent"> = node;
  const where = { machine: seat.host, canvas: input.canvas, seatId: input.seatId };
  const read = plane.router.isLocalHostId(seat.host)
    ? yield* readLocalWindow(where, seat.bindingId, plane.host.get(seat.bindingId), input.lines, options.grid)
    : yield* Effect.gen(function* () {
      const host = yield* (yield* HostsService).get(seat.host);
      if (host === undefined) return yield* Effect.fail(new Error("This seat's machine is unavailable."));
      const link = yield* MachineLink;
      yield* link.connect(host);
      const answer = yield* link.request(seat.host, "seats", {
        _tag: "Read", canvas: input.canvas, seatId: input.seatId,
        ...(input.lines === undefined ? {} : { lines: clampReadLines(input.lines) }),
      }, { operationId: input.operationId ?? randomUUID() }).pipe(Effect.mapError(unwrapSeatsFailure));
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Union([SeatsReadWindow, Schema.Struct({
        _tag: Schema.Literal("Vacant"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
      })]))(answer, { onExcessProperty: "error" });
      if (decoded.canvas !== input.canvas || decoded.seatId !== input.seatId)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return decoded._tag === "Vacant" ? undefined : decoded;
    });
  // Only the count is logged: the text never enters a log row.
  yield* Effect.logInfo("seat read").pipe(Effect.annotateLogs({ machine: seat.host, lines: read?.lines ?? 0 }));
  return { hostId: seat.host, bindingId: seat.bindingId, window: read };
}, (effect, input, _options?: SeatReadOptions) => effect.pipe(Effect.annotateLogs({
  area: "seats", seat: input.seatId, canvas: input.canvas,
  ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
})));
