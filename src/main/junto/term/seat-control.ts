/**
 * Start and stop an agent seat by canvas and seat id: the one path the window
 * and the owner commands share. Plain terminals stay the window's.
 */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { managedHarnessEnabled } from "@shared/managed-terminal-templates";
import { CanvasName, NodeId, type NodeOf } from "@shared/model";
import type { TerminalSessionSummary } from "@shared/terminal";
import { ModelService } from "../model/service";
import { ActorSeatOccupy } from "./actor-seat-occupy";
import { makeManagedSpawnIntent } from "./managed-spawn-plan";
import { termPlane, type TermPlane } from "./plane";
import { ensureSeatSessionId } from "./seat-session-before-start";
import { asSeatsFailure, clipText, SeatSessionUnavailable } from "./seats-failure";
import { makeSeatsProcessClient } from "./seats-client";

const Where = { canvas: CanvasName, seatId: NodeId };
const Text = Schema.String.pipe(Schema.check(Schema.isMaxLength(1024)));

export class SeatNotFound extends Schema.TaggedError<SeatNotFound>()("SeatNotFound", {
  ...Where, message: Text,
}) {}

/** The node exists and is not an agent seat (a plain terminal, a note). */
export class NotASeat extends Schema.TaggedError<NotASeat>()("NotASeat", {
  ...Where, kind: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))), message: Text,
}) {}

export class HarnessDisabled extends Schema.TaggedError<HarnessDisabled>()("HarnessDisabled", {
  ...Where, harness: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))), message: Text,
}) {}

/** The seat's identity or placement changed, or it is being deleted, while it was starting. */
export class SeatChangedWhileStarting extends Schema.TaggedError<SeatChangedWhileStarting>()(
  "SeatChangedWhileStarting", { ...Where, message: Text },
) {}

export type SeatControlError = SeatNotFound | NotASeat | HarnessDisabled | SeatChangedWhileStarting;

export type SeatControlOptions = {
  readonly plane?: Pick<TermPlane, "router" | "nodeDelete">;
  /** The window's own reachability step for another machine; the core passes none. */
  readonly ensureHostAvailable?: (host: string) => Promise<void>;
  /** Names the seat's session before a local start; the live repository by default. */
  readonly pin?: typeof ensureSeatSessionId;
};

const readSeat = Effect.fn("SeatControl.read")(function* (canvas: CanvasName, seatId: NodeId) {
  const model = yield* ModelService;
  if (!(yield* model.listCanvases()).includes(canvas))
    return yield* new SeatNotFound({ canvas, seatId, message: "No canvas by that name on this machine." });
  const node = (yield* model.canvas(canvas)).nodes.get(seatId);
  if (node === undefined)
    return yield* new SeatNotFound({ canvas, seatId, message: "No node with that id on this canvas." });
  if (node.kind !== "agent")
    return yield* new NotASeat({ canvas, seatId, kind: node.kind, message: "This node is not an agent seat." });
  return node;
});

/**
 * Start the seat, or return its live generation. A harness that cannot start
 * is not a failure here: its exited generation carries exitReason and
 * exitMessage, as the window shows it.
 */
export const startSeat = Effect.fn("SeatControl.start")(function* (input: {
  readonly canvas: CanvasName;
  readonly seatId: NodeId;
  readonly operationId?: string;
}, options: SeatControlOptions = {}) {
  const plane = options.plane ?? termPlane;
  const { canvas, seatId } = input;
  const changed = (message: string) => new SeatChangedWhileStarting({ canvas, seatId, message });
  const node = yield* readSeat(canvas, seatId);
  if (!managedHarnessEnabled(node.harness))
    return yield* new HarnessDisabled({ canvas, seatId, harness: node.harness,
      message: `The ${node.harness} harness is disabled in this build.` });
  const admission = yield* Effect.try({
    try: () => plane.nodeDelete.admitCreate(node.bindingId, node.host),
    catch: (cause) => changed(cause instanceof Error ? clipText(cause.message) : "This seat is being deleted."),
  });
  const ensureHost = options.ensureHostAvailable;
  if (ensureHost !== undefined) yield* Effect.tryPromise({
    try: () => ensureHost(node.host),
    catch: (cause) => asSeatsFailure({ machine: node.host, canvas, seatId }, cause),
  });
  const assertCurrent = Effect.gen(function* () {
    yield* Effect.try({ try: () => plane.nodeDelete.assertCreate(admission),
      catch: () => changed("This seat was deleted while it was starting.") });
    const current = yield* readSeat(canvas, seatId);
    if (current.bindingId !== node.bindingId || current.host !== node.host ||
      current.harness !== node.harness || current.agentKey !== node.agentKey)
      return yield* changed("This seat changed while it was starting.");
  });
  const local = plane.router.isLocalHostId(node.host);
  const provisioned = local
    ? yield* Effect.promise(() => (options.pin ?? ensureSeatSessionId)({ canvasName: canvas, nodeId: node.id,
      bindingId: node.bindingId, harness: node.harness, documentLaunch: node.launch, cause: "operator",
      ...(node.launch?.cwd ? { cwd: node.launch.cwd } : {}) }))
    : { ok: true as const, sessionId: "", minted: false };
  if (!provisioned.ok)
    return yield* new SeatSessionUnavailable({ machine: node.host, canvas, seatId,
      reason: clipText(provisioned.reason), message: clipText(`This seat could not start: ${provisioned.reason}`) });
  const spawnIntent = makeManagedSpawnIntent({ nodeId: node.id, harness: node.harness,
    documentLaunch: node.launch, agentKey: node.agentKey, cwd: node.launch?.cwd,
    sessionId: provisioned.sessionId || undefined,
    resume: !provisioned.minted,
  });
  yield* assertCurrent;
  const seats = yield* ActorSeatOccupy;
  return yield* seats.occupy({ bindingId: node.bindingId, harness: node.harness, agentKey: node.agentKey,
    hostId: node.host, spawnIntent, canvasName: canvas, nodeId: node.id, label: node.label,
    seatRect: { x: node.x, y: node.y, width: node.width, height: node.height },
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
  }) satisfies Effect.Effect<TerminalSessionSummary, unknown>;
});

/** Stop the seat's occupant on whichever machine runs it. */
export const stopSeat = Effect.fn("SeatControl.stop")(function* (input: {
  readonly canvas: CanvasName;
  readonly seatId: NodeId;
  readonly operationId?: string;
}, options: SeatControlOptions = {}) {
  const plane = options.plane ?? termPlane;
  const node: NodeOf<"agent"> = yield* readSeat(input.canvas, input.seatId);
  const operationId = input.operationId ?? randomUUID();
  const stopping = plane.router.isLocalHostId(node.host)
    ? yield* Effect.promise(() => plane.router.kill(node.bindingId, node.host))
    : yield* Effect.tryPromise({
      try: () => makeSeatsProcessClient(node.host).stop(node.bindingId, operationId),
      catch: (cause) => cause,
    });
  const outcome = stopping ? "stopping" as const : "vacant" as const;
  yield* Effect.logInfo(`seat stop ${outcome}`);
  return { outcome };
}, (effect, input, _options?: SeatControlOptions) => effect.pipe(Effect.annotateLogs({
  area: "seats", seat: input.seatId, canvas: input.canvas,
  ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
})));
