/**
 * The operator's holds on seats, kept in main so the cut at the cache window
 * can ask. A seat is held while any window shows its terminal, and for
 * OPERATOR_TYPING_GRACE_MS after the operator's last key into it.
 *
 * Holds are kept per window and per binding. A window says which bindings it
 * shows as a whole list each time it changes, so a missed message heals at the
 * next one. A window that closes, crashes or reloads drops every hold it had,
 * typing included.
 */
import type { IpcMain, WebContents } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { OPERATOR_TYPING_GRACE_MS } from "@shared/operator-hold";

type WindowHolds = {
  open: ReadonlySet<string>;
  readonly typedAt: Map<string, number>;
};

export type OperatorHolds = {
  /** The bindings one window shows now, replacing what it said before. */
  readonly surfaces: (windowId: number, bindingIds: ReadonlyArray<string>) => void;
  /** The operator typed into a binding's terminal in one window. */
  readonly typed: (windowId: number, bindingId: string) => void;
  /** The window closed or reloaded: every hold it had goes. */
  readonly dropWindow: (windowId: number) => void;
  /** Whether the operator holds the seat at `now`. Reads only. */
  readonly holds: (bindingId: string, now: number) => boolean;
};

export const makeOperatorHolds = (clock: () => number = Date.now): OperatorHolds => {
  const windows = new Map<number, WindowHolds>();
  const windowOf = (windowId: number): WindowHolds => {
    let held = windows.get(windowId);
    if (held === undefined) {
      held = { open: new Set(), typedAt: new Map() };
      windows.set(windowId, held);
    }
    return held;
  };
  return {
    surfaces: (windowId, bindingIds) => {
      windowOf(windowId).open = new Set(bindingIds);
    },
    typed: (windowId, bindingId) => {
      windowOf(windowId).typedAt.set(bindingId, clock());
    },
    dropWindow: (windowId) => {
      windows.delete(windowId);
    },
    holds: (bindingId, now) => {
      for (const held of windows.values()) {
        if (held.open.has(bindingId)) return true;
        const at = held.typedAt.get(bindingId);
        if (at !== undefined && now - at < OPERATOR_TYPING_GRACE_MS) return true;
      }
      return false;
    },
  };
};

const live = makeOperatorHolds();

/**
 * Whether the operator is viewing or has just typed into the seat on this
 * binding. The cut at the cache window leaves a held seat's session alone.
 */
export const operatorHolds = (bindingId: string, now: number): boolean => live.holds(bindingId, now);

const BINDINGS_MAX = 1_024;
const isBindingId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** Window reports into the live holds; each window is watched for close and reload from its first report. */
export const registerOperatorHoldsIpc = (ipc: Pick<IpcMain, "handle">, holds: OperatorHolds = live): void => {
  const watched = new Set<number>();
  const watch = (sender: WebContents): number => {
    const id = sender.id;
    if (watched.has(id)) return id;
    watched.add(id);
    sender.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) holds.dropWindow(id);
    });
    sender.on("render-process-gone", () => holds.dropWindow(id));
    sender.once("destroyed", () => {
      holds.dropWindow(id);
      watched.delete(id);
    });
    return id;
  };

  ipc.handle(IPC_CHANNELS.seatSurfacesOpen, (event, bindingIds: unknown) => {
    if (!Array.isArray(bindingIds) || bindingIds.length > BINDINGS_MAX) return;
    holds.surfaces(watch(event.sender), bindingIds.filter(isBindingId));
  });
  ipc.handle(IPC_CHANNELS.seatOperatorTyped, (event, bindingId: unknown) => {
    if (isBindingId(bindingId)) holds.typed(watch(event.sender), bindingId);
  });
};
