import { observable } from "@legendapp/state";
import type { EtherHerdr } from "@shared/canvas";
import {
  initialHerdrConnection,
  reduceHerdrConnection,
  shouldAutoReconnect,
  type HerdrConnectionMachine,
  type HerdrConnectionState,
} from "@shared/herdr";
import type { HerdrPaneInfo } from "@shared/ipc";
import { getVellumApi } from "./vellum-api";

export interface HerdrMetaCache {
  readonly status: "idle" | "loading" | "ok" | "error";
  readonly meta?: HerdrPaneInfo;
  readonly error?: string;
  readonly fetchedAt?: number;
}

export interface HerdrTerminalOpen {
  readonly nodeId: string;
  readonly herdr: EtherHerdr;
  readonly streamId?: string;
  readonly title: string;
}

export const herdr$ = observable({
  wizardOpen: false,
  wizardAnchor: { x: 0, y: 0 } as { readonly x: number; readonly y: number },
  terminal: null as HerdrTerminalOpen | null,
  /** nodeId → meta hydration */
  metaByNodeId: {} as Record<string, HerdrMetaCache>,
  /** nodeId → connection machine */
  connectionByNodeId: {} as Record<string, HerdrConnectionMachine>,
  toast: "" as string,
});

export const openHerdrWizard = (anchor: { readonly x: number; readonly y: number }): void => {
  herdr$.wizardAnchor.set(anchor);
  herdr$.wizardOpen.set(true);
};

export const closeHerdrWizard = (): void => {
  herdr$.wizardOpen.set(false);
};

export const openHerdrTerminal = (nodeId: string, herdr: EtherHerdr, title: string): void => {
  herdr$.terminal.set({ nodeId, herdr, title });
  ensureConnection(nodeId);
  setConnectionEvent(nodeId, { type: "ok" });
};

export const closeHerdrTerminal = async (): Promise<void> => {
  const terminal = herdr$.terminal.peek();
  if (!terminal) return;
  const api = getVellumApi() as
    | (ReturnType<typeof getVellumApi> & {
        herdrStreamClose?: (streamId: string) => Promise<unknown>;
      })
    | undefined;
  if (terminal.streamId && api?.herdrStreamClose) {
    try {
      await api.herdrStreamClose(terminal.streamId);
    } catch {
      // detach-friendly: closing modal never kills the pane
    }
  }
  herdr$.terminal.set(null);
};

export const setTerminalStreamId = (streamId: string | undefined): void => {
  const terminal = herdr$.terminal.peek();
  if (!terminal) return;
  herdr$.terminal.set({ ...terminal, streamId });
};

export const ensureConnection = (nodeId: string): void => {
  if (!herdr$.connectionByNodeId[nodeId].peek()) {
    herdr$.connectionByNodeId[nodeId].set(initialHerdrConnection());
  }
};

export const setConnectionEvent = (
  nodeId: string,
  event: Parameters<typeof reduceHerdrConnection>[1],
): HerdrConnectionState => {
  ensureConnection(nodeId);
  const next = reduceHerdrConnection(herdr$.connectionByNodeId[nodeId].peek()!, event);
  herdr$.connectionByNodeId[nodeId].set(next);
  return next.state;
};

export const connectionStateOf = (nodeId: string): HerdrConnectionState => {
  return herdr$.connectionByNodeId[nodeId].peek()?.state ?? "connected";
};

export const canAutoReconnect = (nodeId: string): boolean => {
  const machine = herdr$.connectionByNodeId[nodeId].peek();
  return machine ? shouldAutoReconnect(machine) : false;
};

export const setHerdrToast = (message: string): void => {
  herdr$.toast.set(message);
  if (message) {
    window.setTimeout(() => {
      if (herdr$.toast.peek() === message) herdr$.toast.set("");
    }, 4000);
  }
};

export const refreshHerdrMeta = async (
  nodeId: string,
  herdr: EtherHerdr,
): Promise<void> => {
  const api = getVellumApi() as
    | (ReturnType<typeof getVellumApi> & {
        herdrGetMeta?: (
          hostId: string,
          session: string | null | undefined,
          paneId: string,
        ) => Promise<{ ok: boolean; data?: HerdrPaneInfo; message?: string; code?: string }>;
      })
    | undefined;
  if (!api?.herdrGetMeta || !herdr.paneId) {
    herdr$.metaByNodeId[nodeId].set({ status: "error", error: "pane not bound" });
    return;
  }
  herdr$.metaByNodeId[nodeId].set({
    status: "loading",
    meta: herdr$.metaByNodeId[nodeId].peek()?.meta,
  });
  try {
    const result = await api.herdrGetMeta(herdr.host, herdr.session ?? null, herdr.paneId);
    if (!result.ok || !result.data) {
      const code = result.code ?? "";
      if (code === "unreachable" || code === "timeout") {
        setConnectionEvent(nodeId, { type: "host_unreachable" });
      } else if (code === "not_found") {
        setConnectionEvent(nodeId, { type: "pane_missing" });
      }
      herdr$.metaByNodeId[nodeId].set({
        status: "error",
        error: result.message ?? "meta failed",
        fetchedAt: Date.now(),
      });
      return;
    }
    setConnectionEvent(nodeId, { type: "ok" });
    herdr$.metaByNodeId[nodeId].set({
      status: "ok",
      meta: result.data,
      fetchedAt: Date.now(),
    });
  } catch (error) {
    setConnectionEvent(nodeId, { type: "host_unreachable" });
    herdr$.metaByNodeId[nodeId].set({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now(),
    });
  }
};
