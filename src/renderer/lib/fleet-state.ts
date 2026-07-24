import { state$ } from "./state";

/** Per-host reachability probe state for the fleet overlay. */
export interface FleetProbeState {
  readonly status: "probing" | "reachable" | "unreachable";
  readonly latencyMs?: number;
  readonly detail?: string;
}

export const openFleet = (): void => {
  state$.fleetOpen.set(true);
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
    state$.fleetProbe[id].set(
      result.ok
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
