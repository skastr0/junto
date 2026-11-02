/**
 * Seats the last core ran that this one did not get back.
 *
 * A PTY lives in the terminal process and the next core adopts it
 * (local-host.ts adoptFromTerminalProcess). The durable trace of a seat that
 * was seated is its open session (`seat_sessions.ended_at IS NULL`); a seat
 * with one and no adopted terminal on this machine has no process. It is a
 * seat whose generation the last core lost — the terminal process did not name
 * it, so no exit was ever witnessed — and a card must not keep the last core's
 * ring for it.
 *
 * So each one is reported `gone`, with the reason, and the window hears the
 * session exit. Nothing is started and nothing is guessed: the seat is only
 * named when its own canvas row and its own open session agree, and a binding
 * this core adopted is skipped.
 */
import { Effect } from "effect";
import type { Node } from "@shared/model";
import { isThisMachine } from "@shared/machine-name";
import { MachineRepository } from "../machines/repository";
import { ModelService } from "../model/service";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { termPlane } from "./plane";

/** What a card says about a seat whose process did not survive the core. */
export const LOST_TO_CORE_RESTART =
  "the Junto core restarted and this seat's process did not come back";

/**
 * Mark every seated seat this core has no process for, and answer how many
 * were marked. Total: a read that fails is logged and the boot goes on.
 */
export const reconcileSeatsLostToCoreRestart = (): Effect.Effect<
  number,
  never,
  ModelService | SeatSessionRepository | MachineRepository
> =>
  Effect.gen(function* () {
    const sessions = yield* SeatSessionRepository;
    const model = yield* ModelService;
    const machines = yield* MachineRepository;
    const open = yield* sessions.openSessions();
    if (open.length === 0) return 0;
    const machine = yield* machines.machineName;
    // One pass over the canvases: a seat's host and harness live on its node,
    // and an open session carries only the seat id.
    const seats = new Map<string, Node>();
    for (const name of yield* model.listCanvases()) {
      const read = yield* Effect.result(model.canvas(name));
      if (read._tag === "Failure") continue;
      for (const node of read.success.nodes.values()) {
        if (node.kind === "agent") seats.set(node.id, node);
      }
    }
    let lost = 0;
    for (const session of open) {
      const bindingId = session.bindingId;
      if (bindingId === undefined) continue;
      if (termPlane.host.get(bindingId) !== undefined) continue;
      const seat = seats.get(session.seatId);
      if (seat === undefined || seat.kind !== "agent") continue;
      if (!isThisMachine(seat.host, machine)) continue;
      if (termPlane.host.reportLostGeneration({ bindingId, reason: LOST_TO_CORE_RESTART })) lost += 1;
    }
    if (lost > 0) {
      console.info(`[term] ${String(lost)} seated seat(s) had no process when this core took over; marked exited`);
    }
    return lost;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        // Recovery, never a gate: the window still opens.
        console.error("[term] the seats the last core ran could not be reconciled:", cause);
        return 0;
      }),
    ),
  );
