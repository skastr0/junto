/**
 * The loom seed over IPC: every part at a launch, only the changed rows when
 * the planner settles. Both handlers ask the core's loom-seed group; the rows
 * are plain data the renderer's planner owns, so main passes them through.
 */
import type { IpcMain } from "electron";
import { Context } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { LoomSeedCore } from "../../contract/core/loom-seed";
import { AppRuntime } from "../runtime";

export const registerLoomSeedIpc = (
  ipc: Pick<IpcMain, "handle">,
  core: Context.Context<LoomSeedCore>,
): void => {
  const loomSeed = Context.get(core, LoomSeedCore);
  ipc.handle(IPC_CHANNELS.loomSeedLoad, (_event, canvas: unknown) =>
    typeof canvas === "string"
      ? AppRuntime.runPromise(loomSeed.LoomSeedLoad({ canvas }))
      : Promise.resolve({ meta: null, cards: [], wires: [] }),
  );
  ipc.handle(IPC_CHANNELS.loomSeedSave, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return Promise.resolve(false);
    const { canvas, meta, cards, wires, removedCards, removedWires } = payload as Record<string, unknown>;
    if (
      typeof canvas !== "string" ||
      meta === null || typeof meta !== "object" ||
      !Array.isArray(cards) ||
      !Array.isArray(wires) ||
      !Array.isArray(removedCards) ||
      !Array.isArray(removedWires)
    ) {
      return Promise.resolve(false);
    }
    return AppRuntime.runPromise(
      loomSeed.LoomSeedSave({
        canvas,
        meta: meta as { routerVersion: number; fingerprint: number; specsKey: string; geometryKey: number },
        cards: cards as never,
        wires: wires as never,
        removedCards: removedCards as string[],
        removedWires: removedWires as string[],
      }),
    );
  });
};
