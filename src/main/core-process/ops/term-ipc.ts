import { Effect } from "effect";
import type { MachineInventoryResult, NativeSettingsReadResult, NativeSettingWriteResult } from "@shared/ipc";
import { asCanvasName, type NodeId, type NodeOf } from "@shared/model";
import { coreOps, type CoreOp } from "../ops";
import { ModelService } from "../../junto/model/service";
import { MachineRepository } from "../../junto/machines/repository";
import { seatLaunchState } from "../../junto/term/seat-launch-state";
import type { SeatControlOptions } from "../../junto/term/seat-control";
import type { TerminalSessionSummary } from "@shared/terminal";

/**
 * The core operations `term/ipc.ts` asks for (Wave 3). Seat start and stop
 * need the terminal plane and the window's reachability step, which are
 * not data: whoever holds the plane binds them here once, main's terminal
 * IPC today and the core process when it owns the plane.
 */
let seatControl: SeatControlOptions = {};

export const bindTermIpcSeatControl = (options: SeatControlOptions): void => {
  seatControl = options;
};

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
  }
}

coreOps({
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
      return yield* startSeat({ canvas: asCanvasName(canvas), seatId }, seatControl);
    }),
  "term.stopSeat": ({ canvas, seatId }) =>
    Effect.gen(function* () {
      const { stopSeat } = yield* Effect.promise(() => import("../../junto/term/seat-control"));
      yield* stopSeat({ canvas: asCanvasName(canvas), seatId }, { ...(seatControl.plane ? { plane: seatControl.plane } : {}) });
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
