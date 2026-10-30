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
 *
 * A core can start again under a live window, and a new core has no holds, so
 * main remembers what each window last said and sends it again (`replay`). What
 * a window said is a report, not a hold: whether the seat is held is the core's
 * answer, from the reports it holds.
 */
import type { IpcMain, WebContents } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import type { OperatorHoldReports } from "./operator-holds";

const BINDINGS_MAX = 1_024;
const isBindingId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** What main keeps of the window's reports: the last list each window sent. */
export type OperatorHoldWindows = {
  /** Every window's last report, sent again: a new core starts with no holds. */
  readonly replay: () => Promise<void>;
};

/** Window reports into the core's live holds; each window is watched for close and reload from its first report. */
export const registerOperatorHoldsIpc = (
  ipc: Pick<IpcMain, "handle">,
  holds: OperatorHoldReports,
  /** Whether a drop is still worth sending: false once authorial admission has closed, when the core is going away. */
  admitting: () => boolean = () => true,
): OperatorHoldWindows => {
  const watched = new Set<number>();
  const showing = new Map<number, ReadonlyArray<string>>();
  // A drop nobody awaits: the holds die with the core, so a refusal is the
  // answer, not a fault. At quit admission is closed and nothing is sent at all.
  const drop = (windowId: number): void => {
    if (!admitting()) return;
    void Promise.resolve(holds.dropWindow(windowId)).catch(() => undefined);
  };
  const watch = (sender: WebContents): number => {
    const id = sender.id;
    if (watched.has(id)) return id;
    watched.add(id);
    sender.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) {
        showing.delete(id);
        drop(id);
      }
    });
    sender.on("render-process-gone", () => {
      showing.delete(id);
      drop(id);
    });
    sender.once("destroyed", () => {
      showing.delete(id);
      drop(id);
      watched.delete(id);
    });
    return id;
  };

  ipc.handle(IPC_CHANNELS.seatSurfacesOpen, async (event, bindingIds: unknown) => {
    if (!Array.isArray(bindingIds) || bindingIds.length > BINDINGS_MAX) return;
    const id = watch(event.sender);
    const ids = bindingIds.filter(isBindingId);
    showing.set(id, ids);
    await holds.surfaces(id, ids);
  });
  ipc.handle(IPC_CHANNELS.seatOperatorTyped, async (event, bindingId: unknown) => {
    if (!isBindingId(bindingId)) return;
    await holds.typed(watch(event.sender), bindingId);
  });
  return {
    replay: async () => {
      for (const [windowId, bindingIds] of showing) await holds.surfaces(windowId, bindingIds);
    },
  };
};
