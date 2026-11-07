/**
 * The core's handlers for the work socket's seat.* and preamble ops (`SeatRpcs`). Owned by
 * cli-identity. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does, and refuses with the v1 error body as
 * a `WorkFailure`.
 */
import { Effect } from "effect";
import { ulid } from "ulid";
import { type WorkErrorBody } from "@shared/work-control";
import { normalizePreambleText, PREAMBLE_MAX_TEXT_LENGTH, PREAMBLE_TTL_MS } from "@shared/preamble";
import { SeatRpcs } from "../../contract/work/seat";
import { workFailure } from "../../contract/work/failure";
import { noteSeatPreamble } from "../work/seat-preambles";
import { WorkAdmission, WorkSeat } from "./seat";

export const SeatServed = SeatRpcs.middleware(WorkAdmission);

export const SeatHandlers = SeatServed.toLayer(
  SeatServed.of({
    preamble: (args) =>
      Effect.gen(function* () {
        const { caller } = yield* WorkSeat;
        const text = normalizePreambleText(args.text);
        if (!text) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: "text must be non-empty",
            details: { path: "args.text", retryable: false },
          });
        }
        if (text.length > PREAMBLE_MAX_TEXT_LENGTH) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: `text must be at most ${PREAMBLE_MAX_TEXT_LENGTH} characters`,
            details: { path: "args.text", retryable: false },
          });
        }
        const expiresAt = Date.now() + PREAMBLE_TTL_MS;
        noteSeatPreamble(caller.canvasName, caller.nodeId, { text, expiresAt });
        return {
          preambleId: ulid(),
          canvasName: caller.canvasName,
          nodeId: caller.nodeId,
          text,
          expiresAt,
          disposition: "applied" as const,
        };
      }).pipe(Effect.mapError(workFailure)),
    "seat.wait": (args) =>
      Effect.gen(function* () {
        const { caller, observation } = yield* WorkSeat;
        const seat = yield* observation;
        return yield* seat.waitSeat(args, caller);
      }).pipe(Effect.mapError(workFailure)),
    "seat.read": (args) =>
      Effect.gen(function* () {
        const { caller, observation } = yield* WorkSeat;
        const seat = yield* observation;
        if (args.brief === true) return yield* seat.readPeers(caller);
        return yield* seat.readSeat(args, caller);
      }).pipe(Effect.mapError(workFailure)),
  }),
);
