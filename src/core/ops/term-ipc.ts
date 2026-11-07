/**
 * The core's handlers of the terminal group (src/contract/core/term-ipc.ts):
 * what the window's terminal IPC asks of the plane (app/term/ipc.ts). Seat
 * start and stop run on the core's own terminal plane, the one this core
 * binds (core.ts), which every handler reads from the context.
 *
 * Whoever holds the plane binds it once (`bindTermIpcPlane`): its events go
 * out on the push bus, which main forwards to the window.
 */
import { Context, Effect, Layer, Predicate } from "effect";
import { asCanvasName } from "@shared/model";
import type { MachineInventoryResult } from "@shared/ipc";
import { TermRefused, TermRpcs } from "../../contract/core/term-ipc";
import { TERM_EVENT, TERM_LEASE_ENDED, TERM_SEAT_STATE } from "../../contract/core/channels";
import { seatStateRuntime } from "../term/agent-state";
import { ModelService } from "../model/service";
import { MachineRepository } from "../machines/repository";
import { seatLaunchState } from "../term/seat-launch-state";
import type { LocalHostEvent } from "../term/local-host";
import type { TermPlane } from "../term/plane";
import { injectionSupervisor } from "../term/injection-supervisor";
import { RemoteSeatState } from "../term/remote-seat-state";
import { remoteSeatLaunchOf } from "../term/seats-client";
import { cardSeatLaunch } from "../term/seats-launch";
import { liveSeatEnvironment } from "../region-env/live";
import { publish } from "../push";

/** The terminal plane the window's terminals run on: the router, the node-delete fence, and the host that holds surface ports. */
export class TermIpcPlane extends Context.Service<TermIpcPlane, Pick<TermPlane, "router" | "nodeDelete" | "host">>()(
  "@junto/core/TermIpcPlane",
) {
  /** The one plane this core runs (term/plane.ts), the one core.ts binds for the window. */
  static readonly live = Layer.effect(
    TermIpcPlane,
    Effect.map(Effect.promise(() => import("../term/plane")), ({ termPlane }) => termPlane),
  );
}

/**
 * Bind the plane's events to the push bus: its terminal events, the leases a
 * linked seat's machine ended, and every seat's state, this machine's and a
 * linked one's. The returned function unbinds them.
 */
export const bindTermIpcPlane = (plane: TermPlane, remoteState: RemoteSeatState["Service"]): (() => void) => {
  plane.router.setTerminalEnvironment(liveSeatEnvironment);
  const onEvent = (payload: LocalHostEvent): void => {
    if (payload.type === "seat-state") remoteState.remember(payload.event);
    publish(TERM_EVENT, payload);
  };
  const onLeaseEnded = (end: { readonly leaseId: string; readonly reason: string }): void => publish(TERM_LEASE_ENDED, end);
  plane.router.on("event", onEvent);
  plane.router.on("lease-ended", onLeaseEnded);
  const stopSeatState = remoteState.onState((event) => publish(TERM_SEAT_STATE, event));
  const stopLocalSeatState = seatStateRuntime.subscribe((event) => publish(TERM_SEAT_STATE, event));
  return () => {
    plane.router.off("event", onEvent);
    plane.router.off("lease-ended", onLeaseEnded);
    stopSeatState();
    stopLocalSeatState();
  };
};

/** A failure as the window shows it: its own sentence, or what it was. */
const refusal = (cause: unknown): TermRefused =>
  new TermRefused({
    message:
      cause instanceof Error ? cause.message : Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause),
  });

/** A call the window reads a refusal of: every failure, and a throw inside it, becomes `TermRefused`. */
const answered = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, TermRefused, R> =>
  effect.pipe(
    Effect.mapError(refusal),
    Effect.catchDefect((defect) => Effect.fail(refusal(defect))),
  );

/** A router call that answers a promise, refused as the router refuses. */
const routed = <A>(use: () => Promise<A>): Effect.Effect<A, TermRefused> => Effect.tryPromise({ try: use, catch: refusal });

/** A seat on another machine is reached only over the seats channel, where its machine answers. */
const remoteSeats = (hostId: string) =>
  Effect.map(Effect.promise(() => import("../term/seats-client")), ({ makeSeatsProcessClient }) => makeSeatsProcessClient(hostId));

/**
 * The handlers on the plane in the context. A test gives them its own plane;
 * the core gives them its one plane (`TermHandlers`).
 */
export const TermPlaneHandlers = TermRpcs.toLayer(
  Effect.gen(function* () {
    const plane = yield* TermIpcPlane;
    const model = yield* ModelService;
    return {
      TermIsLocalHost: ({ hostId }) => Effect.sync(() => plane.router.isLocalHostId(hostId)),
      TermThisMachine: () => Effect.sync(() => plane.router.thisMachineName()),
      TermList: ({ hostId }) =>
        routed(() => (hostId === "*" || hostId === "all" ? plane.router.listAll() : plane.router.list(hostId))),
      TermReadDirectory: ({ hostId, path }) => routed(() => plane.router.readDirectory(hostId, path)),
      TermSeatNode: ({ canvas, id }) =>
        answered(
          Effect.map(model.canvas(canvas), (opened) => {
            const node = opened.nodes.get(id);
            return node?.kind === "agent" || node?.kind === "terminal" ? node : undefined;
          }),
        ),
      TermSeatLaunchState: ({ canvas, node }) => answered(seatLaunchState(canvas, node)),
      TermRemoteSeatLaunch: ({ node }) =>
        Effect.map(routed(() => remoteSeatLaunchOf(node)), (launch) =>
          launch === undefined ? undefined : cardSeatLaunch(launch, Date.now()),
        ),
      // The plane is the one this core bound (core.ts), never a second copy.
      TermStartSeat: ({ canvas, seatId }) =>
        answered(
          Effect.gen(function* () {
            const { startSeat } = yield* Effect.promise(() => import("../term/seat-control"));
            return yield* startSeat({ canvas: asCanvasName(canvas), seatId }, { plane });
          }),
        ),
      TermStopSeat: ({ canvas, seatId }) =>
        answered(
          Effect.gen(function* () {
            const { stopSeat } = yield* Effect.promise(() => import("../term/seat-control"));
            yield* stopSeat({ canvas: asCanvasName(canvas), seatId }, { plane });
          }),
        ),
      TermStartTerminal: ({ canvas, node }) =>
        answered(
          Effect.gen(function* () {
            const createAdmission = plane.nodeDelete.admitCreate(node.bindingId, node.host);
            const assertCurrent = Effect.gen(function* () {
              plane.nodeDelete.assertCreate(createAdmission);
              const current = (yield* model.canvas(canvas)).nodes.get(node.id);
              plane.nodeDelete.assertCreate(createAdmission);
              if (current?.kind !== node.kind || current.bindingId !== node.bindingId || current.host !== node.host)
                return yield* new TermRefused({ message: "terminal ipc: seat changed while starting" });
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
        ),
      // Both trusted stop commands use the same owned-session router stop; a
      // seat on another machine is stopped over the seats channel, typed.
      TermStopBinding: ({ bindingId, hostId }) =>
        hostId !== undefined && !plane.router.isLocalHostId(hostId)
          ? Effect.flatMap(remoteSeats(hostId), (seats) => routed(() => seats.stop(bindingId, crypto.randomUUID())))
          : routed(() => plane.router.kill(bindingId, hostId)),
      TermGet: ({ bindingId, hostId }) =>
        hostId !== undefined && !plane.router.isLocalHostId(hostId)
          ? Effect.flatMap(remoteSeats(hostId), (seats) => routed(() => seats.get(bindingId)))
          : routed(() => plane.router.get(bindingId, hostId)),
      TermBeginNodeDelete: ({ resources }) => routed(() => plane.nodeDelete.beginNodeDelete(resources)),
      TermFinishNodeDelete: ({ leaseId, outcome }) =>
        Effect.try({ try: () => plane.nodeDelete.finishNodeDelete(leaseId, outcome), catch: refusal }),
      TermAttach: ({ input }) =>
        Effect.gen(function* () {
          const hostId = input.hostId?.trim() || plane.router.thisMachineName();
          return { hostId, result: yield* routed(() => plane.router.attach({ ...input, hostId })) };
        }),
      TermRelease: ({ lease, hostId }) => routed(() => plane.router.release(lease, hostId)),
      TermSurfaceClose: ({ lease }) => Effect.sync(() => plane.host.closeSurface(lease)),
      TermWrite: ({ lease, data, hostId }) =>
        Effect.tap(routed(() => plane.router.write(lease, data, hostId)), (ok) =>
          // Input-origin tagging: user keystrokes must suppress injection.
          Effect.sync(() => {
            if (ok) injectionSupervisor.noteUserInput(lease.bindingId, undefined, data);
          }),
        ),
      TermResize: ({ lease, cols, rows, hostId }) => routed(() => plane.router.resize(lease, cols, rows, hostId)),
      TermHarnessModels: ({ harness }) =>
        answered(
          Effect.gen(function* () {
            const { HarnessInventory } = yield* Effect.promise(() => import("../term/templates/harness-inventory"));
            return yield* Effect.flatMap(HarnessInventory, (inventory) => inventory.models(harness));
          }),
        ),
      TermMachineInventory: ({ machine }) =>
        answered(
          Effect.gen(function* () {
            const { HarnessInventory } = yield* Effect.promise(() => import("../term/templates/harness-inventory"));
            const { PeerInventory } = yield* Effect.promise(() => import("../inventory/client"));
            const inventory = yield* HarnessInventory;
            const own = yield* (yield* MachineRepository).machineName.pipe(Effect.orElseSucceed(() => undefined));
            if (own === undefined || own === machine) return { ok: true, inventory: yield* inventory.machine } satisfies MachineInventoryResult;
            // A linked machine answers over the link's inventory channel.
            return yield* (yield* PeerInventory).inventoryOf(machine);
          }).pipe(
            Effect.catchTag("InventoryUnavailableError", (error) =>
              Effect.succeed<MachineInventoryResult>({
                ok: false,
                error: { _tag: error._tag, machine: error.machine || machine, reason: error.reason, message: error.message },
              }),
            ),
          ),
        ),
      TermNativeSettingsRead: ({ machine, harness, keys }) =>
        answered(
          Effect.gen(function* () {
            const { nativeConfigClient } = yield* Effect.promise(() => import("../inventory/native-client"));
            return yield* Effect.flatMap(nativeConfigClient, (client) => client.readSettings({ machine, harness, keys }));
          }),
        ),
      TermNativeSettingWrite: ({ machine, harness, key, value }) =>
        answered(
          Effect.gen(function* () {
            const { nativeConfigClient } = yield* Effect.promise(() => import("../inventory/native-client"));
            return yield* Effect.flatMap(nativeConfigClient, (client) => client.writeSetting({ machine, harness, key, value }));
          }),
        ),
    };
  }),
);

/** The handlers on this core's one plane: the Layer the core's server provides (src/core/link.ts). */
export const TermHandlers = TermPlaneHandlers.pipe(Layer.provide(TermIpcPlane.live));
