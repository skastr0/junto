import { randomUUID } from "node:crypto";
import { Context, Effect } from "effect";
import type { NodeOf } from "@shared/model";
import type { TerminalSessionSummary } from "@shared/terminal";
import { coreRunner } from "../core-runner";
import { HostsService } from "../hosts/service";
import { linkClient } from "../link/contract";
import { MachineLink } from "../link/service";
import { ModelService } from "../model/service";
import { ModelRecords } from "../model/records";
import { MachineRepository } from "../machines/repository";
import { isThisMachine } from "@shared/machine-name";
import type { RemoteSeatProcessClient } from "./seat-process";
import { SeatsLink, SeatsSeatResponse } from "./seats-contract";
import { fromSeatsLaunch, type RemoteSeatLaunch } from "./seats-launch";
import { remoteSeatLaunch } from "./remote-seat-launch";
import { RemoteSeatState } from "./remote-seat-state";
import { type SeatSpawnFailed } from "./seats-failure";
import type { DeleteBindingUnprovenReason } from "@shared/terminal-delete";

type Services = HostsService | MachineLink | ModelService;
export type SeatsClientRunner = <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;
const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause));

/** Why a delete stop could not prove its receipt; the operator confirms each. */
export type StopForDeleteReason = DeleteBindingUnprovenReason;
export type StopForDeleteReceipt =
  | { readonly kind: "clean" }
  | { readonly kind: "unproven"; readonly reason: StopForDeleteReason };

const classifyStopForDelete = (cause: unknown): StopForDeleteReceipt => {
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause
    ? String((cause as { _tag: unknown })._tag)
    : "";
  if (tag === "SeatEpochChanged" || tag === "SeatOccupantChanged") {
    return { kind: "unproven", reason: "epoch-changed" };
  }
  if (tag === "SeatLinkClosed") return { kind: "unproven", reason: "unreachable" };
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed?\s?out|timeout/i.test(message)) return { kind: "unproven", reason: "timeout" };
  return { kind: "unproven", reason: "refused" };
};

export type SeatsClient = RemoteSeatProcessClient & {
  /** True when the seat's machine began stopping it, false when it had no occupant. */
  readonly stop: (bindingId: string, operationId?: string) => Promise<boolean>;
  /**
   * The delete stop: Stopping or Vacant is the clean receipt. Anything else
   * is unproven, with the reason the operator's confirm names. The stop is
   * marked for delete, so the seat's machine holds its create lock until the
   * next installed copy decides.
   */
  readonly stopForDelete: (bindingId: string, operationId?: string, deleteSeq?: number) => Promise<StopForDeleteReceipt>;
  /** Release a delete hold after an abort. False means no exact hold matched or the machine could not answer. */
  readonly releaseDelete: (bindingId: string, deleteSeq: number, operationId?: string) => Promise<boolean>;
  /**
   * The operator viewed the seat's occupant of that generation. True when it
   * cleared a finished turn there, false when nothing changed or no occupant.
   */
  readonly viewed: (bindingId: string, generation: string, operationId?: string) => Promise<boolean>;
  /**
   * What the seat's next start and turn do, and its session, as its machine
   * answers a Get for a seat with no occupant, on this machine's clock.
   * Undefined when the seat has an occupant (its states carry the answer) or
   * its machine cannot say.
   */
  readonly launch: (bindingId: string, operationId?: string) => Promise<RemoteSeatLaunch | undefined>;
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
  /** This machine's typed seats client, once the link to the seat's machine is up. */
  const connect = Effect.gen(function* () {
    const hosts = yield* HostsService;
    const host = yield* hosts.get(machine);
    if (host === undefined) return yield* Effect.fail(new Error("This seat's machine is unavailable."));
    const link = yield* MachineLink;
    yield* link.connect(host);
    return yield* linkClient(SeatsLink);
  });
  const options = (operationId: string | undefined) => operationId === undefined ? undefined : { operationId };
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
      const seats = yield* connect;
      const response = yield* seats.Get(machine, { canvas: held.canvas, seatId: held.seat.id }, options(operationId));
      return yield* Effect.try({ try: () => summary(held.canvas, held.seat, response), catch: asError });
    })),
    createAgentSeat: (input, operationId) => run(Effect.gen(function* () {
      const held = yield* locate(input.bindingId);
      if (held === undefined || held.canvas !== input.canvasName || held.seat.id !== input.nodeId ||
        held.seat.harness !== input.harness || held.seat.agentKey !== input.agentKey)
        return yield* Effect.fail(new Error("The seat changed before its machine was asked to start it."));
      const seats = yield* connect;
      const response = yield* (input.admission === "activate"
        ? seats.Activate(machine, { canvas: held.canvas, seatId: held.seat.id, generation: input.expectedEpoch }, options(operationId))
        : seats.Start(machine, { canvas: held.canvas, seatId: held.seat.id }, options(operationId))).pipe(Effect.catchIf(
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
      const seats = yield* connect;
      const response = yield* seats.Stop(machine, { canvas: held.canvas, seatId: held.seat.id }, options(operationId));
      if (response.canvas !== held.canvas || response.seatId !== held.seat.id || response.machine !== machine)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return response._tag === "Stopping";
    }).pipe(Effect.annotateLogs({ area: "seats", seat: bindingId }))),
    stopForDelete: (bindingId, operationId, deleteSeq) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return { kind: "unproven", reason: "unreachable" } as const;
      if (deleteSeq === undefined || !Number.isSafeInteger(deleteSeq) || deleteSeq < 0)
        return yield* Effect.fail(new Error("A delete stop requires the editor's canvas seq."));
      // The epoch this machine last saw of the seat; none sends without, so
      // the seat's machine stops whoever occupies it now.
      const state = Context.getOrUndefined(yield* Effect.context<never>(), RemoteSeatState);
      const epoch = state?.events().find((event) => event.bindingId === bindingId)?.epoch;
      const seats = yield* connect;
      const response = yield* seats.Stop(machine, {
        canvas: held.canvas, seatId: held.seat.id, forDelete: true, deleteSeq,
        ...(epoch === undefined ? {} : { generation: epoch }),
      }, options(operationId));
      if (response.canvas !== held.canvas || response.seatId !== held.seat.id || response.machine !== machine)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return { kind: "clean" } as const;
    }).pipe(
      Effect.catch((cause: unknown) => Effect.succeed(classifyStopForDelete(cause))),
      Effect.annotateLogs({ area: "seats", seat: bindingId }),
    )),
    releaseDelete: (bindingId, deleteSeq, operationId) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return false;
      const seats = yield* connect;
      const response = yield* seats.ReleaseDelete(machine, {
        canvas: held.canvas, seatId: held.seat.id, deleteSeq,
      }, options(operationId));
      if (response.canvas !== held.canvas || response.seatId !== held.seat.id || response.machine !== machine)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return response.released;
    }).pipe(Effect.annotateLogs({ area: "seats", seat: bindingId }))),
    viewed: (bindingId, generation, operationId = randomUUID()) => run(Effect.gen(function* () {
      const held = yield* locate(bindingId);
      if (held === undefined) return false;
      const seats = yield* connect;
      const response = yield* seats.Viewed(machine, { canvas: held.canvas, seatId: held.seat.id, generation }, { operationId });
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
      const seats = yield* connect;
      const response = yield* seats.Get(machine, { canvas: held.canvas, seatId: held.seat.id }, options(operationId));
      if (response.canvas !== held.canvas || response.seatId !== held.seat.id || response.machine !== machine)
        return yield* Effect.fail(new Error("The machine answered for another seat."));
      return response._tag === "Vacant" && response.launch !== undefined ? fromSeatsLaunch(response.launch, Date.now()) : undefined;
    }).pipe(Effect.annotateLogs({ area: "seats", seat: bindingId }))),
  };
};

/**
 * A seat that runs on another machine: what that machine last said of its
 * next start, next turn and session. Its states carry the answer while it
 * has an occupant; otherwise its machine is asked (Get) as remoteSeatLaunch
 * allows.
 */
export const remoteSeatLaunchOf = (seat: { readonly bindingId: string; readonly host: string }): Promise<RemoteSeatLaunch | undefined> =>
  coreRunner.runPromise(Effect.gen(function* () {
    // The core's layer holds RemoteSeatState; a runtime without it (a bare
    // runner) has no remembered states, so the seat's machine is asked instead.
    const state = Context.getOrUndefined(yield* Effect.context<never>(), RemoteSeatState);
    const last = state?.events().find((event) => event.bindingId === seat.bindingId);
    return yield* Effect.promise(() => remoteSeatLaunch({
      bindingId: seat.bindingId, machine: seat.host, live: last !== undefined && last.state !== "gone",
      ask: () => makeSeatsProcessClient(seat.host).launch(seat.bindingId),
    }));
  }));

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
