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
import { isNoScreenToFollow } from "../work/seat-observation";
import { findNode } from "../work/authz";
import { decodeSeatReadCursor, seatReadViewOf } from "@shared/seat-control";
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
        return yield* seat.waitCollaboration(args, caller);
      }).pipe(Effect.mapError(workFailure)),
    // A peer reads collaboration state, never process or PTY liveness; the
    // core's own observation rides `internals` only for an overseer.
    "seat.read": (args) =>
      Effect.gen(function* () {
        const { caller, observation, board } = yield* WorkSeat;
        const seat = yield* observation;
        if (args.brief === true) return yield* seat.readPeersView(caller);
        const target = args.target!;
        const internals = args.internals === true;
        if (internals) {
          const self = findNode(board, caller.nodeId);
          if (self?.kind !== "agent" || self.overseer !== true) {
            return yield* Effect.fail<WorkErrorBody>({
              type: "ScopeError",
              message: "seat read --internals is an overseer capability",
              details: {
                missing: "overseer",
                hint: "a seat reads its peers' collaboration state; harness and process internals are for an overseer seat",
                retryable: false,
                next_step: `junto seat read ${target}`,
              },
            });
          }
        }
        const cursor = args.since === undefined ? undefined : decodeSeatReadCursor(args.since);
        if (args.since !== undefined && cursor === undefined) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: "--since takes the cursor a previous seat read answered",
            details: { path: "args.since", received: args.since, retryable: false, next_step: `junto seat read ${target}` },
          });
        }
        const window = {
          target,
          ...(args.lines === undefined ? {} : { lines: args.lines }),
          ...(cursor === undefined ? {} : cursor),
        };
        const observed = yield* seat
          .readSeat(
            { ...window, ...(args.follow === true ? { follow: true } : {}), ...(args.maxSeconds === undefined ? {} : { maxSeconds: args.maxSeconds }) },
            caller,
          )
          .pipe(
            // A seat with nothing on screen is still reachable: answer its
            // state and empty text rather than refuse.
            Effect.catchIf(isNoScreenToFollow, () => seat.readSeat(window, caller)),
          );
        return seatReadViewOf(observed, internals);
      }).pipe(Effect.mapError(workFailure)),
  }),
);
