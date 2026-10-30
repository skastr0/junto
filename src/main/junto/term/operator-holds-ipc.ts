/**
 * The window's two reports into the operator's holds: which terminals it shows,
 * and when the operator typed into one.
 *
 * The holds themselves live in the core (`operator-holds.ts`), where every
 * reader is: the cache cut that leaves a held seat's session alone, the clock a
 * key warms, and the Hold frames a peer's view carries to the machine that runs
 * the seat. Main keeps none of it; it watches each window from its first report
 * and sends every change on. Before 0.11.7 this file held the map in main, so a
 * seat the operator was watching was never held where the cut asks.
 */
import type { IpcMain, WebContents } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import type { OperatorHoldReports } from "../../core-process/ops/seat-holds";

const BINDINGS_MAX = 1_024;
const isBindingId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** Window reports into the core's live holds; each window is watched for close and reload from its first report. */
export const registerOperatorHoldsIpc = (
  ipc: Pick<IpcMain, "handle">,
  holds: OperatorHoldReports,
): void => {
  const watched = new Set<number>();
  const watch = (sender: WebContents): number => {
    const id = sender.id;
    if (watched.has(id)) return id;
    watched.add(id);
    sender.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) void holds.dropWindow(id);
    });
    sender.on("render-process-gone", () => void holds.dropWindow(id));
    sender.once("destroyed", () => {
      void holds.dropWindow(id);
      watched.delete(id);
    });
    return id;
  };

  ipc.handle(IPC_CHANNELS.seatSurfacesOpen, (event, bindingIds: unknown) => {
    if (!Array.isArray(bindingIds) || bindingIds.length > BINDINGS_MAX) return;
    return holds.surfaces(watch(event.sender), bindingIds.filter(isBindingId));
  });
  ipc.handle(IPC_CHANNELS.seatOperatorTyped, (event, bindingId: unknown) => {
    if (isBindingId(bindingId)) return holds.typed(watch(event.sender), bindingId);
    return undefined;
  });
};
