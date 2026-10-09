import { Effect, Schema } from "effect";
import type { NodeOf } from "@shared/model";
import type { TerminalSessionSummary } from "@shared/terminal";
import { coreRunner } from "../../core-runner";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { ModelService } from "../model/service";
import type { RemoteSeatProcessClient } from "./seat-process";
import { SeatsResponse } from "./seats-link";

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
  const request = (payload: unknown) => Effect.gen(function* () {
    const hosts = yield* HostsService;
    const host = yield* hosts.get(machine);
    if (host === undefined) return yield* Effect.fail(new Error("This seat's machine is unavailable."));
    const link = yield* MachineLink;
    yield* link.connect(host);
    return yield* Schema.decodeUnknownEffect(SeatsResponse)(yield* link.request(machine, "seats", payload),
      { onExcessProperty: "error" });
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
    get: (bindingId) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return undefined;
      const response = yield* request({ _tag: "Get", canvas: held.canvas, seatId: held.seat.id });
      return yield* Effect.try({ try: () => summary(held.canvas, held.seat, response), catch: asError });
    })),
    createAgentSeat: (input) => run(Effect.gen(function* () {
      const held = yield* locate(input.bindingId);
      if (held === undefined || held.canvas !== input.canvasName || held.seat.id !== input.nodeId ||
        held.seat.harness !== input.harness || held.seat.agentKey !== input.agentKey)
        return yield* Effect.fail(new Error("The seat changed before its machine was asked to start it."));
      const response = yield* request({
        _tag: input.admission === "activate" ? "Activate" : "Start",
        canvas: held.canvas, seatId: held.seat.id,
        ...(input.admission === "activate" ? { generation: input.expectedEpoch } : {}),
      });
      const live = yield* Effect.try({ try: () => summary(held.canvas, held.seat, response), catch: asError });
      if (live === undefined) return yield* Effect.fail(new Error("The machine did not start this seat."));
      return live;
    })),
  };
};
