/**
 * A seat's settled terminal grid as the seats channel carries it: the Read
 * request, its ReadWindow answer, and the read on the machine that runs the
 * seat. The text is terminal bytes: never a failure, a log row, the scrub
 * registry or disk.
 */
import { Effect, Schema } from "effect";
import { MachineName } from "@shared/machine-control";
import { CanvasName, NodeId } from "@shared/model";
import { clampReadLines, clipReadText, SEAT_READ_MAX_BYTES, SEAT_READ_MAX_LINES, utf8ByteLength } from "@shared/seat-control";
import type { ObserverGridWindow } from "./observer/types";
import { SeatReadUnavailable, type SeatsFailureWhere } from "./seats-failure";

/** The text cap of a read that crosses the link (remote-security's SeatRead terms). */
export const SEAT_READ_TEXT_MAX_BYTES = 256 * 1024;
const Generation = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));
const Count = (max: number) => Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 0, maximum: max })));
const ReadText = Schema.String.pipe(Schema.check(Schema.makeFilter((text: string) =>
  utf8ByteLength(text) <= SEAT_READ_TEXT_MAX_BYTES || `at most ${SEAT_READ_TEXT_MAX_BYTES} bytes`)));

/** The editing machine reads the seat's settled grid: its last lines. */
export const SeatsRead = Schema.Struct({
  _tag: Schema.Literal("Read"), canvas: CanvasName, seatId: NodeId,
  lines: Schema.optionalKey(Count(SEAT_READ_MAX_LINES).pipe(Schema.check(Schema.isGreaterThan(0)))),
});
/** The grid's last lines, clipped from the top to the byte cap. */
export const SeatsReadWindow = Schema.Struct({
  _tag: Schema.Literal("ReadWindow"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  generation: Generation, text: ReadText, lines: Count(SEAT_READ_MAX_LINES),
  cols: Count(1000), rows: Count(500), truncated: Schema.Boolean,
});
export type SeatsReadWindow = typeof SeatsReadWindow.Type;

export type SeatGrid = (bindingId: string, lines: number) => Promise<ObserverGridWindow | undefined>;
const observerGrid: SeatGrid = async (bindingId, lines) => {
  const { terminalObserverPlane } = await import("./observer");
  return terminalObserverPlane.readWindow(bindingId, lines);
};

/**
 * This machine's own read of a seat it runs: undefined when it has no live
 * occupant. A live occupant whose grid is not up yet is SeatReadUnavailable.
 */
export const readLocalWindow = Effect.fn("SeatRead.local")(function* (
  where: SeatsFailureWhere, bindingId: string, live: { readonly epoch: string; readonly status: string } | undefined,
  lines: number | undefined, grid: SeatGrid = observerGrid,
) {
  if (live === undefined || live.status === "exited" || live.status === "missing") return undefined;
  const window = yield* Effect.promise(() => grid(bindingId, clampReadLines(lines)));
  if (window === undefined || window.epoch !== live.epoch)
    return yield* new SeatReadUnavailable({ ...where, epoch: live.epoch,
      message: "This seat's terminal grid is not up yet; read again in a moment." });
  const clip = clipReadText(window.lines, SEAT_READ_MAX_BYTES);
  return {
    _tag: "ReadWindow" as const, canvas: where.canvas, seatId: where.seatId, machine: where.machine,
    generation: window.epoch, text: clip.lines.join("\n"), lines: clip.lines.length,
    cols: Math.min(1000, window.cols), rows: Math.min(500, window.rows), truncated: clip.truncated || window.truncated,
  } satisfies SeatsReadWindow;
});
