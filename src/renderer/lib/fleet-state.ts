import { state$ } from "./state";

/** Per-host reachability probe state for the fleet overlay. */
export interface FleetProbeState {
  readonly status: "probing" | "reachable" | "unreachable";
  readonly latencyMs?: number;
  readonly detail?: string;
}

/** Warm the lazy fleet chunk (three.js) before the operator clicks. */
let fleetChunkPrefetch: Promise<unknown> | null = null;
export const prefetchFleetChunk = (): void => {
  if (fleetChunkPrefetch) return;
  fleetChunkPrefetch = import("../components/fleet/FleetOverlay").catch(() => {
    fleetChunkPrefetch = null;
  });
};

export const openFleet = (): void => {
  prefetchFleetChunk();
  state$.fleetOpen.set(true);
  // Load the fleet, then probe every remote host so edges show live link
  // state on open rather than waiting for manual "Test link" clicks.
  void refreshFleet().then(() => {
    for (const host of state$.fleetHosts.peek()) {
      if (host.kind === "remote") void probeHost(host.id);
    }
  });
};

export const closeFleet = (): void => {
  state$.fleetOpen.set(false);
};

/** Reload enrolled hosts + unenrolled Tailscale peers from main. */
export const refreshFleet = async (): Promise<void> => {
  if (!window.vellum?.hostsList) return;
  state$.fleetLoading.set(true);
  try {
    const hostsResult = await window.vellum.hostsList();
    if (hostsResult.ok && hostsResult.hosts) {
      state$.fleetHosts.set([...hostsResult.hosts]);
    }
    const peersResult = window.vellum.hostsDiscoverPeers
      ? await window.vellum.hostsDiscoverPeers()
      : undefined;
    if (peersResult?.ok && peersResult.peers) {
      state$.fleetPeers.set([...peersResult.peers]);
    }
  } catch {
    // Keep last-known fleet state; loading flag still clears below.
  } finally {
    state$.fleetLoading.set(false);
  }
};

/** Probe one host's SSH reachability; records the outcome in fleetProbe. */
export const probeHost = async (id: string): Promise<void> => {
  if (!window.vellum?.hostsTest) {
    state$.fleetProbe[id].set({
      status: "unreachable",
      detail: "hosts test API unavailable",
    });
    return;
  }
  state$.fleetProbe[id].set({ status: "probing" });
  try {
    const result = await window.vellum.hostsTest(id);
    // The edge mirrors link reachability, not the strict all-checks verdict —
    // a host that answers SSH but has doctor warnings is still reachable.
    const reachable =
      result.reachability !== undefined
        ? result.reachability === "reachable"
        : result.ok;
    state$.fleetProbe[id].set(
      reachable
        ? {
            status: "reachable",
            ...(result.latencyMs === undefined
              ? {}
              : { latencyMs: result.latencyMs }),
            detail: result.detail,
          }
        : {
            status: "unreachable",
            detail: result.detail ?? result.message ?? "probe failed",
          },
    );
  } catch (error) {
    state$.fleetProbe[id].set({
      status: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
