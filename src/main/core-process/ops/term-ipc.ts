import { seatStateRuntime } from "../../junto/term/agent-state";
import { Effect } from "effect";
import type { MachineInventoryResult, NativeSettingsReadResult, NativeSettingWriteResult } from "@shared/ipc";
import { asCanvasName, type NodeId, type NodeOf } from "@shared/model";
import { coreOps, type CoreOp } from "../ops";
import { ModelService } from "../../junto/model/service";
import { MachineRepository } from "../../junto/machines/repository";
import { seatLaunchState } from "../../junto/term/seat-launch-state";
import type { TerminalSessionSummary } from "@shared/terminal";
import type { TerminalAttachInput, TerminalFinishNodeDeleteOutcome, TerminalNodeDeleteResource } from "@shared/ipc";
import type { ControlLease, LocalHostEvent } from "../../junto/term/local-host";
import type { TermPlane } from "../../junto/term/plane";
import { injectionSupervisor } from "../../junto/term/injection-supervisor";
import { onRemoteSeatState, rememberRemoteSeatState } from "../../junto/term/remote-seat-state";
import { remoteSeatLaunchOf } from "../../junto/term/seats-client";
import { cardSeatLaunch } from "../../junto/term/seats-launch";
import { liveSeatEnvironment } from "../../junto/region-env/live";
import { publish } from "../push";
import { TERM_EVENT, TERM_LEASE_ENDED, TERM_SEAT_STATE } from "../channels";

/**
 * The core operations `term/ipc.ts` asks for (Wave 3). Seat start and stop
 * run on the core's own terminal plane, which is the one this file binds.
 */
/**
 * Where the terminal plane is: main's, with the core in main, or the core
 * process's own. Whoever holds it binds it once; its events go out on the
 * push bus, which main forwards to the window either way.
 */
let termPlane: TermPlane | undefined;

export const bindTermIpcPlane = (plane: TermPlane): (() => void) => {
  termPlane = plane;
  plane.router.setTerminalEnvironment(liveSeatEnvironment);
  const onEvent = (payload: LocalHostEvent): void => {
    if (payload.type === "seat-state") rememberRemoteSeatState(payload.event);
    publish(TERM_EVENT, payload);
  };
  const onLeaseEnded = (end: { readonly leaseId: string; readonly reason: string }): void => publish(TERM_LEASE_ENDED, end);
  plane.router.on("event", onEvent);
  plane.router.on("lease-ended", onLeaseEnded);
  const stopSeatState = onRemoteSeatState((event) => publish(TERM_SEAT_STATE, event));
  const stopLocalSeatState = seatStateRuntime.subscribe((event) => publish(TERM_SEAT_STATE, event));
  return () => {
    plane.router.off("event", onEvent);
    plane.router.off("lease-ended", onLeaseEnded);
    stopSeatState();
    stopLocalSeatState();
    if (termPlane === plane) termPlane = undefined;
  };
};

const planeNow = (): Effect.Effect<TermPlane, Error> =>
  termPlane === undefined ? Effect.fail(new Error("the terminal plane is not running")) : Effect.succeed(termPlane);

/** A router call that answers a promise, failing as the router fails. */
const routed = <A>(use: (plane: TermPlane) => Promise<A>): Effect.Effect<A, Error> =>
  Effect.flatMap(planeNow(), (plane) => Effect.tryPromise({
    try: () => use(plane),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  }));

/** A seat on another machine is reached only over the seats channel, where its machine answers. */
const remoteSeats = (hostId: string) =>
  Effect.promise(() => import("../../junto/term/seats-client")).pipe(Effect.map(({ makeSeatsProcessClient }) => makeSeatsProcessClient(hostId)));

const stopBinding = (bindingId: string, hostId: string | undefined) =>
  Effect.flatMap(planeNow(), (plane) =>
    hostId !== undefined && !plane.router.isLocalHostId(hostId)
      ? Effect.flatMap(remoteSeats(hostId), (seats) => routed(() => seats.stop(bindingId, crypto.randomUUID())))
      : routed(() => plane.router.kill(bindingId, hostId)));

type Router = TermPlane["router"];
type AttachResult = Awaited<ReturnType<Router["attach"]>>;
type CardLaunch = ReturnType<typeof cardSeatLaunch>;

type SeatNode = NodeOf<"agent"> | NodeOf<"terminal">;
type SeatLaunchState = Effect.Success<ReturnType<typeof seatLaunchState>>;
type HarnessModels = Effect.Success<ReturnType<(typeof import("../../junto/term/templates/harness-inventory"))["HarnessInventory"]["Service"]["models"]>>;

declare module "../ops" {
  interface CoreOps {
    "term.seatNode": CoreOp<{ readonly canvas: string; readonly id: string }, SeatNode | undefined>;
    "term.seatLaunchState": CoreOp<{ readonly canvas: string; readonly node: NodeOf<"agent"> }, SeatLaunchState>;
    "term.startSeat": CoreOp<{ readonly canvas: string; readonly seatId: NodeId }, TerminalSessionSummary>;
    "term.stopSeat": CoreOp<{ readonly canvas: string; readonly seatId: NodeId }, void>;
    "term.harnessModels": CoreOp<{ readonly harness: string }, HarnessModels>;
    "term.machineInventory": CoreOp<{ readonly machine: string }, MachineInventoryResult>;
    "term.nativeSettingsRead": CoreOp<{ readonly machine: string; readonly harness: string; readonly keys: readonly string[] }, NativeSettingsReadResult>;
    "term.nativeSettingWrite": CoreOp<{ readonly machine: string; readonly harness: string; readonly key: string; readonly value: unknown }, NativeSettingWriteResult>;
    "term.isLocalHost": CoreOp<{ readonly hostId: string }, boolean>;
    "term.thisMachine": CoreOp<Record<string, never>, string>;
    "term.list": CoreOp<{ readonly hostId?: string }, ReadonlyArray<TerminalSessionSummary>>;
    "term.readDirectory": CoreOp<{ readonly hostId: string; readonly path?: string }, Awaited<ReturnType<Router["readDirectory"]>>>;
    /** A seat on another machine: what it last said, for its card; undefined when it cannot say. */
    "term.remoteSeatLaunch": CoreOp<{ readonly node: NodeOf<"agent"> }, CardLaunch | undefined>;
    "term.startTerminal": CoreOp<{ readonly canvas: string; readonly node: NodeOf<"terminal"> }, Awaited<ReturnType<Router["create"]>>>;
    "term.stopBinding": CoreOp<{ readonly bindingId: string; readonly hostId?: string }, unknown>;
    "term.get": CoreOp<{ readonly bindingId: string; readonly hostId?: string }, TerminalSessionSummary | undefined>;
    "term.beginNodeDelete": CoreOp<{ readonly resources: ReadonlyArray<TerminalNodeDeleteResource> }, unknown>;
    "term.finishNodeDelete": CoreOp<{ readonly leaseId: string; readonly outcome: TerminalFinishNodeDeleteOutcome }, unknown>;
    /** The attach and the host it went to (this machine when none was named). */
    "term.attach": CoreOp<{ readonly input: TerminalAttachInput & { readonly hostId?: string } }, { readonly hostId: string; readonly result: AttachResult }>;
    "term.release": CoreOp<{ readonly lease: ControlLease; readonly hostId: string }, void>;
    "term.write": CoreOp<{ readonly lease: ControlLease; readonly data: string; readonly hostId: string }, boolean>;
    "term.resize": CoreOp<{ readonly lease: ControlLease; readonly cols: number; readonly rows: number; readonly hostId: string }, boolean>;
  }
}

coreOps({
  "term.isLocalHost": ({ hostId }) => Effect.map(planeNow(), (plane) => plane.router.isLocalHostId(hostId)),
  "term.thisMachine": () => Effect.map(planeNow(), (plane) => plane.router.thisMachineName()),
  "term.list": ({ hostId }) =>
    routed((plane) => hostId === "*" || hostId === "all" ? plane.router.listAll() : Promise.resolve(plane.router.list(hostId))),
  "term.readDirectory": ({ hostId, path }) => routed((plane) => plane.router.readDirectory(hostId, path)),
  "term.remoteSeatLaunch": ({ node }) =>
    Effect.map(Effect.promise(() => remoteSeatLaunchOf(node)), (launch) => launch === undefined ? undefined : cardSeatLaunch(launch, Date.now())),
  "term.startTerminal": ({ canvas, node }) =>
    Effect.gen(function* () {
      const plane = yield* planeNow();
      const createAdmission = plane.nodeDelete.admitCreate(node.bindingId, node.host);
      const assertCurrent = Effect.gen(function* () {
        plane.nodeDelete.assertCreate(createAdmission);
        const current = (yield* (yield* ModelService).canvas(canvas)).nodes.get(node.id);
        plane.nodeDelete.assertCreate(createAdmission);
        if (current?.kind !== node.kind || current.bindingId !== node.bindingId || current.host !== node.host)
          return yield* Effect.fail(new Error("terminal ipc: seat changed while starting"));
      });
      yield* assertCurrent;
      const opened = yield* routed(() => plane.router.create({ bindingId: node.bindingId, hostId: node.host,
        ...(node.launch ? { launch: node.launch } : {}), canvasName: canvas, nodeId: node.id,
        seatRect: { x: node.x, y: node.y, width: node.width, height: node.height },
        ...(node.label ? { label: node.label } : {}),
      }));
      // The window is told a terminal exists only once its exact process
      // identity is bound; the observation waits off the canvas thread.
      yield* routed(() => plane.router.awaitStartIdentity(opened.bindingId, opened.epoch, node.host));
      return opened;
    }),
  "term.stopBinding": ({ bindingId, hostId }) => stopBinding(bindingId, hostId),
  "term.get": ({ bindingId, hostId }) =>
    Effect.flatMap(planeNow(), (plane) => hostId !== undefined && !plane.router.isLocalHostId(hostId)
      ? Effect.flatMap(remoteSeats(hostId), (seats) => routed(() => seats.get(bindingId)))
      : routed(() => Promise.resolve(plane.router.get(bindingId, hostId)))),
  "term.beginNodeDelete": ({ resources }) => routed((plane) => Promise.resolve(plane.nodeDelete.beginNodeDelete(resources))),
  "term.finishNodeDelete": ({ leaseId, outcome }) => routed((plane) => Promise.resolve(plane.nodeDelete.finishNodeDelete(leaseId, outcome))),
  "term.attach": ({ input }) =>
    Effect.gen(function* () {
      const plane = yield* planeNow();
      const hostId = input.hostId?.trim() || plane.router.thisMachineName();
      return { hostId, result: yield* routed(() => plane.router.attach({ ...input, hostId })) };
    }),
  "term.release": ({ lease, hostId }) => routed((plane) => Promise.resolve(plane.router.release(lease, hostId)).then(() => undefined)),
  "term.write": ({ lease, data, hostId }) =>
    Effect.tap(routed((plane) => plane.router.write(lease, data, hostId)), (ok) =>
      // Input-origin tagging: user keystrokes must suppress injection.
      Effect.sync(() => { if (ok) injectionSupervisor.noteUserInput(lease.bindingId, undefined, data); })),
  "term.resize": ({ lease, cols, rows, hostId }) => routed((plane) => plane.router.resize(lease, cols, rows, hostId)),
  "term.seatNode": ({ canvas, id }) =>
    Effect.gen(function* () {
      const model = yield* ModelService;
      const node = (yield* model.canvas(canvas)).nodes.get(id as never);
      return node?.kind === "agent" || node?.kind === "terminal" ? node : undefined;
    }),
  "term.seatLaunchState": ({ canvas, node }) => seatLaunchState(canvas, node),
  "term.startSeat": ({ canvas, seatId }) =>
    Effect.gen(function* () {
      const { startSeat } = yield* Effect.promise(() => import("../../junto/term/seat-control"));
      return yield* startSeat({ canvas: asCanvasName(canvas), seatId });
    }),
  "term.stopSeat": ({ canvas, seatId }) =>
    Effect.gen(function* () {
      const { stopSeat } = yield* Effect.promise(() => import("../../junto/term/seat-control"));
      yield* stopSeat({ canvas: asCanvasName(canvas), seatId });
    }),
  "term.harnessModels": ({ harness }) =>
    Effect.gen(function* () {
      const { HarnessInventory } = yield* Effect.promise(() => import("../../junto/term/templates/harness-inventory"));
      return yield* Effect.flatMap(HarnessInventory, (inventory) => inventory.models(harness));
    }),
  "term.machineInventory": ({ machine }) =>
    Effect.gen(function* () {
      const { HarnessInventory } = yield* Effect.promise(() => import("../../junto/term/templates/harness-inventory"));
      const { peerInventory } = yield* Effect.promise(() => import("../../junto/inventory/client"));
      const inventory = yield* HarnessInventory;
      const own = yield* (yield* MachineRepository).machineName.pipe(Effect.orElseSucceed(() => undefined));
      if (own === undefined || own === machine) return { ok: true, inventory: yield* inventory.machine } satisfies MachineInventoryResult;
      // A linked machine answers over the link's inventory channel.
      return yield* peerInventory().inventoryOf(machine);
    }).pipe(
      Effect.catchTag("InventoryUnavailableError", (error) => Effect.succeed<MachineInventoryResult>({
        ok: false,
        error: { _tag: error._tag, machine: error.machine || machine, reason: error.reason, message: error.message },
      })),
    ),
  "term.nativeSettingsRead": ({ machine, harness, keys }) =>
    Effect.gen(function* () {
      const { nativeConfigClient } = yield* Effect.promise(() => import("../../junto/inventory/native-client"));
      return yield* Effect.flatMap(nativeConfigClient, (client) => client.readSettings({ machine, harness, keys }));
    }),
  "term.nativeSettingWrite": ({ machine, harness, key, value }) =>
    Effect.gen(function* () {
      const { nativeConfigClient } = yield* Effect.promise(() => import("../../junto/inventory/native-client"));
      return yield* Effect.flatMap(nativeConfigClient, (client) => client.writeSetting({ machine, harness, key, value }));
    }),
});
