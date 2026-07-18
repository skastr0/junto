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
  /**
   * Bumps when the operator marks the pane seen (open terminal). Concurrent
   * refreshHerdrMeta started before the bump must not clobber idle with a
   * stale host "done" (VL-030).
   */
  readonly seenGen?: number;
  /**
   * True from local mark-seen until the host confirms a non-done status
   * (idle|working|blocked). While set, remote "done" cannot re-paint attention
   * — closes the post-open race where a refresh *starts after* open and would
   * otherwise pass the mid-flight seenGen gate (VL-030 residual).
   */
  readonly pendingSeen?: boolean;
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

/** Drop open-path pendingSeen so host truth can reconverge after the look ends. */
const releasePendingSeen = (nodeId: string): void => {
  const cache = herdr$.metaByNodeId[nodeId].peek();
  if (!cache?.pendingSeen) return;
  herdr$.metaByNodeId[nodeId].set({ ...cache, pendingSeen: false, fetchedAt: Date.now() });
};

export const openHerdrWizard = (anchor: { readonly x: number; readonly y: number }): void => {
  // One interactive surface at a time — null terminal UI immediately, release stream async.
  const open = herdr$.terminal.peek();
  if (open?.streamId) {
    const api = getVellumApi() as
      | (ReturnType<typeof getVellumApi> & { herdrStreamClose?: (id: string) => Promise<unknown> })
      | undefined;
    void api?.herdrStreamClose?.(open.streamId);
  }
  if (open?.nodeId) releasePendingSeen(open.nodeId);
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
  markHerdrPaneSeenLocal(nodeId, herdr);
  void markHerdrPaneSeenRemote(herdr, nodeId);
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
  // Drop the open-path latch: if host still says done (focus failed), the card
  // must re-converge to host truth after close instead of staying quiet forever.
  releasePendingSeen(terminal.nodeId);
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
  const prev = herdr$.connectionByNodeId[nodeId].peek()!;
  const next = reduceHerdrConnection(prev, event);
  // Skip legend set when reduce returned the same reference (no transition).
  if (next !== prev) {
    herdr$.connectionByNodeId[nodeId].set(next);
  }
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

/** Card-level refresh hooks — fanned out from the single IPC subscription so
 * N herdr cards do not each call ipcRenderer.on (MaxListenersExceededWarning). */
const mirrorChangeListeners = new Set<(event: HerdrMirrorEvent) => void>();

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
    for (const listener of mirrorChangeListeners) {
      try {
        listener(event);
      } catch {
        // card listeners must not break the shared bus
      }
    }
  });
  mirrorUnsub = () => {
    unsubscribe();
    mirrorUnsub = undefined;
  };
  return mirrorUnsub;
};

/** Subscribe to mirror push events without an extra ipcRenderer listener. */
export const onHerdrMirrorChange = (listener: (event: HerdrMirrorEvent) => void): (() => void) => {
  subscribeHerdrMirror();
  mirrorChangeListeners.add(listener);
  return () => {
    mirrorChangeListeners.delete(listener);
  };
};

const CONFIRMED_AFTER_SEEN = new Set(["idle", "working", "blocked"]);

/**
 * Merge remote pane meta onto local cache.
 * Pure so unit tests can lock races without React.
 *
 * Holds:
 * - mid-flight seenGen race: refresh started before open cannot re-paint done
 * - pendingSeen: refresh started *after* open also cannot re-paint done until
 *   the host confirms idle|working|blocked
 * - sticky identity: remote omitting agentStatus/agent/cwd does not wipe a
 *   known prior value (avoids unknown-flash on partial mirror rows)
 */
export const mergeHerdrMetaAfterRefresh = (
  previous: HerdrMetaCache | undefined,
  startSeenGen: number,
  remote: HerdrPaneInfo,
): HerdrPaneInfo => {
  const nowGen = previous?.seenGen ?? 0;
  const prior = previous?.meta;

  // Sticky: fill holes. Explicit remote "unknown" does NOT clobber a stronger
  // prior (idle|working|blocked|done) — host blips of unknown were flashing the
  // activity mark green↔steel on quiet cards (Amp/nodeavatar thrash).
  const priorStatus = prior?.agentStatus;
  const remoteStatus = remote.agentStatus;
  const stronger =
    priorStatus === "idle" ||
    priorStatus === "working" ||
    priorStatus === "blocked" ||
    priorStatus === "done";
  let agentStatus =
    remoteStatus === undefined
      ? priorStatus
      : remoteStatus === "unknown" && stronger
        ? priorStatus
        : remoteStatus;
  const agent = remote.agent ?? prior?.agent;
  const cwd = remote.cwd ?? prior?.cwd;
  const label = remote.label ?? prior?.label;
  const workspaceLabel = remote.workspaceLabel ?? prior?.workspaceLabel;
  const tabLabel = remote.tabLabel ?? prior?.tabLabel;

  const midFlightDoneClobber =
    nowGen > startSeenGen && prior?.agentStatus === "idle" && remote.agentStatus === "done";
  // pendingSeen + remote done:
  // - prior idle/unknown → force idle (protect open race)
  // - prior working|blocked → keep prior (do not demote live work, do not accept done)
  if (remote.agentStatus === "done" && previous?.pendingSeen === true) {
    if (prior?.agentStatus === "working" || prior?.agentStatus === "blocked") {
      agentStatus = prior.agentStatus;
    } else {
      agentStatus = "idle";
    }
  } else if (midFlightDoneClobber) {
    agentStatus = "idle";
  }

  // Sticky preview: mirror meta has no preview; don't wipe an exec-path line.
  const preview = remote.preview ?? prior?.preview;
  // Sticky focus: remote omitting focused (partial rows / exec holes) must not
  // clear a known prior — that flipped inspector FOCUSED yes|no on every poll.
  const focused = remote.focused !== undefined ? remote.focused : prior?.focused;

  return {
    ...remote,
    ...(agent !== undefined ? { agent } : {}),
    ...(agentStatus !== undefined ? { agentStatus } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(workspaceLabel !== undefined ? { workspaceLabel } : {}),
    ...(tabLabel !== undefined ? { tabLabel } : {}),
    ...(preview !== undefined ? { preview } : {}),
    ...(focused !== undefined ? { focused } : {}),
  };
};

/** Whether pendingSeen should clear given a host-reported status. */
export const clearsPendingSeen = (agentStatus: string | undefined): boolean =>
  agentStatus !== undefined && CONFIRMED_AFTER_SEEN.has(agentStatus);

/**
 * pendingSeen latch across a refresh: clear only when *remote* reports
 * idle|working|blocked. Client-forced/sticky idle must not drop the gate.
 */
export const nextPendingSeen = (
  previousPending: boolean | undefined,
  remoteAgentStatus: string | undefined,
): boolean | undefined => {
  if (!previousPending) return previousPending;
  return clearsPendingSeen(remoteAgentStatus) ? false : true;
};

/** True when two pane metas paint the same card identity/status (skip re-set thrash). */
export const herdrMetaPaintEqual = (
  a: HerdrPaneInfo | undefined,
  b: HerdrPaneInfo | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.paneId === b.paneId &&
    a.agentStatus === b.agentStatus &&
    a.agent === b.agent &&
    a.cwd === b.cwd &&
    a.focused === b.focused &&
    a.workspaceLabel === b.workspaceLabel &&
    a.tabLabel === b.tabLabel &&
    a.preview === b.preview &&
    a.terminalId === b.terminalId
  );
};

/**
 * Optimistic done → idle when the operator opens a terminal (looks at the pane).
 * Herdr's agent_status is (state, seen): Idle+!seen = "done", Idle+seen = "idle".
 * Seeds idle + pendingSeen even when meta has not hydrated yet.
 */
export const markHerdrPaneSeenLocal = (nodeId: string, herdr?: EtherHerdr): void => {
  const cache = herdr$.metaByNodeId[nodeId].peek();
  const meta = cache?.meta;
  const seenGen = (cache?.seenGen ?? 0) + 1;
  const now = Date.now();

  if (!meta) {
    // Seed a minimal idle row so the card cannot first-paint as done after open.
    const seeded: HerdrPaneInfo | undefined = herdr?.paneId
      ? {
          paneId: herdr.paneId,
          terminalId: herdr.terminalId,
          workspaceId: herdr.workspaceId,
          tabId: herdr.tabId,
          agent: herdr.label,
          agentStatus: "idle",
        }
      : undefined;
    herdr$.metaByNodeId[nodeId].set({
      status: seeded ? "ok" : (cache?.status ?? "idle"),
      meta: seeded,
      error: cache?.error,
      fetchedAt: now,
      seenGen,
      pendingSeen: true,
    });
    return;
  }

  herdr$.metaByNodeId[nodeId].set({
    status: cache.status === "loading" ? "ok" : cache.status,
    meta: { ...meta, agentStatus: meta.agentStatus === "working" || meta.agentStatus === "blocked" ? meta.agentStatus : "idle" },
    error: cache.error,
    fetchedAt: now,
    seenGen,
    pendingSeen: true,
  });
};

/** Apply host-confirmed agentStatus after mark-seen (agent focus). */
export const applyHerdrPaneSeenStatus = (
  nodeId: string,
  agentStatus: string | undefined,
): void => {
  if (!agentStatus) return;
  const cache = herdr$.metaByNodeId[nodeId].peek();
  const meta = cache?.meta;
  if (!meta) return;
  // While pendingSeen, refuse host "done" — focus can race before seen sticks.
  const nextStatus =
    cache.pendingSeen && agentStatus === "done" ? "idle" : agentStatus;
  herdr$.metaByNodeId[nodeId].set({
    status: "ok",
    meta: { ...meta, agentStatus: nextStatus },
    error: undefined,
    fetchedAt: Date.now(),
    seenGen: (cache.seenGen ?? 0) + 1,
    // Clear only on host-reported idle|working|blocked — never on forced idle.
    pendingSeen: clearsPendingSeen(agentStatus) ? false : cache.pendingSeen,
  });
};

/** Stock `herdr agent focus <pane>` — marks seen on the host (done → idle). */
export const markHerdrPaneSeenRemote = async (
  herdr: EtherHerdr,
  nodeId?: string,
): Promise<void> => {
  if (!herdr.paneId) return;
  const api = getVellumApi() as
    | (ReturnType<typeof getVellumApi> & {
        herdrMarkPaneSeen?: (
          hostId: string,
          session: string | null | undefined,
          paneId: string,
        ) => Promise<{
          ok: boolean;
          data?: { agentStatus?: string; paneId?: string };
          message?: string;
        }>;
      })
    | undefined;
  if (!api?.herdrMarkPaneSeen) return;
  try {
    const res = await api.herdrMarkPaneSeen(herdr.host, herdr.session ?? null, herdr.paneId);
    if (res.ok && res.data?.agentStatus && nodeId) {
      applyHerdrPaneSeenStatus(nodeId, res.data.agentStatus);
    }
  } catch {
    // Best-effort: mirror push (real wire) / next meta poll will reconverge.
  }
};

/** Coalesce concurrent refreshHerdrMeta for the same node (last-writer thrash). */
type MetaRefreshSlot = {
  rerun: boolean;
  herdr: EtherHerdr;
  promise: Promise<void>;
};
const metaRefreshInFlight = new Map<string, MetaRefreshSlot>();

/**
 * Register the in-flight slot BEFORE starting the async loop. Starting first
 * then Map.set left a zombie: the async body ran sync until await, saw no
 * slot, returned, then set installed a resolved promise — every later refresh
 * hit existing and never called refreshHerdrMetaOnce again (swarm residual).
 */
export const refreshHerdrMeta = async (
  nodeId: string,
  herdr: EtherHerdr,
): Promise<void> => {
  const existing = metaRefreshInFlight.get(nodeId);
  if (existing) {
    existing.rerun = true;
    existing.herdr = herdr; // rebind: loop must use latest host/pane/session
    return existing.promise;
  }

  const slot: MetaRefreshSlot = {
    rerun: false,
    herdr,
    // filled immediately below so concurrent callers can await the same work
    promise: Promise.resolve(),
  };
  metaRefreshInFlight.set(nodeId, slot);
  slot.promise = (async () => {
    try {
      do {
        slot.rerun = false;
        await refreshHerdrMetaOnce(nodeId, slot.herdr);
      } while (slot.rerun);
    } finally {
      metaRefreshInFlight.delete(nodeId);
    }
  })();
  return slot.promise;
};

const refreshHerdrMetaOnce = async (
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
  const startSeenGen = previous?.seenGen ?? 0;
  // Stale-while-revalidate: keep status "ok" with prior meta so cards do not
  // flash the cyan loading wave on every mirror change (fleet-wide thrash).
  // Only the first fetch (no meta yet) uses "loading".
  if (!previous?.meta) {
    herdr$.metaByNodeId[nodeId].set({
      status: "loading",
      meta: previous?.meta,
      seenGen: previous?.seenGen,
      pendingSeen: previous?.pendingSeen,
    });
  }
  try {
    const result = await api.herdrGetMeta(herdr.host, herdr.session ?? null, herdr.paneId);
    const latest = herdr$.metaByNodeId[nodeId].peek();
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
        meta: latest?.meta ?? previous?.meta,
        fetchedAt: Date.now(),
        seenGen: latest?.seenGen ?? previous?.seenGen,
        pendingSeen: latest?.pendingSeen ?? previous?.pendingSeen,
      });
      return;
    }
    setConnectionEvent(nodeId, { type: "ok" });
    const merged = mergeHerdrMetaAfterRefresh(latest, startSeenGen, result.data);
    // Clear pendingSeen only on host-reported idle|working|blocked — never on
    // client-forced or sticky-filled idle (would drop the gate after one protect
    // cycle and re-paint remote done on the next refresh).
    const nextPending = nextPendingSeen(
      latest?.pendingSeen ?? previous?.pendingSeen,
      result.data.agentStatus,
    );
    // Skip observable set when paint-relevant fields are unchanged — fleet
    // mirror change storms must not re-render every card every tick.
    if (
      latest?.status === "ok" &&
      herdrMetaPaintEqual(latest.meta, merged) &&
      (latest.pendingSeen ?? false) === (nextPending ?? false)
    ) {
      return;
    }
    herdr$.metaByNodeId[nodeId].set({
      status: "ok",
      meta: merged,
      fetchedAt: Date.now(),
      seenGen: latest?.seenGen ?? previous?.seenGen,
      pendingSeen: nextPending,
    });
  } catch (error) {
    setConnectionEvent(nodeId, { type: "host_unreachable" });
    const latest = herdr$.metaByNodeId[nodeId].peek();
    herdr$.metaByNodeId[nodeId].set({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      meta: latest?.meta ?? previous?.meta,
      fetchedAt: Date.now(),
      seenGen: latest?.seenGen ?? previous?.seenGen,
      pendingSeen: latest?.pendingSeen ?? previous?.pendingSeen,
    });
  }
};
