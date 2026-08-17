/**
 * Seat occupancy is independent of process liveness.
 *
 * A seat is vacant or occupied. Resumable / crashed / stalled / paused belong
 * to the occupant process. Occupying a vacant seat and activating an occupied
 * seat are different command families — one cannot be passed where the other
 * is due. Placement (local | remote) is a property of the seat; it selects the
 * process Layer. It does not change the occupancy contract.
 */
import { Result, Schema } from "effect";
import { BindingId, SessionEpoch } from "./terminal-session-domain";

export const SeatPlacement = Schema.Literals(["local", "remote"]);
export type SeatPlacement = typeof SeatPlacement.Type;

export const VacantSeat = Schema.Struct({
  _tag: Schema.Literal("VacantSeat"),
  bindingId: BindingId,
  placement: SeatPlacement,
});
export type VacantSeat = typeof VacantSeat.Type;

export const OccupiedSeat = Schema.Struct({
  _tag: Schema.Literal("OccupiedSeat"),
  bindingId: BindingId,
  epoch: SessionEpoch,
  placement: SeatPlacement,
});
export type OccupiedSeat = typeof OccupiedSeat.Type;

export const SeatOccupancy = Schema.Union([VacantSeat, OccupiedSeat]);
export type SeatOccupancy = typeof SeatOccupancy.Type;

export const OccupyVacantSeat = Schema.Struct({
  _tag: Schema.Literal("OccupyVacantSeat"),
  seat: VacantSeat,
});
export type OccupyVacantSeat = typeof OccupyVacantSeat.Type;

export const ActivateOccupiedSeat = Schema.Struct({
  _tag: Schema.Literal("ActivateOccupiedSeat"),
  seat: OccupiedSeat,
});
export type ActivateOccupiedSeat = typeof ActivateOccupiedSeat.Type;

export const EvictOccupiedSeat = Schema.Struct({
  _tag: Schema.Literal("EvictOccupiedSeat"),
  seat: OccupiedSeat,
});
export type EvictOccupiedSeat = typeof EvictOccupiedSeat.Type;

export class SeatAlreadyOccupiedError extends Schema.TaggedErrorClass<SeatAlreadyOccupiedError>()(
  "SeatAlreadyOccupiedError",
  {
    bindingId: BindingId,
    epoch: SessionEpoch,
    message: Schema.String,
  },
) {}

export class SeatVacantError extends Schema.TaggedErrorClass<SeatVacantError>()(
  "SeatVacantError",
  {
    bindingId: BindingId,
    message: Schema.String,
  },
) {}

/** Wire-facing liveness. Finer stalls stay adapter-private. */
export const ProcessLiveness = Schema.Literals(["starting", "running", "exited"]);
export type ProcessLiveness = typeof ProcessLiveness.Type;

export const OccupantProcess = Schema.Struct({
  placement: SeatPlacement,
  liveness: ProcessLiveness,
  /** Characteristic of the process (session id exists), not of the seat. */
  resumable: Schema.Boolean,
  sessionId: Schema.optionalKey(Schema.String),
});
export type OccupantProcess = typeof OccupantProcess.Type;

const decodeBindingId = Schema.decodeUnknownSync(BindingId);
const decodeEpoch = Schema.decodeUnknownSync(SessionEpoch);
const decodePlacement = Schema.decodeUnknownSync(SeatPlacement);

export type SeatSessionSnapshot = {
  readonly epoch: string;
  readonly status: "starting" | "running" | "exited" | "missing";
  readonly stopping?: true;
};

export const vacantSeat = (
  bindingId: string,
  placement: SeatPlacement = "local",
): VacantSeat =>
  VacantSeat.make({
    _tag: "VacantSeat",
    bindingId: decodeBindingId(bindingId),
    placement: decodePlacement(placement),
  });

export const occupiedSeat = (
  bindingId: string,
  epoch: string,
  placement: SeatPlacement = "local",
): OccupiedSeat =>
  OccupiedSeat.make({
    _tag: "OccupiedSeat",
    bindingId: decodeBindingId(bindingId),
    epoch: decodeEpoch(epoch),
    placement: decodePlacement(placement),
  });

/**
 * A generation still indexed by the host occupies the seat. Stopping is
 * occupied — the occupant has not vacated. Exited / missing / unknown is
 * vacant. Resume identity lives on OccupantProcess, not here.
 */
export const occupancyFromSession = (
  bindingId: string,
  session: SeatSessionSnapshot | undefined,
  placement: SeatPlacement = "local",
): SeatOccupancy => {
  if (session === undefined || session.status === "exited" || session.status === "missing") {
    return vacantSeat(bindingId, placement);
  }
  return occupiedSeat(bindingId, session.epoch, placement);
};

export const occupancyFromSummary = (
  bindingId: string,
  summary:
    | {
        readonly epoch: string;
        readonly status: "starting" | "running" | "exited" | "missing";
        readonly stopping?: true;
        readonly hostId?: string;
      }
    | undefined,
  placement?: SeatPlacement,
): SeatOccupancy => {
  const resolved =
    placement ??
    (summary?.hostId !== undefined && summary.hostId !== "" && summary.hostId !== "local"
      ? "remote"
      : "local");
  return occupancyFromSession(bindingId, summary, resolved);
};

/** Exhaustive admission: vacant → occupy, occupied → activate. */
export const seatAdmission = (
  occupancy: SeatOccupancy,
): OccupyVacantSeat | ActivateOccupiedSeat =>
  occupancy._tag === "VacantSeat"
    ? OccupyVacantSeat.make({ _tag: "OccupyVacantSeat", seat: occupancy })
    : ActivateOccupiedSeat.make({ _tag: "ActivateOccupiedSeat", seat: occupancy });

export const occupyVacantSeat = (
  occupancy: SeatOccupancy,
): Result.Result<OccupyVacantSeat, SeatAlreadyOccupiedError> => {
  if (occupancy._tag === "OccupiedSeat") {
    return Result.fail(
      SeatAlreadyOccupiedError.make({
        bindingId: occupancy.bindingId,
        epoch: occupancy.epoch,
        message: `seat ${occupancy.bindingId} is occupied; cannot occupy with a new process`,
      }),
    );
  }
  return Result.succeed(
    OccupyVacantSeat.make({ _tag: "OccupyVacantSeat", seat: occupancy }),
  );
};

export const activateOccupiedSeat = (
  occupancy: SeatOccupancy,
): Result.Result<ActivateOccupiedSeat, SeatVacantError> => {
  if (occupancy._tag === "VacantSeat") {
    return Result.fail(
      SeatVacantError.make({
        bindingId: occupancy.bindingId,
        message: `seat ${occupancy.bindingId} is vacant; activate requires an occupant`,
      }),
    );
  }
  return Result.succeed(
    ActivateOccupiedSeat.make({ _tag: "ActivateOccupiedSeat", seat: occupancy }),
  );
};

export const evictOccupiedSeat = (
  occupancy: SeatOccupancy,
): Result.Result<EvictOccupiedSeat, SeatVacantError> => {
  if (occupancy._tag === "VacantSeat") {
    return Result.fail(
      SeatVacantError.make({
        bindingId: occupancy.bindingId,
        message: `seat ${occupancy.bindingId} is vacant; evict requires an occupant`,
      }),
    );
  }
  return Result.succeed(
    EvictOccupiedSeat.make({ _tag: "EvictOccupiedSeat", seat: occupancy }),
  );
};
