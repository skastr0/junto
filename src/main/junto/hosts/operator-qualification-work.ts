import { Effect } from "effect";
import type {
  OperatorErrorType,
  OperatorQualificationWorkPrepareData,
  OperatorQualificationWorkProgressData,
  OperatorQualificationWorkRunArgs,
  OperatorQualificationWorkTargetArgs,
  OperatorQualificationWorkVerifyData,
} from "@shared/operator-control";
import { STATION_PROJECTION_SWITCHED_OFF } from "../station/api";

// Qualifying a Remote meant minting a canvas and a task on Command Center,
// projecting them to the Remote and reading its offline work back. Remote
// stations are switched off in this build, so every step refuses with the
// same sentence the station plane gives.

export class OperatorQualificationWorkError extends Error {
  constructor(
    readonly type: OperatorErrorType,
    message: string,
  ) {
    super(message);
    this.name = "OperatorQualificationWorkError";
  }
}

const switchedOff: Effect.Effect<never, OperatorQualificationWorkError> =
  Effect.fail(
    new OperatorQualificationWorkError(
      "conflict",
      STATION_PROJECTION_SWITCHED_OFF,
    ),
  );

export const qualificationWorkPrepareEffect = (
  _args: OperatorQualificationWorkTargetArgs,
): Effect.Effect<
  OperatorQualificationWorkPrepareData,
  OperatorQualificationWorkError
> => switchedOff;

export const qualificationWorkProgressEffect = (
  _args: OperatorQualificationWorkRunArgs,
  _sessionReady: () => boolean,
): Effect.Effect<
  OperatorQualificationWorkProgressData,
  OperatorQualificationWorkError
> => switchedOff;

export const qualificationWorkVerifyEffect = (
  _args: OperatorQualificationWorkTargetArgs,
): Effect.Effect<
  OperatorQualificationWorkVerifyData,
  OperatorQualificationWorkError
> => switchedOff;
