import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { CanvasName, NodeId, type NodeOf } from "@shared/model";
import type { TerminalSessionSummary } from "@shared/terminal";
import { MachineName } from "@shared/machine-control";
import { isThisMachine } from "@shared/machine-name";
import type { LinkChannelContext, LinkChannelHandler } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { ActorSeatOccupy } from "./actor-seat-occupy";
import { ensureSeatSessionId } from "./seat-session-before-start";
import { makeManagedSpawnIntent } from "./managed-spawn-plan";
import { termPlane } from "./plane";
import { runOnSeatStartTurn } from "./seat-start-turn";
import type { LocalSessionHost } from "./local-host";

export const SeatsStart = Schema.Struct({
  _tag: Schema.Literal("Start"), canvas: CanvasName, seatId: NodeId,
});
export const SeatsGet = Schema.Struct({
  _tag: Schema.Literal("Get"), canvas: CanvasName, seatId: NodeId,
});
export const SeatsActivate = Schema.Struct({
  _tag: Schema.Literal("Activate"), canvas: CanvasName, seatId: NodeId,
  generation: Schema.String,
});
export const SeatsRequest = Schema.Union([SeatsStart, SeatsGet, SeatsActivate]);
export const SeatsStarted = Schema.Struct({
  _tag: Schema.Literal("Started"), canvas: CanvasName, seatId: NodeId,
  machine: MachineName, handle: Schema.String, generation: Schema.String,
  createdAt: Schema.Number,
  status: Schema.Literals(["starting", "running"]),
});
export const SeatsVacant = Schema.Struct({
  _tag: Schema.Literal("Vacant"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
});
export const SeatsResponse = Schema.Union([SeatsStarted, SeatsVacant]);

type Handle = {
  readonly peer: LinkChannelContext["peer"];
  readonly sessionId: string;
  readonly canvas: string;
  readonly seatId: string;
  readonly bindingId: string;
  readonly generation: string;
  readonly signal: AbortSignal;
};

export type SeatsChannelOptions = {
  readonly host?: Pick<LocalSessionHost, "get">;
  readonly pin?: typeof ensureSeatSessionId;
};

/** The peer names a seat; its own machine derives the whole launch. */
export const makeSeatsChannel = Effect.fn("SeatsLink.make")(function* (options: SeatsChannelOptions = {}) {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const occupants = yield* ActorSeatOccupy;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const host = options.host ?? termPlane.host;
  const pin = options.pin ?? ensureSeatSessionId;
  const handles = new Map<string, Handle>();
  const watched = new WeakSet<AbortSignal>();
  const forget = (context: LinkChannelContext): void => {
    for (const [id, handle] of handles)
      if (handle.sessionId === context.sessionId && handle.peer.installationId === context.peer.installationId)
        handles.delete(id);
  };
  const disconnected = (context: LinkChannelContext) =>
    context.signal.aborted ? Effect.fail(new Error("This machine link has closed.")) : Effect.void;

  const reply = (context: LinkChannelContext, canvas: string, seat: NodeOf<"agent">,
    machine: string, live: TerminalSessionSummary) => Effect.gen(function* () {
    const current = host.get(seat.bindingId);
    if (current?.epoch !== live.epoch || current?.canvasName !== canvas || current?.nodeId !== seat.id ||
      current.harness !== seat.harness || current.agentKey !== seat.agentKey ||
      current.status === "exited" || current.status === "missing" || current.stopping === true)
      return yield* Effect.fail(new Error("The seat's occupant changed before its start was acknowledged."));
    let id: string | undefined;
    for (const [key, handle] of handles) {
      if (handle.canvas !== canvas || handle.seatId !== seat.id) continue;
      if (handle.signal.aborted || handle.bindingId !== seat.bindingId || handle.generation !== live.epoch)
        handles.delete(key);
      else if (handle.peer.installationId === context.peer.installationId && handle.peer.machineName === context.peer.machineName &&
        handle.sessionId === context.sessionId) id = key;
    }
    if (!id) {
      id = randomUUID();
      handles.set(id, { peer: context.peer, sessionId: context.sessionId, signal: context.signal,
        canvas, seatId: seat.id, bindingId: seat.bindingId, generation: live.epoch });
    }
    if (!watched.has(context.signal)) {
      watched.add(context.signal);
      context.signal.addEventListener("abort", () => forget(context), { once: true });
    }
    return yield* Schema.decodeUnknownEffect(SeatsStarted)({ _tag: "Started", canvas,
      seatId: seat.id, machine, handle: id, generation: live.epoch, createdAt: current.createdAt,
      status: current.status }, { onExcessProperty: "error" });
  });

  const handleRequest: NonNullable<LinkChannelHandler["handleRequest"]> = (context, raw) => Effect.gen(function* () {
    // Decode unknown here too: direct callers cannot bypass the transport decoder.
    const request = yield* Schema.decodeUnknownEffect(SeatsRequest)(raw, { onExcessProperty: "error" });
    const admit = Effect.fn("SeatsLink.admit")(function* () {
      yield* disconnected(context);
      const peer = yield* machines.peer(context.peer.machineName);
      if (peer?.installationId !== context.peer.installationId)
        return yield* Effect.fail(new Error("The sending machine is no longer pinned."));
      if ((yield* records.canvasEditor(request.canvas)) !== context.peer.installationId)
        return yield* Effect.fail(new Error("Only the machine editing this canvas may start its seats."));
      const name = yield* machines.machineName;
      const canvas = yield* model.canvas(request.canvas);
      const seat = canvas.nodes.get(request.seatId);
      if (seat?.kind !== "agent" || !isThisMachine(seat.host, name))
        return yield* Effect.fail(new Error("This machine does not run that seat."));
      yield* disconnected(context);
      return { seat, seq: canvas.seq, name };
    });
    const initial = yield* admit();
    if (request._tag !== "Start") {
      const live = host.get(initial.seat.bindingId);
      if (live === undefined || live.status === "exited" || live.status === "missing") {
        if (request._tag === "Activate")
          return yield* Effect.fail(new Error("This seat is vacant; activation cannot start a new occupant."));
        return { _tag: "Vacant", canvas: request.canvas, seatId: request.seatId, machine: initial.name };
      }
      if (request._tag === "Activate" && request.generation !== live.epoch)
        return yield* Effect.fail(new Error("The seat's occupant generation changed before activation."));
      return yield* reply(context, request.canvas, initial.seat, initial.name, live);
    }
    const beforeSpawn = Effect.gen(function* () {
      const current = yield* admit();
      if (current.seq !== initial.seq || current.seat.bindingId !== initial.seat.bindingId ||
        current.seat.harness !== initial.seat.harness || current.seat.agentKey !== initial.seat.agentKey)
        return yield* Effect.fail(new Error("The seat changed while its start was being prepared."));
    });
    const prepared = yield* Effect.tryPromise({
      try: () => pin({ canvasName: request.canvas, nodeId: initial.seat.id,
        bindingId: initial.seat.bindingId, harness: initial.seat.harness,
        documentLaunch: initial.seat.launch,
        ...(initial.seat.launch?.cwd ? { cwd: initial.seat.launch.cwd } : {}) }),
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    });
    if (!prepared.ok) return yield* Effect.fail(new Error(`This seat could not start: ${prepared.reason}`));
    yield* beforeSpawn;
    const start = occupants.occupy({
      canvasName: request.canvas, nodeId: initial.seat.id, bindingId: initial.seat.bindingId,
      hostId: initial.name, harness: initial.seat.harness, agentKey: initial.seat.agentKey,
      label: initial.seat.label, beforeSpawn,
      spawnIntent: makeManagedSpawnIntent({ nodeId: initial.seat.id, harness: initial.seat.harness,
        agentKey: initial.seat.agentKey, documentLaunch: initial.seat.launch,
        cwd: initial.seat.launch?.cwd, sessionId: prepared.sessionId || undefined, resume: !prepared.minted }),
    });
    const live = yield* Effect.tryPromise({
      try: () => runOnSeatStartTurn(() => run(start)),
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    });
    yield* beforeSpawn;
    return yield* reply(context, request.canvas, initial.seat, initial.name, live);
  });
  return {
    decodeRequest: Schema.decodeUnknownSync(SeatsRequest, { onExcessProperty: "error" }),
    decodeResponse: Schema.decodeUnknownSync(SeatsResponse, { onExcessProperty: "error" }),
    decodeEvent: () => { throw new Error("The seats channel has no events."); },
    handleRequest,
    closed: (context) => Effect.sync(() => forget(context)),
  } satisfies LinkChannelHandler;
});
