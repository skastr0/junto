/**
 * The loom's seed over IPC: one read at a launch, one write when the planner
 * settles. Both handlers ask the core's loom-seed group; the seed is a JSON
 * string the renderer's planner owns, so main passes it through.
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
    typeof canvas === "string" ? AppRuntime.runPromise(loomSeed.LoomSeedLoad({ canvas })) : Promise.resolve(null),
  );
  ipc.handle(IPC_CHANNELS.loomSeedSave, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return Promise.resolve(false);
    const { canvas, routerVersion, seedJson } = payload as Record<string, unknown>;
    if (typeof canvas !== "string" || typeof routerVersion !== "number" || typeof seedJson !== "string") {
      return Promise.resolve(false);
    }
    return AppRuntime.runPromise(loomSeed.LoomSeedSave({ canvas, routerVersion, seedJson }));
  });
};
