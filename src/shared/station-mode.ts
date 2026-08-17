/**
 * Station process mode is exhaustive. Socket doors follow the mode.
 * Enroll and peer are never both bound. Re-enroll is a mode change
 * that tears the peer door down first — not two live sessions.
 */
import { Result, Schema } from "effect";

export const StationProcessMode = Schema.Literals([
  "unenrolled",
  "remote",
  "command-center",
]);
export type StationProcessMode = typeof StationProcessMode.Type;

export const StationDoor = Schema.Literals(["enroll", "peer"]);
export type StationDoor = typeof StationDoor.Type;

/** Wire verbs the enroll door may accept. */
export const ENROLL_VERBS = ["status", "pair", "configure"] as const;
export type EnrollVerb = (typeof ENROLL_VERBS)[number];

/** Operational verbs belong on the peer door only. */
export const PEER_VERBS = ["status", "project", "report"] as const;
export type PeerVerb = (typeof PEER_VERBS)[number];

export const doorForMode = (
  mode: StationProcessMode,
): StationDoor | undefined => {
  if (mode === "unenrolled") return "enroll";
  if (mode === "remote") return "peer";
  return undefined;
};

export const modeFromConfiguration = (
  role: "command-center" | "remote" | "" | undefined,
): StationProcessMode => {
  if (role === "command-center") return "command-center";
  if (role === "remote") return "remote";
  return "unenrolled";
};

export class StationDoorModeError extends Schema.TaggedErrorClass<StationDoorModeError>()(
  "StationDoorModeError",
  {
    mode: StationProcessMode,
    door: StationDoor,
    message: Schema.String,
  },
) {}

export const assertDoorForMode = (
  mode: StationProcessMode,
  door: StationDoor,
): Result.Result<StationDoor, StationDoorModeError> => {
  const expected = doorForMode(mode);
  if (expected !== door) {
    return Result.fail(
      StationDoorModeError.make({
        mode,
        door,
        message: `mode ${mode} does not bind the ${door} door`,
      }),
    );
  }
  return Result.succeed(door);
};

export const enrollVerbAdmitted = (op: string): boolean =>
  (ENROLL_VERBS as readonly string[]).includes(op);

export const peerVerbAdmitted = (op: string): boolean =>
  (PEER_VERBS as readonly string[]).includes(op);
