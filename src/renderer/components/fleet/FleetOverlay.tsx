import { useCallback, useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { CloudCog, Plus, RefreshCw } from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import type { HostsDeployCapabilities } from "@shared/deploy-capabilities";
import { useRunningDeployJobs } from "../../lib/deploy-job-state";
import { type FleetDitherLevel } from "../../lib/fleet-layout";
import { closeFleet, refreshFleet } from "../../lib/fleet-state";
import { activateOnPointerUp } from "../../lib/pointer-activation";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import { FocusSurface } from "../FocusSurface";
import { Button, OverlayHeader } from "../ui";
import { FleetDeployJobPanel } from "./FleetDeployJobPanel";
import { FleetDetailPanel, type FleetSelection } from "./FleetDetailPanel";
import { FleetBoxPanel } from "./FleetBoxPanel";
import { FleetHostForm } from "./FleetHostForm";
import { COMMAND_CENTER_ID, FleetMap, ghostNodeId } from "./FleetMap";

type FormState = { readonly label?: string; readonly endpoint?: string } | null;

function FleetOverlayInner() {
  const hosts = use$(state$.fleetHosts);
  const peers = use$(state$.fleetPeers);
  const loading = use$(state$.fleetLoading);
  const probes = use$(state$.fleetProbe);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [boxPanelOpen, setBoxPanelOpen] = useState(false);
  const [boxFleetEnabled, setBoxFleetEnabled] = useState(false);
  const [ccHostId, setCcHostId] = useState("");
  const ditherLevel = use$(state$.settings.fleet.ditherLevel);
  const runningDeploys = useRunningDeployJobs();
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

  useEffect(() => {
    let cancelled = false;
    const api = getVellumApi();
    if (!api?.hostsDeployCapabilities) {
      setBoxFleetEnabled(false);
      return;
    }
    void api
      .hostsDeployCapabilities()
      .then((result) => {
        if (cancelled) return;
        const caps = result as HostsDeployCapabilities | { ok: false };
        setBoxFleetEnabled(
          caps.ok === true && caps.effective.boxFleet === true,
        );
      })
      .catch(() => {
        if (!cancelled) setBoxFleetEnabled(false);
      });
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

  // Stable identity so FleetMap node `data.onSelect` does not thrash every probe tick.
  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  const claimPeer = useCallback((peer: DiscoveredPeer) => {
    // MagicDNS name is the preferred endpoint — stable across tailnet IPs.
    setForm({ label: peer.name, endpoint: peer.name });
  }, []);

  const updateDitherLevel = useCallback((level: FleetDitherLevel) => {
    void patchSettings({ fleet: { ditherLevel: level } });
  }, []);

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
            {boxFleetEnabled ? (
              <Button
                size="sm"
                variant="subtle"
                {...activateOnPointerUp(() => setBoxPanelOpen(true))}
              >
                <CloudCog size={12} />
                Box
              </Button>
            ) : null}
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
      {runningDeploys.length > 0 ? (
        <div className="fleet-deploy-strip" aria-label="Active Remote deploys">
          {runningDeploys.map((job) => {
            const hostLabel =
              hosts.find((host) => host.id === job.hostId)?.label ?? job.hostId;
            const selectedHere =
              selection?.kind === "station" &&
              selection.host.id === job.hostId;
            // Detail panel already shows full log for the selected host.
            if (selectedHere) return null;
            return (
              <button
                key={job.jobId}
                type="button"
                className="fleet-deploy-strip__item"
                onClick={() => setSelectedId(job.hostId)}
              >
                <span className="fleet-deploy-strip__host">{hostLabel}</span>
                <FleetDeployJobPanel job={job} compact />
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="fleet-body">
        <div className="fleet-map-wrap">
          <FleetMap
            hosts={hosts}
            peers={peers}
            probes={probes}
            ccHostId={ccHostId}
            selectedId={selectedId}
            onSelect={handleSelect}
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
          />
        ) : null}
      </div>
      {form ? <FleetHostForm initialLabel={form.label} initialEndpoint={form.endpoint} onClose={() => setForm(null)} /> : null}
      {boxFleetEnabled && boxPanelOpen ? (
        <FleetBoxPanel
          onClose={() => setBoxPanelOpen(false)}
          onFleetChanged={refreshFleet}
        />
      ) : null}
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
