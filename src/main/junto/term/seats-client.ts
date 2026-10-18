import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { NodeOf } from "@shared/model";
import type { TerminalSessionSummary } from "@shared/terminal";
import { coreRunner } from "../../core-runner";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { ModelService } from "../model/service";
import { ModelRecords } from "../model/records";
import { MachineRepository } from "../machines/repository";
import { isThisMachine } from "@shared/machine-name";
import type { RemoteSeatProcessClient } from "./seat-process";
import { SeatsSeatResponse } from "./seats-link";
import { fromSeatsLaunch, type SeatLaunchState } from "./seats-launch";
import { type SeatSpawnFailed, unwrapSeatsFailure } from "./seats-failure";

type Services = HostsService | MachineLink | ModelService;
export type SeatsClientRunner = <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;
const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause));

export type SeatsClient = RemoteSeatProcessClient & {
  /** True when the seat's machine began stopping it, false when it had no occupant. */
  readonly stop: (bindingId: string, operationId?: string) => Promise<boolean>;
  /**
   * The operator viewed the seat's occupant of that generation. True when it
   * cleared a finished turn there, false when nothing changed or no occupant.
   */
  readonly viewed: (bindingId: string, generation: string, operationId?: string) => Promise<boolean>;
  /**
   * What the seat's next start and turn do, as its machine answers a Get for
   * a seat with no occupant, on this machine's clock. Undefined when the seat
   * has an occupant (its states carry the answer) or its machine cannot say.
   */
  readonly launch: (bindingId: string, operationId?: string) => Promise<SeatLaunchState | undefined>;
};

/** A remote process client sends seat identity only, never a launch plan. */
export const makeSeatsProcessClient = (
  machine: string,
  run: SeatsClientRunner = coreRunner.runPromise,
): SeatsClient => {
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
    return yield* Schema.decodeUnknownEffect(SeatsSeatResponse)(response, { onExcessProperty: "error" });
  });
  /** A harness that never started is the same exited generation a local start returns. */
  const exited = (canvas: string, seat: NodeOf<"agent">, failure: SeatSpawnFailed): TerminalSessionSummary => ({
    bindingId: seat.bindingId, hostId: machine, canvasName: canvas, nodeId: seat.id,
    harness: seat.harness, agentKey: seat.agentKey, epoch: failure.epoch, status: "exited",
    createdAt: Date.now(), detached: false, exitReason: failure.exitReason, exitMessage: failure.exitMessage,
  });
  const summary = (canvas: string, seat: NodeOf<"agent">, response: typeof SeatsSeatResponse.Type): TerminalSessionSummary | undefined => {
    if (response.canvas !== canvas || response.seatId !== seat.id || response.machine !== machine)
      throw new Error("The machine returned another seat's occupant.");
    if (response._tag === "Stopping") throw new Error("The machine answered a start with a stop.");
    if (response._tag === "Seen") throw new Error("The machine answered a start with a view.");
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
    stop: (bindingId, operationId) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return false;
      const response = yield* request({ _tag: "Stop", canvas: held.canvas, seatId: held.seat.id }, operationId);
      if (response.canvas !== held.canvas || response.seatId !== held.seat.id || response.machine !== machine)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return response._tag === "Stopping";
    }).pipe(Effect.annotateLogs({ area: "seats", seat: bindingId }))),
    viewed: (bindingId, generation, operationId = randomUUID()) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return false;
      const response = yield* request({ _tag: "Viewed", canvas: held.canvas, seatId: held.seat.id, generation }, operationId);
      if (response.canvas !== held.canvas || response.seatId !== held.seat.id || response.machine !== machine)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return response._tag === "Seen" && response.changed;
    }).pipe(
      Effect.tap((changed) => Effect.logInfo("seat view answered").pipe(Effect.annotateLogs({ changed }))),
      Effect.tapCause((cause) => Effect.logWarning("seat view failed", cause)),
      Effect.annotateLogs({ area: "seats", seat: bindingId, machine, operationId }),
    )),
    launch: (bindingId, operationId) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return undefined;
      const response = yield* request({ _tag: "Get", canvas: held.canvas, seatId: held.seat.id }, operationId);
      if (response.canvas !== held.canvas || response.seatId !== held.seat.id || response.machine !== machine)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return response._tag === "Vacant" && response.launch !== undefined ? fromSeatsLaunch(response.launch, Date.now()) : undefined;
    }).pipe(Effect.annotateLogs({ area: "seats", seat: bindingId }))),
  };
};

/**
 * The machine running a seat on a canvas this machine edits, when that seat
 * runs elsewhere: where a view of it goes. Undefined for any other seat.
 */
export const remoteSeatMachine = (bindingId: string) => Effect.gen(function* () {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const self = yield* machines.installationId;
  const name = yield* machines.machineName;
  for (const canvas of yield* model.listCanvases()) {
    if (((yield* records.canvasEditor(canvas)) ?? self) !== self) continue;
    for (const node of (yield* model.canvas(canvas)).nodes.values()) {
      if (node.kind === "agent" && node.bindingId === bindingId && !isThisMachine(node.host, name)) return node.host;
    }
  }
  return undefined;
});
