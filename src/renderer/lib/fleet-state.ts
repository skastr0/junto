import { state$ } from "./state";
import type { LinuxHostCapabilityObservation } from "@shared/linux-host-capabilities";
import type { FleetPeerCompatibilitySnapshot } from "@shared/fleet-compatibility-snapshot";
import type {
  StationProtocolObservation,
  StationRemoteObservation,
} from "@shared/station-status";
import { FLEET_UI_ENABLED } from "@shared/features";
import { isCommandCenterFleetUi } from "./canvas-boot";

/** Per-host reachability probe state for the fleet overlay. */
export interface FleetProbeState {
  readonly status: "probing" | "reachable" | "unreachable";
  readonly latencyMs?: number;
  readonly detail?: string;
  readonly protocol?: StationProtocolObservation;
  readonly linuxCapabilities?: LinuxHostCapabilityObservation;
  readonly observation?: StationRemoteObservation;
  readonly compatibility?: FleetPeerCompatibilitySnapshot;
}

/** Warm the lazy Fleet chunk before the operator clicks. */
let fleetChunkPrefetch: Promise<unknown> | null = null;
const fleetUiOpen = (): boolean =>
  FLEET_UI_ENABLED &&
  isCommandCenterFleetUi(state$.settings.station.role.peek());

export const prefetchFleetChunk = (): void => {
  if (!__VELLUM_COMMAND_FLEET_UI_ENABLED__) return;
  if (!fleetUiOpen()) return;
  if (fleetChunkPrefetch) return;
  fleetChunkPrefetch = import("../components/fleet/FleetOverlay").catch(() => {
    fleetChunkPrefetch = null;
  });
};

export const openFleet = (): void => {
  if (!fleetUiOpen()) return;
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
  if (!window.vellumCommand?.hostsList) return;
  state$.fleetLoading.set(true);
  try {
    const hostsResult = await window.vellumCommand.hostsList();
    if (hostsResult.ok && hostsResult.hosts) {
      state$.fleetHosts.set([...hostsResult.hosts]);
    }
    const peersResult = window.vellumCommand.hostsDiscoverPeers
      ? await window.vellumCommand.hostsDiscoverPeers()
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
  if (!window.vellumCommand?.hostsTest) {
    state$.fleetProbe[id].set({
      status: "unreachable",
      detail: "hosts test API unavailable",
    });
    return;
  }
  state$.fleetProbe[id].set({ status: "probing" });
  try {
    const result = await window.vellumCommand.hostsTest(id);
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
            ...(result.protocol === undefined
              ? {}
              : { protocol: result.protocol }),
            ...(result.linuxCapabilities === undefined
              ? {}
              : { linuxCapabilities: result.linuxCapabilities }),
            ...(result.observation === undefined
              ? {}
              : { observation: result.observation }),
            ...(result.compatibility === undefined
              ? {}
              : { compatibility: result.compatibility }),
          }
        : {
            status: "unreachable",
            detail: result.detail ?? result.message ?? "probe failed",
            ...(result.protocol === undefined
              ? {}
              : { protocol: result.protocol }),
            ...(result.linuxCapabilities === undefined
              ? {}
              : { linuxCapabilities: result.linuxCapabilities }),
            ...(result.observation === undefined
              ? {}
              : { observation: result.observation }),
            ...(result.compatibility === undefined
              ? {}
              : { compatibility: result.compatibility }),
          },
    );
  } catch (error) {
    state$.fleetProbe[id].set({
      status: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
