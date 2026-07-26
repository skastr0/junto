import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Anchor,
  Aperture,
  Archive,
  Command,
  Cpu,
  DoorOpen,
  Factory,
  Laptop,
  Monitor,
  Radar,
  Satellite,
  Server,
  Smartphone,
  TimerReset,
  TowerControl,
  Vault,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import type { FleetProbeState } from "../../lib/fleet-state";
import { hostColor } from "../../lib/fleet-layout";
import {
  FLEET_MACHINE_ASSETS,
  FLEET_MACHINE_AVATARS,
} from "../../lib/fleet-machine-assets";
import {
  fleetMachineColor,
  fleetMachineLabel,
  resolveFleetMachineModel,
  resolvePeerMachineModel,
  type FleetMachineModelId,
} from "../../lib/fleet-machine-model";
import { HUE } from "../../lib/theme";
import { DitheredFleetObject } from "./DitheredFleetObject";

export const FLEET_MACHINE_ICONS: Readonly<Record<FleetMachineModelId, LucideIcon>> = {
  "command-core": Command,
  "compute-tower": Server,
  "relay-obelisk": Satellite,
  "terminal-dock": Laptop,
  "artifact-vault": Vault,
  "browser-lens": Aperture,
  "watch-beacon": TowerControl,
  "chrono-drum": TimerReset,
  "request-gate": DoorOpen,
  "task-foundry": Factory,
  "agent-prism": WandSparkles,
  "remote-anchor": Anchor,
  "mac-mini": Archive,
  "mac-studio": Cpu,
  "macbook-pro": Laptop,
};

export const fleetMachineIcon = (model: FleetMachineModelId): LucideIcon =>
  FLEET_MACHINE_ICONS[model];

// --- Mesh discovery geography -----------------------------------------------

export type DiscoveryBandNodeData = { readonly count: number };
export type DiscoveryBandFlowNode = Node<DiscoveryBandNodeData, "discoveryBand">;

export function DiscoveryBandNode({ data }: NodeProps<DiscoveryBandFlowNode>) {
  return (
    <div className="fleet-discovery-band" aria-hidden="true">
      <span>mesh discovery</span>
      <small>{data.count} visible · not enrolled</small>
    </div>
  );
}

// --- Command Center ----------------------------------------------------------

export type CommandCenterNodeData = {
  readonly hostId: string;
  readonly ditherPixelSize: number;
  readonly onSelect: () => void;
};
export type CommandCenterFlowNode = Node<CommandCenterNodeData, "commandCenter">;

export function CommandCenterNode({ data, selected }: NodeProps<CommandCenterFlowNode>) {
  return (
    <div
      className={`fleet-cc${selected ? " fleet-cc--selected" : ""}`}
      onPointerUp={(event) => {
        if (event.button === 0) data.onSelect();
      }}
    >
      <Handle type="source" position={Position.Right} className="fleet-handle" />
      <div className="fleet-machine fleet-machine--command">
        <div
          className="fleet-machine__viewport"
          style={{ "--fleet-machine-color": HUE.amber } as React.CSSProperties}
        >
          <DitheredFleetObject
            color={HUE.amber}
            ditherPixelSize={data.ditherPixelSize}
            focused={selected}
            label="Command Core"
            motionSeed={`command:${data.hostId}`}
            poster={FLEET_MACHINE_AVATARS["command-core"]}
            src={FLEET_MACHINE_ASSETS["command-core"]}
          />
          <span className="fleet-machine__reticle" aria-hidden="true" />
        </div>
        <div className="fleet-node__copy fleet-machine__copy">
          <div className="fleet-cc__label font-display">Command Center</div>
          <div className="fleet-node__meta">{data.hostId || "local"}</div>
          <div className="fleet-node__signal fleet-node__signal--authority">
            authorial core
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Remote station ----------------------------------------------------------

export type StationNodeData = {
  readonly host: RemoteHost;
  readonly probe?: FleetProbeState;
  readonly ditherPixelSize: number;
  readonly onSelect: () => void;
};
export type StationFlowNode = Node<StationNodeData, "station">;

const probePipClass = (probe?: FleetProbeState): string => {
  switch (probe?.status) {
    case "probing":
      return "fleet-pip fleet-pip--probing";
    case "reachable":
      return "fleet-pip fleet-pip--reachable";
    case "unreachable":
      return "fleet-pip fleet-pip--unreachable";
    default:
      return "fleet-pip fleet-pip--unknown";
  }
};

const probePipTitle = (probe?: FleetProbeState): string => {
  switch (probe?.status) {
    case "probing":
      return "probing link";
    case "reachable":
      return probe.latencyMs !== undefined ? `reachable · ${probe.latencyMs} ms` : "reachable";
    case "unreachable":
      return probe.detail ? `unreachable — ${probe.detail}` : "unreachable";
    default:
      return "link untested";
  }
};

const probeLabel = (probe?: FleetProbeState): string => {
  switch (probe?.status) {
    case "probing":
      return "checking route";
    case "reachable":
      return probe.latencyMs === undefined
        ? "reachable"
        : `reachable · ${probe.latencyMs} ms`;
    case "unreachable":
      return "unreachable";
    default:
      return "route untested";
  }
};

export function StationNode({ data, selected }: NodeProps<StationFlowNode>) {
  const { host, probe } = data;
  const model = resolveFleetMachineModel(host);
  const color = hostColor(host, fleetMachineColor(model));
  const modelLabel = fleetMachineLabel(model);
  return (
    <div
      className={`fleet-station fleet-station--${probe?.status ?? "unknown"}${
        selected ? " fleet-station--selected" : ""
      }`}
      onPointerUp={(event) => {
        if (event.button === 0) data.onSelect();
      }}
    >
      <Handle type="target" position={Position.Left} className="fleet-handle" />
      <div className="fleet-machine">
        <div
          className="fleet-machine__viewport"
          style={{ "--fleet-machine-color": color } as React.CSSProperties}
        >
          <DitheredFleetObject
            color={color}
            ditherPixelSize={data.ditherPixelSize}
            focused={selected}
            label={modelLabel}
            motionSeed={host.id}
            poster={FLEET_MACHINE_AVATARS[model]}
            src={FLEET_MACHINE_ASSETS[model]}
          />
          <span className="fleet-machine__reticle" aria-hidden="true" />
          <span className={probePipClass(probe)} title={probePipTitle(probe)} />
        </div>
        <div className="fleet-node__copy fleet-machine__copy">
          <div className="fleet-station__label">{host.label}</div>
          <div className="fleet-node__meta">{host.endpoint ?? host.kind}</div>
          <div className={`fleet-node__signal fleet-node__signal--${probe?.status ?? "unknown"}`}>
            {probeLabel(probe)}
          </div>
          <div className="fleet-node__capabilities" aria-label={`Capabilities: ${host.capabilities.join(", ")}`}>
            {host.capabilities.slice(0, 3).map((capability) => (
              <span key={capability}>{capability}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Unclaimed peer (detected on the mesh, not enrolled) ---------------------

export type GhostStationNodeData = {
  readonly peer: DiscoveredPeer;
  readonly ditherPixelSize: number;
  readonly onSelect: () => void;
};
export type GhostStationFlowNode = Node<GhostStationNodeData, "ghost">;

const PEER_OS_ICONS: Record<string, LucideIcon> = {
  ios: Smartphone,
  android: Smartphone,
  macos: Laptop,
  linux: Server,
  windows: Monitor,
};

/** OS-aware device icon for a discovered peer; Radar when the OS is unknown. */
export const peerOsIcon = (os?: string): LucideIcon =>
  (os ? PEER_OS_ICONS[os.trim().toLowerCase()] : undefined) ?? Radar;

export function GhostStationNode({ data, selected }: NodeProps<GhostStationFlowNode>) {
  const { peer } = data;
  const model = resolvePeerMachineModel(peer);
  const color = HUE.steel;
  return (
    <div
      className={`fleet-ghost${selected ? " fleet-ghost--selected" : ""}`}
      onPointerUp={(event) => {
        if (event.button === 0) data.onSelect();
      }}
    >
      <Handle type="target" position={Position.Left} className="fleet-handle" />
      <div className="fleet-machine fleet-machine--ghost">
        <div
          className="fleet-machine__viewport"
          style={{ "--fleet-machine-color": color } as React.CSSProperties}
        >
          <DitheredFleetObject
            amberMix={0}
            color={color}
            ditherPixelSize={data.ditherPixelSize}
            focused={selected}
            label={fleetMachineLabel(model)}
            motionSeed={`peer:${peer.name}`}
            poster={FLEET_MACHINE_AVATARS[model]}
            src={FLEET_MACHINE_ASSETS[model]}
          />
          <span className="fleet-machine__reticle" aria-hidden="true" />
          <span
            className={peer.online ? "fleet-pip fleet-pip--reachable" : "fleet-pip fleet-pip--unknown"}
            title={peer.online ? "online on the tailnet" : "offline"}
          />
        </div>
        <div className="fleet-node__copy fleet-machine__copy">
          <div className="fleet-station__label">{peer.name}</div>
          <div className="fleet-node__meta">{peer.os ?? "unknown device"}</div>
          <div className="fleet-node__signal fleet-node__signal--discovered">
            {peer.online ? "visible · not enrolled" : "offline · not enrolled"}
          </div>
        </div>
      </div>
    </div>
  );
}

export const fleetNodeTypes = {
  discoveryBand: DiscoveryBandNode,
  commandCenter: CommandCenterNode,
  station: StationNode,
  ghost: GhostStationNode,
};
