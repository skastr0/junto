import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Plus, RefreshCw } from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import {
  ditherPixelSize,
  type FleetDitherLevel,
} from "../../lib/fleet-layout";
import { closeFleet, refreshFleet } from "../../lib/fleet-state";
import { activateOnPointerUp } from "../../lib/pointer-activation";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import { FocusSurface } from "../FocusSurface";
import { Button, OverlayHeader } from "../ui";
import { FleetDetailPanel, type FleetSelection } from "./FleetDetailPanel";
import { FleetHostForm } from "./FleetHostForm";
import { COMMAND_CENTER_ID, FleetMap, ghostNodeId } from "./FleetMap";

type FormState = { readonly label?: string; readonly endpoint?: string } | null;
const DITHER_STORAGE_KEY = "vellum:fleet:dither-level";

const initialDitherLevel = (): FleetDitherLevel => {
  try {
    const stored = window.localStorage.getItem(DITHER_STORAGE_KEY);
    if (stored === "fine" || stored === "balanced" || stored === "coarse") return stored;
  } catch {
    // A denied storage surface should never block the Fleet.
  }
  return "fine";
};

function FleetOverlayInner() {
  const hosts = use$(state$.fleetHosts);
  const peers = use$(state$.fleetPeers);
  const loading = use$(state$.fleetLoading);
  const probes = use$(state$.fleetProbe);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [ccHostId, setCcHostId] = useState("");
  const [ditherLevel, setDitherLevel] = useState<FleetDitherLevel>(initialDitherLevel);
  const stations = hosts.filter((host) => host.kind === "remote");
  const reachable = stations.filter(
    (host) => probes[host.id]?.status === "reachable",
  ).length;
  const checking = stations.filter(
    (host) => probes[host.id]?.status === "probing",
  ).length;
  const tested = stations.filter((host) => {
    const status = probes[host.id]?.status;
    return status === "reachable" || status === "unreachable";
  }).length;
  const routeSummary =
    loading || checking > 0
      ? "scanning routes"
      : tested === 0
        ? "routes untested"
        : `${reachable}/${stations.length} reachable`;

  useEffect(() => {
    let cancelled = false;
    const api = getVellumApi();
    if (!api?.settingsGet) return;
    void api
      .settingsGet()
      .then((result) => {
        if (!cancelled && result.ok && result.settings) setCcHostId(result.settings.station.hostId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedHost = hosts.find((host) => host.id === selectedId);
  const selectedPeer =
    selectedId !== null && selectedId.startsWith("ghost:")
      ? peers.find((peer) => ghostNodeId(peer) === selectedId)
      : undefined;
  const selection: FleetSelection | null =
    selectedId === COMMAND_CENTER_ID
      ? { kind: "cc" }
      : selectedHost
        ? { kind: "station", host: selectedHost }
        : selectedPeer
          ? { kind: "ghost", peer: selectedPeer }
          : null;

  const claimPeer = (peer: DiscoveredPeer) => {
    // MagicDNS name is the preferred endpoint — stable across tailnet IPs.
    setForm({ label: peer.name, endpoint: peer.name });
  };

  const updateDitherLevel = (level: FleetDitherLevel) => {
    setDitherLevel(level);
    queueMicrotask(() => {
      try {
        window.localStorage.setItem(DITHER_STORAGE_KEY, level);
      } catch {
        // The live state remains authoritative for this session.
      }
    });
  };

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label="Fleet manager"
      panelClassName="fleet-panel"
      onClose={closeFleet}
    >
      <OverlayHeader
        eyebrow="fleet"
        title="Command Fleet"
        status={`${stations.length} enrolled · ${routeSummary}${
          peers.length > 0 ? ` · ${peers.length} discovered` : ""
        }`}
        actions={
          <>
            <Button
              size="sm"
              variant="subtle"
              disabled={loading}
              {...activateOnPointerUp(() => void refreshFleet())}
            >
              <RefreshCw
                size={12}
                className={loading ? "fleet-refresh-icon" : undefined}
              />
              Refresh
            </Button>
            <Button
              size="sm"
              {...activateOnPointerUp(() => setForm({}))}
            >
              <Plus size={12} />
              Add host
            </Button>
          </>
        }
      />
      <div className="fleet-body">
        <div className="fleet-map-wrap">
          <FleetMap
            hosts={hosts}
            peers={peers}
            probes={probes}
            ccHostId={ccHostId}
            selectedId={selectedId}
            onSelect={setSelectedId}
            ditherLevel={ditherLevel}
            onDitherLevelChange={updateDitherLevel}
          />
        </div>
        {selection ? (
          <FleetDetailPanel
            selection={selection}
            probe={selection.kind === "station" ? probes[selection.host.id] : undefined}
            ccHostId={ccHostId}
            onClose={() => setSelectedId(null)}
            onClaimPeer={claimPeer}
            ditherPixelSize={ditherPixelSize(ditherLevel)}
          />
        ) : null}
      </div>
      {form ? <FleetHostForm initialLabel={form.label} initialEndpoint={form.endpoint} onClose={() => setForm(null)} /> : null}
    </FocusSurface>
  );
}

/**
 * Fleet manager overlay. Parent mounts this only while `state$.fleetOpen`
 * is true (lazy chunk) so three.js / GLBs never load on cold start and every
 * WebGL machine unmounts on close. Defense-in-depth gate remains here.
 */
export function FleetOverlay() {
  const open = use$(state$.fleetOpen);
  if (!open) return null;
  return <FleetOverlayInner />;
}
