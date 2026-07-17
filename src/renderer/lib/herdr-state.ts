import { observable } from "@legendapp/state";
import type { EtherHerdr, EtherRegionHerdrDefaults } from "@shared/canvas";
import {
  initialHerdrConnection,
  reduceHerdrConnection,
  shouldAutoReconnect,
  type HerdrConnectionMachine,
  type HerdrConnectionState,
} from "@shared/herdr";
import { resolveHerdrSpawnDefaults } from "@shared/region-defaults";
import type { HerdrMirrorEvent, HerdrMirrorStateInfo, HerdrPaneInfo } from "@shared/ipc";
import { state$ } from "./state";
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

/** Per-host mirror freshness (Phase B/D1) — push-fed by onHerdrMirrorEvent. */
export interface HerdrMirrorFresh {
  readonly fresh: boolean;
  readonly lastSyncAt?: number;
}

export const herdr$ = observable({
  wizardOpen: false,
  wizardAnchor: { x: 0, y: 0 } as { readonly x: number; readonly y: number },
  /** Create-time seed from containing region defaults (stamp only; not live). */
  wizardSeed: null as EtherRegionHerdrDefaults | null,
  /**
   * Bumps on every open/close so in-flight pick/create awaits cannot place a
   * node or stomp React state after cancel or after a later reopen.
   */
  wizardEpoch: 0,
  terminal: null as HerdrTerminalOpen | null,
  /** nodeId → meta hydration */
  metaByNodeId: {} as Record<string, HerdrMetaCache>,
  /** nodeId → connection machine */
  connectionByNodeId: {} as Record<string, HerdrConnectionMachine>,
  /** hostId → mirror freshness. Fresh host → cards run push-driven, no polling. */
  mirrorByHost: {} as Record<string, HerdrMirrorFresh>,
  toast: "" as string,
});

// Default herdr card size — seed resolves against the card center so membership
// matches geometry.containedNodeIds (center-in-region).
const HERDR_NODE_SIZE = { width: 260, height: 110 } as const;

/** True while this wizard session is still the active one. */
export const isHerdrWizardEpochCurrent = (epoch: number): boolean =>
  herdr$.wizardOpen.peek() && herdr$.wizardEpoch.peek() === epoch;

export const openHerdrWizard = (anchor: { readonly x: number; readonly y: number }): void => {
  // One interactive surface at a time — null terminal UI immediately, release stream async.
  const open = herdr$.terminal.peek();
  if (open?.streamId) {
    const api = getVellumApi() as
      | (ReturnType<typeof getVellumApi> & { herdrStreamClose?: (id: string) => Promise<unknown> })
      | undefined;
    void api?.herdrStreamClose?.(open.streamId);
  }
  herdr$.terminal.set(null);
  herdr$.wizardAnchor.set(anchor);
  const cx = anchor.x + HERDR_NODE_SIZE.width / 2;
  const cy = anchor.y + HERDR_NODE_SIZE.height / 2;
  const seed = resolveHerdrSpawnDefaults(state$.doc.peek(), cx, cy) ?? null;
  herdr$.wizardSeed.set(seed);
  herdr$.wizardEpoch.set(herdr$.wizardEpoch.peek() + 1);
  herdr$.wizardOpen.set(true);
};

export const closeHerdrWizard = (): void => {
  herdr$.wizardOpen.set(false);
  herdr$.wizardSeed.set(null);
  herdr$.wizardEpoch.set(herdr$.wizardEpoch.peek() + 1);
};

export const openHerdrTerminal = (nodeId: string, herdr: EtherHerdr, title: string): void => {
  herdr$.wizardOpen.set(false);
  herdr$.terminal.set({ nodeId, herdr, title });
  ensureConnection(nodeId);
  setConnectionEvent(nodeId, { type: "ok" });
  // Opening the terminal is "looking at" the pane. Optimistically clear herdr's
  // done (Idle+!seen) → idle so the card stops waving before the focus round-trip.
  // Then mark seen on the host so the mirror event confirms it for the fleet.
  markHerdrPaneSeenLocal(nodeId);
  void markHerdrPaneSeenRemote(herdr);
};

/**
 * Close the terminal modal immediately (UI first).
 * Stream detach is fire-and-forget — never block the UI on a stuck herdr child.
 */
export const closeHerdrTerminal = (): void => {
  const terminal = herdr$.terminal.peek();
  if (!terminal) return;
  const streamId = terminal.streamId;
  // UI first — operator must never be trapped in the modal.
  herdr$.terminal.set(null);
  if (!streamId) return;
  const api = getVellumApi() as
    | (ReturnType<typeof getVellumApi> & {
        herdrStreamClose?: (streamId: string) => Promise<unknown>;
      })
    | undefined;
  void api?.herdrStreamClose?.(streamId).catch(() => undefined);
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

type HerdrMirrorApi = ReturnType<typeof getVellumApi> & {
  herdrMirrorState?: () => Promise<ReadonlyArray<HerdrMirrorStateInfo>>;
  onHerdrMirrorEvent?: (listener: (event: HerdrMirrorEvent) => void) => () => void;
};

let mirrorUnsub: (() => void) | undefined;

/**
 * One app-wide subscription feeding herdr$.mirrorByHost. Idempotent — every
 * card mount may call it; only the first attaches (browser-state precedent).
 * Absent the bridge (IPC not landed) it degrades to a retryable no-op.
 */
export const subscribeHerdrMirror = (): (() => void) => {
  if (mirrorUnsub) return mirrorUnsub;
  const api = getVellumApi() as HerdrMirrorApi | undefined;
  if (!api?.onHerdrMirrorEvent) return () => undefined;
  if (api.herdrMirrorState) {
    void api
      .herdrMirrorState()
      .then((states) => {
        for (const s of states) {
          herdr$.mirrorByHost[s.hostId].set({ fresh: s.fresh, lastSyncAt: s.lastSyncAt });
        }
      })
      .catch(() => undefined);
  }
  const unsubscribe = api.onHerdrMirrorEvent((event) => {
    herdr$.mirrorByHost[event.hostId].set({ fresh: event.fresh, lastSyncAt: Date.now() });
  });
  mirrorUnsub = () => {
    unsubscribe();
    mirrorUnsub = undefined;
  };
  return mirrorUnsub;
};

/**
 * Optimistic done → idle when the operator opens a terminal (looks at the pane).
 * Herdr's agent_status is (state, seen): Idle+!seen = "done", Idle+seen = "idle".
 */
export const markHerdrPaneSeenLocal = (nodeId: string): void => {
  const cache = herdr$.metaByNodeId[nodeId].peek();
  const meta = cache?.meta;
  if (!meta || meta.agentStatus !== "done") return;
  herdr$.metaByNodeId[nodeId].set({
    status: cache.status === "loading" ? "ok" : cache.status,
    meta: { ...meta, agentStatus: "idle" },
    error: cache.error,
    fetchedAt: Date.now(),
  });
};

/** Stock `herdr agent focus <pane>` — marks seen on the host (done → idle). */
export const markHerdrPaneSeenRemote = async (herdr: EtherHerdr): Promise<void> => {
  if (!herdr.paneId) return;
  const api = getVellumApi() as
    | (ReturnType<typeof getVellumApi> & {
        herdrMarkPaneSeen?: (
          hostId: string,
          session: string | null | undefined,
          paneId: string,
        ) => Promise<{ ok: boolean; data?: { agentStatus?: string }; message?: string }>;
      })
    | undefined;
  if (!api?.herdrMarkPaneSeen) return;
  try {
    await api.herdrMarkPaneSeen(herdr.host, herdr.session ?? null, herdr.paneId);
  } catch {
    // Best-effort: mirror push / next meta poll will reconverge.
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
  const previous = herdr$.metaByNodeId[nodeId].peek();
  // Stale-while-revalidate: keep status "ok" with prior meta so cards do not
  // flash the cyan loading wave on every mirror change (fleet-wide thrash).
  // Only the first fetch (no meta yet) uses "loading".
  if (!previous?.meta) {
    herdr$.metaByNodeId[nodeId].set({
      status: "loading",
      meta: previous?.meta,
    });
  }
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
        meta: previous?.meta,
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
      meta: previous?.meta,
      fetchedAt: Date.now(),
    });
  }
};
