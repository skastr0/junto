/**
 * The renderer's two calls into operator offboard. Input arrives untyped off
 * IPC and is checked here; whatever is wrong comes back as rows the screen
 * can show, never as a throw.
 */
import {
  OFFBOARD_REFUSAL_REASON,
  SEAT_OFFBOARD_ACTIONS,
  SEAT_OFFBOARD_MAX_SEATS,
  summarizeOffboardRun,
  type OffboardBy,
  type SeatOffboardAction,
  type SeatOffboardRunResult,
  type SeatOffboardStatus,
} from "@shared/seat-offboard";
import { OFFBOARD_MODES, type OffboardMode } from "@shared/seat-sessions";
import { runSeatOffboard, seatOffboardStatus } from "./operator-offboard";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const seatIdsOf = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= SEAT_OFFBOARD_MAX_SEATS &&
  value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
    ? (value as ReadonlyArray<string>)
    : undefined;

const EMPTY: SeatOffboardRunResult = summarizeOffboardRun([]);

/** Ask, or offboard now, the seats named. `by` is who is calling. */
export const handleSeatOffboardRun = async (
  input: unknown,
  by: OffboardBy = "operator",
): Promise<SeatOffboardRunResult> => {
  if (!isRecord(input)) return EMPTY;
  const seatIds = seatIdsOf(input.seatIds);
  if (seatIds === undefined) return EMPTY;
  const refuseAll = (reason: string): SeatOffboardRunResult =>
    summarizeOffboardRun(seatIds.map((seatId) => ({ seatId, ok: false as const, code: "failed" as const, reason })));
  if (typeof input.canvasName !== "string" || input.canvasName.length === 0) {
    return summarizeOffboardRun(
      seatIds.map((seatId) => ({
        seatId,
        ok: false as const,
        code: "not-a-seat" as const,
        reason: OFFBOARD_REFUSAL_REASON["not-a-seat"],
      })),
    );
  }
  if (!(SEAT_OFFBOARD_ACTIONS as ReadonlyArray<unknown>).includes(input.action)) {
    return refuseAll("Ask the seat to offboard, or offboard it now.");
  }
  if (input.mode !== undefined && !(OFFBOARD_MODES as ReadonlyArray<unknown>).includes(input.mode)) {
    return refuseAll("Offboard to rest or to continue.");
  }
  return runSeatOffboard(
    {
      canvasName: input.canvasName,
      seatIds,
      action: input.action as SeatOffboardAction,
      ...(input.mode !== undefined ? { mode: input.mode as OffboardMode } : {}),
    },
    by,
  );
};

/** What each seat's offboard buttons should say before they are pressed. */
export const handleSeatOffboardStatus = async (
  canvasName: unknown,
  seatIds: unknown,
): Promise<ReadonlyArray<SeatOffboardStatus>> => {
  const ids = seatIdsOf(seatIds);
  if (typeof canvasName !== "string" || canvasName.length === 0 || ids === undefined) return [];
  return seatOffboardStatus(canvasName, ids);
};
