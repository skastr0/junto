import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Command,
  Cpu,
  Globe,
  Laptop,
  Monitor,
  Orbit,
  Radar,
  Rocket,
  Satellite,
  Server,
  Smartphone,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import type { FleetProbeState } from "../../lib/fleet-state";
import { hostColor } from "../../lib/fleet-layout";
import { HUE, withAlpha } from "../../lib/theme";

/** Lucide components for the FLEET_GLYPHS vocabulary (fleet-layout.ts). */
export const FLEET_GLYPH_ICONS: Record<string, LucideIcon> = {
  satellite: Satellite,
  rocket: Rocket,
  globe: Globe,
  star: Star,
  orbit: Orbit,
  radar: Radar,
  cpu: Cpu,
  server: Server,
  laptop: Laptop,
};

export const fleetGlyphIcon = (glyph?: string): LucideIcon =>
  (glyph ? FLEET_GLYPH_ICONS[glyph] : undefined) ?? Server;

// --- Command Center ----------------------------------------------------------

export type CommandCenterNodeData = { readonly hostId: string };
export type CommandCenterFlowNode = Node<CommandCenterNodeData, "commandCenter">;

export function CommandCenterNode({ data, selected }: NodeProps<CommandCenterFlowNode>) {
  return (
    <div className={`fleet-cc${selected ? " fleet-cc--selected" : ""}`}>
      <Handle type="source" position={Position.Right} className="fleet-handle" />
      <div className="fleet-node__plate" style={{ borderColor: withAlpha(HUE.amber, selected ? 0.8 : 0.28) }}>
        <div
          className="fleet-node__medallion fleet-node__medallion--cc"
          style={{ color: HUE.amber }}
        >
          <Command size={25} strokeWidth={1.55} />
        </div>
        <div className="fleet-node__copy">
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
  const color = hostColor(host);
  const Icon = fleetGlyphIcon(host.appearance?.glyph);
  return (
    <div className={`fleet-station${selected ? " fleet-station--selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="fleet-handle" />
      <div
        className="fleet-node__plate"
        style={{ borderColor: withAlpha(color, selected ? 0.82 : 0.28) }}
      >
        <div className="fleet-node__medallion" style={{ color, background: withAlpha(color, 0.08) }}>
          <Icon size={21} strokeWidth={1.55} />
          <span className={probePipClass(probe)} title={probePipTitle(probe)} />
        </div>
        <div className="fleet-node__copy">
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

export type GhostStationNodeData = { readonly peer: DiscoveredPeer };
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
  const Icon = peerOsIcon(peer.os);
  return (
    <div className={`fleet-ghost${selected ? " fleet-ghost--selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="fleet-handle" />
      <div className="fleet-node__plate fleet-ghost__plate">
        <div className="fleet-node__medallion fleet-ghost__medallion">
          <Icon size={20} strokeWidth={1.5} />
          <span
            className={peer.online ? "fleet-pip fleet-pip--reachable" : "fleet-pip fleet-pip--unknown"}
            title={peer.online ? "online on the tailnet" : "offline"}
          />
        </div>
        <div className="fleet-node__copy">
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
  commandCenter: CommandCenterNode,
  station: StationNode,
  ghost: GhostStationNode,
};
