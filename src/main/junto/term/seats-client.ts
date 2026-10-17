import { Effect, Schema } from "effect";
import type { NodeOf } from "@shared/model";
import type { TerminalSessionSummary } from "@shared/terminal";
import { coreRunner } from "../../core-runner";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { ModelService } from "../model/service";
import type { RemoteSeatProcessClient } from "./seat-process";
import { SeatsResponse } from "./seats-link";
import { type SeatSpawnFailed, unwrapSeatsFailure } from "./seats-failure";

type Services = HostsService | MachineLink | ModelService;
export type SeatsClientRunner = <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;
const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause));

/** A remote process client sends seat identity only, never a launch plan. */
export const makeSeatsProcessClient = (
  machine: string,
  run: SeatsClientRunner = coreRunner.runPromise,
): RemoteSeatProcessClient => {
  const locate = (bindingId: string) => Effect.gen(function* () {
    const model = yield* ModelService;
    for (const canvas of yield* model.listCanvases()) {
      for (const node of (yield* model.canvas(canvas)).nodes.values()) {
        if (node.kind === "agent" && node.bindingId === bindingId && node.host === machine)
          return { canvas, seat: node };
      }
    }
    return undefined;
  });
  const request = (payload: unknown, operationId: string | undefined) => Effect.gen(function* () {
    const hosts = yield* HostsService;
    const host = yield* hosts.get(machine);
    if (host === undefined) return yield* Effect.fail(new Error("This seat's machine is unavailable."));
    const link = yield* MachineLink;
    yield* link.connect(host);
    const response = yield* link.request(machine, "seats", payload,
      operationId === undefined ? undefined : { operationId }).pipe(Effect.mapError(unwrapSeatsFailure));
    return yield* Schema.decodeUnknownEffect(SeatsResponse)(response, { onExcessProperty: "error" });
  });
  /** A harness that never started is the same exited generation a local start returns. */
  const exited = (canvas: string, seat: NodeOf<"agent">, failure: SeatSpawnFailed): TerminalSessionSummary => ({
    bindingId: seat.bindingId, hostId: machine, canvasName: canvas, nodeId: seat.id,
    harness: seat.harness, agentKey: seat.agentKey, epoch: failure.epoch, status: "exited",
    createdAt: Date.now(), detached: false, exitReason: failure.exitReason, exitMessage: failure.exitMessage,
  });
  const summary = (canvas: string, seat: NodeOf<"agent">, response: typeof SeatsResponse.Type): TerminalSessionSummary | undefined => {
    if (response.canvas !== canvas || response.seatId !== seat.id || response.machine !== machine)
      throw new Error("The machine returned another seat's occupant.");
    return response._tag === "Vacant" ? undefined : {
      bindingId: seat.bindingId, hostId: machine, canvasName: canvas, nodeId: seat.id,
      harness: seat.harness, agentKey: seat.agentKey, epoch: response.generation,
      status: response.status, createdAt: response.createdAt, detached: false,
    };
  };
  return {
    get: (bindingId, operationId) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return undefined;
      const response = yield* request({ _tag: "Get", canvas: held.canvas, seatId: held.seat.id }, operationId);
      return yield* Effect.try({ try: () => summary(held.canvas, held.seat, response), catch: asError });
    })),
    createAgentSeat: (input, operationId) => run(Effect.gen(function* () {
      const held = yield* locate(input.bindingId);
      if (held === undefined || held.canvas !== input.canvasName || held.seat.id !== input.nodeId ||
        held.seat.harness !== input.harness || held.seat.agentKey !== input.agentKey)
        return yield* Effect.fail(new Error("The seat changed before its machine was asked to start it."));
      const response = yield* request({
        _tag: input.admission === "activate" ? "Activate" : "Start",
        canvas: held.canvas, seatId: held.seat.id,
        ...(input.admission === "activate" ? { generation: input.expectedEpoch } : {}),
      }, operationId).pipe(Effect.catchIf(
        (failure): failure is SeatSpawnFailed =>
          typeof failure === "object" && failure !== null && "_tag" in failure && failure._tag === "SeatSpawnFailed" &&
          (failure as SeatSpawnFailed).machine === machine && (failure as SeatSpawnFailed).seatId === held.seat.id,
        (failure) => Effect.succeed(exited(held.canvas, held.seat, failure)),
      ));
      if (!("_tag" in response)) return response;
      const live = yield* Effect.try({ try: () => summary(held.canvas, held.seat, response), catch: asError });
      if (live === undefined) return yield* Effect.fail(new Error("The machine did not start this seat."));
      return live;
    })),
  };
};
