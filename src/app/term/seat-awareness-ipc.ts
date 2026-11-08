/**
 * The window's seat-awareness reads (junto/ipc.ts). The plane runs in the
 * core, where the seats and their windows are; main asks it for the latest
 * event per binding a renderer hydrates from, and for the live gate seat
 * collaboration reads, both from the one snapshot
 * (src/contract/core/seat-awareness.ts), so the two cannot disagree. Its
 * events arrive on the push stream main forwards.
 */
import type { IpcMain } from "electron";
import { Context } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { SeatAwarenessCore } from "../../contract/core/seat-awareness";
import { AppRuntime } from "../runtime";

/** What collaboration asks of the plane: whether it runs, compiled and turned on in Settings, Experimental. */
export type SeatAwarenessGate = { readonly enabled: () => Promise<boolean> };

export const registerSeatAwarenessIpc = (
  ipc: Pick<IpcMain, "handle">,
  core: Context.Context<SeatAwarenessCore>,
): SeatAwarenessGate => {
  const awareness = Context.get(core, SeatAwarenessCore);
  const snapshot = () => AppRuntime.runPromise(awareness.SeatAwarenessSnapshot());
  ipc.handle(IPC_CHANNELS.seatAwarenessSnapshot, async () => (await snapshot()).events);
  return { enabled: async () => (await snapshot()).enabled };
};
