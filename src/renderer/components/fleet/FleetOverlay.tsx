import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Plus } from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import { closeFleet } from "../../lib/fleet-state";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import { FocusSurface } from "../FocusSurface";
import { Button, OverlayHeader } from "../ui";
import { FleetDetailPanel, type FleetSelection } from "./FleetDetailPanel";
import { FleetDiscovery } from "./FleetDiscovery";
import { FleetHostForm } from "./FleetHostForm";
import { COMMAND_CENTER_ID, FleetMap } from "./FleetMap";

type FormState = { readonly label?: string; readonly endpoint?: string } | null;

function FleetOverlayInner() {
  const hosts = use$(state$.fleetHosts);
  const peers = use$(state$.fleetPeers);
  const loading = use$(state$.fleetLoading);
  const probes = use$(state$.fleetProbe);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [ccHostId, setCcHostId] = useState("");

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
  const selection: FleetSelection | null =
    selectedId === COMMAND_CENTER_ID
      ? { kind: "cc" }
      : selectedHost
        ? { kind: "station", host: selectedHost }
        : null;

  const claimPeer = (peer: DiscoveredPeer) => {
    // MagicDNS name is the preferred endpoint — stable across tailnet IPs.
    setForm({ label: peer.name, endpoint: peer.name });
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
        status={`${hosts.filter((host) => host.kind === "remote").length} stations${loading ? " · refreshing…" : ""}`}
        actions={
          <Button size="sm" onClick={() => setForm({})}>
            <Plus size={12} />
            Add host
          </Button>
        }
      />
      <div className="fleet-body">
        <div className="fleet-map-wrap">
          <FleetMap
            hosts={hosts}
            probes={probes}
            ccHostId={ccHostId}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <FleetDiscovery peers={peers} loading={loading} onClaim={claimPeer} />
        </div>
        {selection ? (
          <FleetDetailPanel
            selection={selection}
            probe={selection.kind === "station" ? probes[selection.host.id] : undefined}
            ccHostId={ccHostId}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
      {form ? <FleetHostForm initialLabel={form.label} initialEndpoint={form.endpoint} onClose={() => setForm(null)} /> : null}
    </FocusSurface>
  );
}

/** Fleet manager overlay — gated on state$.fleetOpen like SettingsPanel. */
export function FleetOverlay() {
  const open = use$(state$.fleetOpen);
  if (!open) return null;
  return <FleetOverlayInner />;
}
